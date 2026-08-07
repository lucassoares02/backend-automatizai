const pool = require("../db");
const identityService = require("./identityService");

const findAllWithStats = async (companyId, search = "", filter = "all") => {
  const searchParam = search.trim() ? `%${search.trim()}%` : "";

  let filterWhere = "";
  let orderBy = "COALESCE(os.total_orders, 0) DESC, c.name ASC";

  switch (filter) {
    case "recurring":  filterWhere = "AND COALESCE(os.total_orders, 0) > 1"; break;
    case "new":        filterWhere = "AND c.created_at >= NOW() - INTERVAL '30 days'"; break;
    case "inactive":   filterWhere = "AND (os.last_order_at IS NULL OR os.last_order_at < NOW() - INTERVAL '60 days')"; break;
    case "high_value": filterWhere = "AND COALESCE(os.total_orders, 0) > 0"; orderBy = "COALESCE(os.total_spent, 0) DESC"; break;
  }

  const query = `
    WITH order_stats AS (
      SELECT
        o.client_id,
        COUNT(o.id)::int                                                              AS total_orders,
        COALESCE(SUM(CASE WHEN o.status NOT IN (6,7) THEN o.total ELSE 0 END),0)::float  AS total_spent,
        COALESCE(AVG(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS avg_ticket,
        COALESCE(MAX(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS max_order,
        MAX(o.created_at)                                                              AS last_order_at,
        MIN(o.created_at)                                                              AS first_order_at,
        COUNT(CASE WHEN o.status IN (6,7) THEN 1 END)::int                             AS cancelled_orders
      FROM orders o
      WHERE o.company_id = $1
      GROUP BY o.client_id
    )
    SELECT
      c.*,
      COALESCE(os.total_orders, 0)::int     AS total_orders,
      COALESCE(os.total_spent, 0)::float    AS total_spent,
      COALESCE(os.avg_ticket, 0)::float     AS avg_ticket,
      COALESCE(os.max_order, 0)::float      AS max_order,
      os.last_order_at,
      os.first_order_at,
      COALESCE(os.cancelled_orders, 0)::int AS cancelled_orders
    FROM clients c
    LEFT JOIN order_stats os ON os.client_id = c.id
    WHERE c.company_id = $1
      AND ($2 = '' OR c.name ILIKE $2 OR c.phone ILIKE $2)
      ${filterWhere}
    ORDER BY ${orderBy}
    LIMIT 200
  `;
  const result = await pool.query(query, [companyId, searchParam]);
  return result.rows;
};

const getSummary = async (companyId) => {
  const result = await pool.query(`
    WITH client_stats AS (
      SELECT
        c.id,
        c.created_at                                                                           AS client_created_at,
        COUNT(o.id)::int                                                                       AS order_count,
        COALESCE(SUM(CASE WHEN o.status NOT IN (6,7) THEN o.total ELSE 0 END), 0)::float      AS total_spent,
        MAX(o.created_at)                                                                      AS last_order_at
      FROM clients c
      LEFT JOIN orders o ON o.client_id = c.id AND o.company_id = $1
      WHERE c.company_id = $1
      GROUP BY c.id
    )
    SELECT
      COUNT(*)::int                                                                        AS total_clients,
      COUNT(*) FILTER (WHERE last_order_at >= NOW() - INTERVAL '30 days')::int            AS active_clients,
      COUNT(*) FILTER (WHERE client_created_at >= date_trunc('month', CURRENT_DATE))::int AS new_this_month,
      COUNT(*) FILTER (WHERE order_count > 1)::int                                        AS recurring_clients,
      COALESCE(AVG(NULLIF(total_spent, 0)), 0)::float                                     AS avg_spent_per_client
    FROM client_stats
  `, [companyId]);
  return result.rows[0];
};

