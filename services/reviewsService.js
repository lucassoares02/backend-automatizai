const pool = require("../db");
const { normalizePhone } = require("../helpers/phone");

// Aceita o UUID público do pedido OU o id numérico (mesma regra do fluxo público).
const _ORDER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pedido concluído (elegível para avaliação): 5 = Entregue · 9 = Retirado.
const CONCLUDED_STATUSES = [5, 9];

const _normalizePhone = (phone) =>
  normalizePhone(phone) || String(phone || "").replace(/\D/g, "");

// Falta a tabela (migração ainda não rodou): o backend não deve quebrar. Cada
// leitura cai em vazio/zero e a escrita responde 503 amigável.
const _isMissingTable = (err) => err && err.code === "42P01";

const _mapReview = (row) => ({
  id: row.id,
  order_id: row.order_id,
  client_id: row.client_id,
  rating: Number(row.rating),
  comment: row.comment ?? null,
  response: row.response ?? null,
  responded_at: row.responded_at ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/**
 * Avaliação de um pedido específico (para embutir na resposta pública do pedido).
 * Retorna null quando não há avaliação ou quando a tabela ainda não existe.
 */
const getForOrder = async (orderId) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, order_id, client_id, rating, comment, response,
              responded_at, created_at, updated_at
         FROM order_reviews
        WHERE order_id = $1
        LIMIT 1`,
      [orderId],
    );
    return rows[0] ? _mapReview(rows[0]) : null;
  } catch (err) {
    if (_isMissingTable(err)) return null;
    throw err;
  }
};

/**
 * Envio da avaliação PELO CLIENTE (fluxo público). Reusa a regra de posse do
 * pedido do getPublicOrder: UUID dispensa telefone; id numérico exige telefone
 * correspondente. Só permite avaliar pedidos concluídos (Entregue/Retirado).
 * Uma avaliação por pedido — reenvio atualiza nota/mensagem sem tocar a resposta
 * do comerciante. Retorna { ok, code?, message?, review? }.
 */
const submitPublicReview = async ({ orderRef, phone, rating, comment }) => {
  const ratingInt = Number(rating);
  if (!Number.isInteger(ratingInt) || ratingInt < 1 || ratingInt > 5) {
    return { ok: false, code: 400, message: "A nota deve ser de 1 a 5 estrelas." };
  }

  const ref = String(orderRef || "").trim();
  if (!ref) return { ok: false, code: 400, message: "Pedido inválido." };
  const byUuid = _ORDER_UUID_RE.test(ref);
  const reqPhone = phone ? _normalizePhone(phone) : null;
  // Acesso por id numérico (enumerável) exige telefone; UUID (link) dispensa.
  if (!byUuid && !reqPhone) {
    return { ok: false, code: 403, message: "Pedido inválido." };
  }

  const orderRes = await pool.query(
    `SELECT o.id, o.company_id, o.client_id, o.status, c.phone AS client_phone
       FROM orders o
       JOIN clients c ON c.id = o.client_id
      WHERE ${byUuid ? "o.uuid = $1" : "o.id = $1"}
      LIMIT 1`,
    [ref],
  );
  const order = orderRes.rows[0];
  if (!order) return { ok: false, code: 404, message: "Pedido não encontrado." };

  if (reqPhone && _normalizePhone(order.client_phone) !== reqPhone) {
    return { ok: false, code: 404, message: "Pedido não encontrado." };
  }

  if (!CONCLUDED_STATUSES.includes(Number(order.status))) {
    return {
      ok: false,
      code: 409,
      message: "Você poderá avaliar quando o pedido for concluído.",
    };
  }

  const cleanComment =
    comment != null && String(comment).trim() !== ""
      ? String(comment).trim().slice(0, 1000)
      : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO order_reviews
         (company_id, order_id, client_id, rating, comment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (order_id)
       DO UPDATE SET rating = EXCLUDED.rating,
                     comment = EXCLUDED.comment,
                     updated_at = NOW()
       RETURNING id, order_id, client_id, rating, comment, response,
                 responded_at, created_at, updated_at`,
      [order.company_id, order.id, order.client_id, ratingInt, cleanComment],
    );
    return { ok: true, review: _mapReview(rows[0]) };
  } catch (err) {
    if (_isMissingTable(err)) {
      return {
        ok: false,
        code: 503,
        message: "Avaliações indisponíveis no momento.",
      };
    }
    throw err;
  }
};

