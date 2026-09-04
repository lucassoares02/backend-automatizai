const pool = require("../db");
const { tableExists, columnExists } = require("../helpers/schema");

// A tabela `coupons` é criada manualmente (ver DB_CHANGES_NEEDED.md). Enquanto
// não existir, as operações degradam de forma segura em vez de quebrar.
const couponsAvailable = () => tableExists("coupons");

const round2 = (n) => Number(Number(n || 0).toFixed(2));

const _normalizeCode = (code) => String(code ?? "").trim();

const _normalizeType = (t) => (t === "fixed" ? "fixed" : "percent");

const _normalizeScope = (s) => (s === "total" ? "total" : "subtotal");

// Normaliza um array de ids (aceita array ou vazio) → int[] ou null.
const _toIntArray = (v) => {
  if (!Array.isArray(v)) return null;
  const arr = v
    .map((x) => Math.trunc(Number(x)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return arr.length ? Array.from(new Set(arr)) : null;
};

// Monta o payload saneado para INSERT/UPDATE.
const _sanitize = (data) => {
  const type = _normalizeType(data.discount_type);
  const value = Math.max(0, Number(data.discount_value ?? 0));
  const toNum = (v) =>
    v === null || v === undefined || v === "" ? null : Number(v);
  const toInt = (v) =>
    v === null || v === undefined || v === "" ? null : Math.trunc(Number(v));
  const toTs = (v) => (v ? new Date(v) : null);
  return {
    code: _normalizeCode(data.code),
    description: data.description ? String(data.description).trim() : null,
    discount_type: type,
    discount_value: round2(value),
    applies_to: _normalizeScope(data.applies_to),
    min_order_value: toNum(data.min_order_value),
    max_discount_value: type === "percent" ? toNum(data.max_discount_value) : null,
    max_uses: toInt(data.max_uses),
    category_ids: _toIntArray(data.category_ids),
    menu_item_ids: _toIntArray(data.menu_item_ids),
    client_id: toInt(data.client_id),
    starts_at: toTs(data.starts_at),
    expires_at: toTs(data.expires_at),
    active: data.active === undefined ? true : Boolean(data.active),
  };
};

// Colunas estendidas existem? (proxy: applies_to). Permite tolerar bancos que
// só têm o schema básico de cupons.
const _extendedSchema = () => columnExists("coupons", "applies_to");

const findByCompany = async (companyId) => {
  if (!(await couponsAvailable())) return [];
  // client_name só existe quando o schema estendido (client_id) está aplicado.
  const hasClient = await columnExists("coupons", "client_id");
  const sql = hasClient
    ? `SELECT c.*, cl.name AS client_name, cl.phone AS client_phone
         FROM coupons c LEFT JOIN clients cl ON cl.id = c.client_id
        WHERE c.company_id = $1 ORDER BY c.active DESC, c.created_at DESC`
    : `SELECT * FROM coupons WHERE company_id = $1 ORDER BY active DESC, created_at DESC`;
  const { rows } = await pool.query(sql, [companyId]);
  return rows;
};

const create = async (data) => {
  if (!(await couponsAvailable())) {
    const e = new Error("Recurso de cupons indisponível. Rode a migration.");
    e.status = 503;
    throw e;
  }
  const s = _sanitize(data);
  if (!s.code) {
    const e = new Error("Código do cupom é obrigatório.");
    e.status = 400;
    throw e;
  }
  if (s.discount_value <= 0) {
    const e = new Error("Valor do desconto deve ser maior que zero.");
    e.status = 400;
    throw e;
  }
  const cols = [
    "company_id",
    "code",
    "description",
    "discount_type",
    "discount_value",
    "min_order_value",
    "max_discount_value",
    "max_uses",
    "starts_at",
    "expires_at",
    "active",
  ];
  const vals = [
    data.company_id,
    s.code,
    s.description,
    s.discount_type,
    s.discount_value,
    s.min_order_value,
    s.max_discount_value,
    s.max_uses,
    s.starts_at,
    s.expires_at,
    s.active,
  ];
  if (await _extendedSchema()) {
    cols.push("applies_to", "category_ids", "menu_item_ids", "client_id");
    vals.push(s.applies_to, s.category_ids, s.menu_item_ids, s.client_id);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(",");
  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      vals,
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("Já existe um cupom com esse código.");
      e.status = 409;
      throw e;
    }
    throw err;
  }
};

const update = async (id, data) => {
  if (!(await couponsAvailable())) return null;
  const s = _sanitize(data);
  const sets = [
    ["code", s.code],
    ["description", s.description],
    ["discount_type", s.discount_type],
    ["discount_value", s.discount_value],
    ["min_order_value", s.min_order_value],
    ["max_discount_value", s.max_discount_value],
    ["max_uses", s.max_uses],
    ["starts_at", s.starts_at],
    ["expires_at", s.expires_at],
    ["active", s.active],
  ];
  if (await _extendedSchema()) {
    sets.push(
      ["applies_to", s.applies_to],
      ["category_ids", s.category_ids],
      ["menu_item_ids", s.menu_item_ids],
      ["client_id", s.client_id],
    );
  }
  const vals = sets.map(([, v]) => v);
  const setSql = sets.map(([c], i) => `${c} = $${i + 1}`).join(", ");
  vals.push(id, data.company_id);
  try {
    const { rows } = await pool.query(
      `UPDATE coupons SET ${setSql}, updated_at = now()
         WHERE id = $${vals.length - 1} AND company_id = $${vals.length}
       RETURNING *`,
      vals,
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("Já existe um cupom com esse código.");
      e.status = 409;
      throw e;
    }
    throw err;
  }
};

const toggleStatus = async (id, companyId, active) => {
  if (!(await couponsAvailable())) return null;
  const { rows } = await pool.query(
    `UPDATE coupons SET active = $1, updated_at = now()
       WHERE id = $2 AND company_id = $3 RETURNING *`,
    [active, id, companyId],
  );
  return rows[0] || null;
};

const remove = async (id) => {
  if (!(await couponsAvailable())) return null;
  const { rows } = await pool.query(
    `DELETE FROM coupons WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] || null;
};

const _hasRestriction = (coupon) =>
  (Array.isArray(coupon.category_ids) && coupon.category_ids.length > 0) ||
  (Array.isArray(coupon.menu_item_ids) && coupon.menu_item_ids.length > 0);

// Soma o subtotal dos itens do carrinho elegíveis à restrição do cupom
// (por produto e/ou por categoria). `items` = [{ menu_item_id, subtotal }].
const _eligibleSubtotal = async (runner, coupon, items) => {
  const list = Array.isArray(items) ? items : [];
  const catIds = Array.isArray(coupon.category_ids) ? coupon.category_ids : [];
  const itemIds = Array.isArray(coupon.menu_item_ids) ? coupon.menu_item_ids : [];

  // Mapa menu_item_id -> category_id (só quando a restrição por categoria exige).
  let categoryOf = new Map();
  if (catIds.length) {
    const ids = list
      .map((i) => Math.trunc(Number(i.menu_item_id)))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length) {
      const { rows } = await runner.query(
        `SELECT id, category_id FROM menu_items WHERE id = ANY($1::int[])`,
        [ids],
      );
      categoryOf = new Map(rows.map((r) => [Number(r.id), r.category_id]));
    }
  }

  let sum = 0;
  for (const it of list) {
    const mid = Math.trunc(Number(it.menu_item_id));
    const byItem = itemIds.length && itemIds.includes(mid);
    const byCat = catIds.length && catIds.includes(Number(categoryOf.get(mid)));
    if (byItem || byCat) sum += Number(it.subtotal || 0);
  }
  return round2(sum);
};

// Calcula o valor do desconto. `ctx` = { subtotal, deliveryFee, base }.
//   base = valor sobre o qual o desconto incide (subtotal elegível, subtotal
//   inteiro ou total com entrega). O desconto nunca deixa o pedido negativo.
const computeDiscount = (coupon, ctx) => {
  const base = Number(ctx.base ?? ctx.subtotal ?? 0);
  const orderCap = Number(ctx.subtotal ?? 0) + Number(ctx.deliveryFee ?? 0);
  let discount = 0;
  if (coupon.discount_type === "fixed") {
    discount = Number(coupon.discount_value);
  } else {
    discount = (base * Number(coupon.discount_value)) / 100;
    const cap = coupon.max_discount_value;
    if (cap !== null && cap !== undefined) discount = Math.min(discount, Number(cap));
  }
  // Não passa da base descontável nem do total do pedido.
  return round2(Math.max(0, Math.min(discount, base, orderCap || base)));
};

// Regras de validade/segmentação. Retorna { ok, message }.
const _checkRules = (coupon, { subtotal, clientId }) => {
  if (!coupon) return { ok: false, message: "Cupom não encontrado." };
  if (!coupon.active) return { ok: false, message: "Cupom inativo." };
  const now = Date.now();
  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) {
    return { ok: false, message: "Cupom ainda não está válido." };
  }
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() < now) {
    return { ok: false, message: "Cupom expirado." };
  }
  if (
    coupon.max_uses !== null &&
    coupon.max_uses !== undefined &&
    Number(coupon.used_count) >= Number(coupon.max_uses)
  ) {
    return { ok: false, message: "Cupom atingiu o limite de usos." };
  }
  // Cupom pessoal (ex.: aniversário): só o cliente vinculado pode usar.
  if (coupon.client_id !== null && coupon.client_id !== undefined) {
    if (!clientId || Number(clientId) !== Number(coupon.client_id)) {
      return { ok: false, message: "Cupom válido apenas para o cliente vinculado." };
    }
  }
  if (
    coupon.min_order_value !== null &&
    coupon.min_order_value !== undefined &&
    Number(subtotal || 0) < Number(coupon.min_order_value)
  ) {
    return {
      ok: false,
      message: `Pedido mínimo de R$ ${Number(coupon.min_order_value).toFixed(2)} para este cupom.`,
    };
  }
  return { ok: true };
};

const _findByCode = async (companyId, code, runner = pool) => {
  const { rows } = await runner.query(
    `SELECT * FROM coupons WHERE company_id = $1 AND upper(code) = upper($2) LIMIT 1`,
    [companyId, _normalizeCode(code)],
  );
  return rows[0] || null;
};

// Resolve a base de cálculo do desconto conforme escopo/restrições do cupom.
const _resolveBase = async (runner, coupon, { subtotal, deliveryFee, items }) => {
  if (_hasRestriction(coupon)) {
    return _eligibleSubtotal(runner, coupon, items);
  }
  if (coupon.applies_to === "total") {
    return round2(Number(subtotal || 0) + Number(deliveryFee || 0));
  }
  return round2(Number(subtotal || 0));
};

// Validação pública (não incrementa uso). Retorna um objeto amigável para o app.
const validate = async ({ companyId, code, clientId, subtotal, deliveryFee, items }) => {
  if (!(await couponsAvailable())) {
    return { valid: false, message: "Cupons indisponíveis." };
  }
  const normalized = _normalizeCode(code);
  if (!normalized) return { valid: false, message: "Informe o código do cupom." };
  const coupon = await _findByCode(companyId, normalized);
  const rules = _checkRules(coupon, { subtotal, clientId });
  if (!rules.ok) return { valid: false, message: rules.message };
  const base = await _resolveBase(pool, coupon, { subtotal, deliveryFee, items });
  if (_hasRestriction(coupon) && base <= 0) {
    return {
      valid: false,
      message: "Nenhum item do pedido é elegível para este cupom.",
    };
  }
  const discount = computeDiscount(coupon, { subtotal, deliveryFee, base });
  if (discount <= 0) {
    return { valid: false, message: "Cupom não gera desconto para este pedido." };
  }
  return {
    valid: true,
    code: coupon.code,
    description: coupon.description,
    discount_type: coupon.discount_type,
    discount_value: Number(coupon.discount_value),
    applies_to: coupon.applies_to || "subtotal",
    discount_amount: discount,
    message: "Cupom aplicado!",
  };
};

// Resgate transacional durante a criação do pedido: revalida e incrementa o uso
// de forma atômica. `client` deve estar dentro de uma transação em andamento.
// Retorna { coupon_id, discount } ou lança erro (status 400) se inválido.
const redeemForOrder = async (
  client,
  { companyId, code, clientId, subtotal, deliveryFee, items },
) => {
  if (!(await couponsAvailable())) return { coupon_id: null, discount: 0 };
  const coupon = await _findByCode(companyId, code, client);
  const rules = _checkRules(coupon, { subtotal, clientId });
  if (!rules.ok) {
    const e = new Error(rules.message);
    e.status = 400;
    throw e;
  }
  const base = await _resolveBase(client, coupon, { subtotal, deliveryFee, items });
  const discount = computeDiscount(coupon, { subtotal, deliveryFee, base });
  if (discount <= 0) {
    const e = new Error("Cupom não gera desconto para este pedido.");
    e.status = 400;
    throw e;
  }
  const upd = await client.query(
    `UPDATE coupons SET used_count = used_count + 1, updated_at = now()
       WHERE id = $1 AND active = true
         AND (max_uses IS NULL OR used_count < max_uses)
         AND (starts_at IS NULL OR starts_at <= now())
         AND (expires_at IS NULL OR expires_at >= now())
       RETURNING id`,
    [coupon.id],
  );
  if (upd.rowCount === 0) {
    const e = new Error("Cupom não está mais válido.");
    e.status = 400;
    throw e;
  }
  return { coupon_id: coupon.id, discount };
};

// Registra o resgate no histórico (best-effort — não quebra o pedido se a
// tabela ainda não existir).
const recordRedemption = async (client, { couponId, orderId, clientId, discount }) => {
  if (!couponId) return;
  if (!(await tableExists("coupon_redemptions"))) return;
  try {
    await client.query(
      `INSERT INTO coupon_redemptions (coupon_id, order_id, client_id, discount_amount)
       VALUES ($1, $2, $3, $4)`,
      [couponId, orderId ?? null, clientId ?? null, round2(discount ?? 0)],
    );
  } catch (err) {
    console.error("coupon recordRedemption:", err.message);
  }
};

// Histórico de uso de um cupom (com nome/telefone do cliente quando houver).
const redemptions = async (couponId) => {
  if (!(await tableExists("coupon_redemptions"))) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.order_id, r.client_id, r.discount_amount, r.created_at,
            c.name AS client_name, c.phone AS client_phone, o.tag AS order_tag
       FROM coupon_redemptions r
       LEFT JOIN clients c ON c.id = r.client_id
       LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.coupon_id = $1
      ORDER BY r.created_at DESC
      LIMIT 500`,
    [couponId],
  );
  return rows;
};

module.exports = {
  findByCompany,
  create,
  update,
  toggleStatus,
  remove,
  validate,
  redeemForOrder,
  recordRedemption,
  redemptions,
  computeDiscount,
};