const getDetails = async (clientId) => {
  const result = await pool.query(`
    WITH client_stats AS (
      SELECT
        o.client_id,
        COUNT(o.id)::int                                                              AS total_orders,
        COALESCE(SUM(CASE WHEN o.status NOT IN (6,7) THEN o.total ELSE 0 END),0)::float  AS total_spent,
        COALESCE(AVG(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS avg_ticket,
        COALESCE(MAX(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS max_order,
        MAX(o.created_at)                                                              AS last_order_at,
        MIN(o.created_at)                                                              AS first_order_at,
        COUNT(CASE WHEN o.status IN (6,7) THEN 1 END)::int                             AS cancelled_orders
      FROM orders o
      WHERE o.client_id = $1
      GROUP BY o.client_id
    )
    SELECT
      c.*,
      COALESCE(cs.total_orders, 0)::int     AS total_orders,
      COALESCE(cs.total_spent, 0)::float    AS total_spent,
      COALESCE(cs.avg_ticket, 0)::float     AS avg_ticket,
      COALESCE(cs.max_order, 0)::float      AS max_order,
      cs.last_order_at,
      cs.first_order_at,
      COALESCE(cs.cancelled_orders, 0)::int AS cancelled_orders,
      COALESCE(json_agg(
        json_build_object(
          'id',         o.id,
          'status',     o.status,
          'total',      o.total::float,
          'notes',      o.notes,
          'created_at', o.created_at,
          'items', (
            SELECT COALESCE(json_agg(json_build_object(
              'id',         oi.id,
              'name',       oi.item_name,
              'quantity',   oi.quantity,
              'unit_price', oi.item_price::float,
              'subtotal',   oi.subtotal::float
            ) ORDER BY oi.id), '[]'::json)
            FROM order_items oi WHERE oi.order_id = o.id
          )
        ) ORDER BY o.created_at DESC
      ) FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS orders
    FROM clients c
    LEFT JOIN client_stats cs ON cs.client_id = c.id
    LEFT JOIN orders o ON o.client_id = c.id
    WHERE c.id = $1
    GROUP BY c.id, cs.total_orders, cs.total_spent, cs.avg_ticket, cs.max_order,
             cs.last_order_at, cs.first_order_at, cs.cancelled_orders
  `, [clientId]);
  return result.rows[0] || null;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM clients WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const { company_id, name, phone } = data;

  // Sem telefone não há como resolver identidade → client "solto" (user_id NULL).
  // A constraint parcial uq_client_company_user ignora user_id NULL, então é permitido.
  // Endereço NÃO mora mais em clients (removido na FASE E); vive em user_addresses.
  if (!phone) {
    const result = await pool.query(
      `INSERT INTO clients (company_id, name, phone, note)
       VALUES ($1, $2, NULL, $3) RETURNING *`,
      [company_id, name ?? "Cliente", data.note ?? null],
    );
    return result.rows[0];
  }

  // Resolve/cria a identidade global e o client (company_id, user_id) — o mesmo
  // ponto único usado pelo fluxo público. Se já existir client para essa
  // identidade na empresa, ele é REUTILIZADO (não duplica).
  const { client } = await identityService.resolveClientByPhone({
    companyId: Number(company_id),
    phone: String(phone),
    name: name ? String(name) : null,
  });

  // Aplica os demais campos informados pelo admin sobre o client resolvido.
  return await update({ id: client.id, ...data });
};

const update = async ({ id, name, phone, note }) => {
  // Endereço saiu de clients (FASE E) → só nome/telefone/nota aqui.
  const result = await pool.query(
    `UPDATE clients
     SET name = $2, phone = $3, note = $4, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, name, phone ?? null, note ?? null],
  );
  const row = result.rows[0];
  if (!row) return row;

  // Garante o vínculo de identidade quando há telefone. Só grava user_id se NÃO
  // colidir com a unique (company_id, user_id) — se outro client ativo da empresa
  // já tiver essa identidade, mantém como está (caso de borda do admin).
  if (phone) {
    try {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const { userId } = await identityService.resolveUserByPhone(db, String(phone), { name });
        await db.query(
          `UPDATE clients c
             SET user_id = $2
           WHERE c.id = $1
             AND c.user_id IS DISTINCT FROM $2
             AND NOT EXISTS (
               SELECT 1 FROM clients c2
               WHERE c2.company_id = c.company_id AND c2.user_id = $2
                 AND c2.id <> c.id AND c2.deactivated_at IS NULL
             )`,
          [id, userId],
        );
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      } finally {
        db.release();
      }
    } catch (e) {
      // Telefone inválido ou colisão: não bloqueia o update do cadastro.
      console.error("clients.update: falha ao vincular identidade:", e.message);
    }
    const fresh = await pool.query("SELECT * FROM clients WHERE id = $1", [id]);
    return fresh.rows[0] || row;
  }

  return row;
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM clients WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAllWithStats, getSummary, getDetails, find, create, update, remove };