/**
 * Lista as avaliações de uma empresa (com o código do pedido e o cliente que
 * avaliou). Tolerante à ausência da tabela.
 */
const findByCompany = async (companyId) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.order_id, r.client_id, r.rating, r.comment, r.response,
              r.responded_at, r.created_at, r.updated_at,
              o.tag AS order_tag, o.total::float AS order_total,
              c.name AS client_name, c.phone AS client_phone
         FROM order_reviews r
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN clients c ON c.id = r.client_id
        WHERE r.company_id = $1
        ORDER BY r.created_at DESC`,
      [companyId],
    );
    return rows.map((row) => ({
      ...(_mapReview(row)),
      order_tag: row.order_tag ?? null,
      order_total: row.order_total ?? null,
      client_name: row.client_name ?? null,
      client_phone: row.client_phone ?? null,
    }));
  } catch (err) {
    if (_isMissingTable(err)) return [];
    throw err;
  }
};

/**
 * Resumo das avaliações de uma empresa: total, média e maior/menor nota, além da
 * distribuição por estrela. Tolerante à ausência da tabela.
 */
const getSummary = async (companyId) => {
  const empty = {
    count: 0,
    average: 0,
    highest: 0,
    lowest: 0,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int                         AS count,
         COALESCE(AVG(rating), 0)::float       AS average,
         COALESCE(MAX(rating), 0)::int         AS highest,
         COALESCE(MIN(rating), 0)::int         AS lowest,
         COUNT(*) FILTER (WHERE rating = 1)::int AS r1,
         COUNT(*) FILTER (WHERE rating = 2)::int AS r2,
         COUNT(*) FILTER (WHERE rating = 3)::int AS r3,
         COUNT(*) FILTER (WHERE rating = 4)::int AS r4,
         COUNT(*) FILTER (WHERE rating = 5)::int AS r5
       FROM order_reviews
       WHERE company_id = $1`,
      [companyId],
    );
    const row = rows[0];
    if (!row || Number(row.count) === 0) return empty;
    return {
      count: Number(row.count),
      average: Number(row.average),
      highest: Number(row.highest),
      lowest: Number(row.lowest),
      distribution: {
        1: Number(row.r1),
        2: Number(row.r2),
        3: Number(row.r3),
        4: Number(row.r4),
        5: Number(row.r5),
      },
    };
  } catch (err) {
    if (_isMissingTable(err)) return empty;
    throw err;
  }
};

/**
 * Resposta do comerciante a uma avaliação. Retorna a linha atualizada ou null se
 * a avaliação não existir. `authorizeReview` já garante a posse (empresa).
 */
const respond = async (reviewId, response) => {
  const clean =
    response != null && String(response).trim() !== ""
      ? String(response).trim().slice(0, 1000)
      : null;
  try {
    const { rows } = await pool.query(
      `UPDATE order_reviews
          SET response = $2::text,
              responded_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, order_id, client_id, rating, comment, response,
                  responded_at, created_at, updated_at`,
      [reviewId, clean],
    );
    return rows[0] ? _mapReview(rows[0]) : null;
  } catch (err) {
    // Migração ainda não rodou: escrita responde 503 amigável (em vez de 500 cru).
    if (_isMissingTable(err)) {
      throw Object.assign(
        new Error(
          "As avaliações ainda não foram habilitadas neste ambiente. Rode a migração de order_reviews (ver DB_CHANGES_NEEDED.md).",
        ),
        { status: 503 },
      );
    }
    throw err;
  }
};

/**
 * Avaliações feitas por um cliente (para o detalhe do cliente no painel).
 * Tolerante à ausência da tabela.
 */
const findByClient = async (clientId) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.order_id, r.client_id, r.rating, r.comment, r.response,
              r.responded_at, r.created_at, r.updated_at,
              o.tag AS order_tag
         FROM order_reviews r
         JOIN orders o ON o.id = r.order_id
        WHERE r.client_id = $1
        ORDER BY r.created_at DESC`,
      [clientId],
    );
    return rows.map((row) => ({
      ...(_mapReview(row)),
      order_tag: row.order_tag ?? null,
    }));
  } catch (err) {
    if (_isMissingTable(err)) return [];
    throw err;
  }
};

module.exports = {
  CONCLUDED_STATUSES,
  getForOrder,
  submitPublicReview,
  findByCompany,
  getSummary,
  respond,
  findByClient,
};
