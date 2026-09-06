const pool = require("../db");
const { columnExists } = require("../helpers/schema");

// Normaliza a lista de selos (restrições alimentares) do produto: só strings,
// trim, sem vazios nem duplicatas (case-insensitive). Retorna null quando vazia
// — mesma regra usada em companiessssService para companies.dietary_restrictions.
const normalizeDietaryRestrictions = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.length ? result : null;
};

const _hasStockColumns = async () => {
  const [unlimited, quantity, threshold] = await Promise.all([
    columnExists("menu_items", "stock_unlimited"),
    columnExists("menu_items", "stock_quantity"),
    columnExists("menu_items", "low_stock_threshold"),
  ]);
  return unlimited && quantity && threshold;
};

const _hasStockPayload = (data) =>
  Object.prototype.hasOwnProperty.call(data, "stock_unlimited") ||
  Object.prototype.hasOwnProperty.call(data, "stock_quantity") ||
  Object.prototype.hasOwnProperty.call(data, "low_stock_threshold");

const normalizeStock = ({ stock_unlimited, stock_quantity, low_stock_threshold }) => {
  const unlimited = stock_unlimited !== false;
  if (unlimited) {
    return {
      stockUnlimited: true,
      stockQuantity: null,
      lowStockThreshold: null,
    };
  }

  const quantity = Number(stock_quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 2147483647) {
    throw Object.assign(
      new Error("Informe uma quantidade de estoque inteira e igual ou maior que zero."),
      { status: 400 },
    );
  }

  let threshold = null;
  if (low_stock_threshold !== null && low_stock_threshold !== undefined && low_stock_threshold !== "") {
    threshold = Number(low_stock_threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 2147483647) {
      throw Object.assign(
        new Error("O alerta de últimas unidades deve ser um número inteiro maior que zero."),
        { status: 400 },
      );
    }
  }

  return {
    stockUnlimited: false,
    stockQuantity: quantity,
    lowStockThreshold: threshold,
  };
};

const findAll = async () => {
  // Exclui produtos removidos logicamente (soft delete).
  const result = await pool.query("SELECT * FROM menu_items WHERE deleted_at IS NULL ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM menu_items WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const findByCompany = async (id) => {
  const result = await pool.query(
    `SELECT mi.*, mc.name AS category_name
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.company_id = $1 AND mi.deleted_at IS NULL
     ORDER BY
       CASE
         WHEN mi.available = false THEN 2
         WHEN mi.featured = true THEN 0
         ELSE 1
       END,
       COALESCE(mi.display_order, mi.id) DESC`,
    [id],
  );
  return result.rows || null;
};

const create = async (data) => {
  const { company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku, dietary_restrictions } = data;
  // Só grava os selos se a coluna já existir (migration em DB_CHANGES_NEEDED.md).
  const [hasSelos, hasStock] = await Promise.all([
    columnExists("menu_items", "dietary_restrictions"),
    _hasStockColumns(),
  ]);
  const cols = ["company_id", "category_id", "name", "description", "price", "available", "image_url", "featured", "display_order", "prep_time_minutes", "sku"];
  const vals = [company_id, category_id, name, description, price, available, image_url ?? null, featured ?? false, display_order ?? null, prep_time_minutes ?? null, sku ?? null];
  if (hasSelos) {
    cols.push("dietary_restrictions");
    vals.push(normalizeDietaryRestrictions(dietary_restrictions));
  }
  if (hasStock) {
    const stock = normalizeStock(data);
    cols.push("stock_unlimited", "stock_quantity", "low_stock_threshold");
    vals.push(stock.stockUnlimited, stock.stockQuantity, stock.lowStockThreshold);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `INSERT INTO menu_items (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return result.rows[0];
};

const update = async (data) => {
  const { id, company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku, dietary_restrictions } = data;
  const [hasSelos, hasStock] = await Promise.all([
    columnExists("menu_items", "dietary_restrictions"),
    _hasStockColumns(),
  ]);
  const sets = ["company_id = $2", "category_id = $3", "name = $4", "description = $5", "price = $6", "available = $7", "image_url = $8", "featured = $9", "display_order = $10", "prep_time_minutes = $11", "sku = $12"];
  const vals = [id, company_id, category_id, name, description, price, available, image_url ?? null, featured ?? false, display_order ?? null, prep_time_minutes ?? null, sku ?? null];
  if (hasSelos) {
    sets.push(`dietary_restrictions = $${vals.length + 1}`);
    vals.push(normalizeDietaryRestrictions(dietary_restrictions));
  }
  // Clientes antigos ainda podem enviar o modelo sem estes campos. Nesse caso,
  // preservamos o estoque já configurado em vez de convertê-lo em ilimitado.
  if (hasStock && _hasStockPayload(data)) {
    const stock = normalizeStock(data);
    sets.push(`stock_unlimited = $${vals.length + 1}`);
    vals.push(stock.stockUnlimited);
    sets.push(`stock_quantity = $${vals.length + 1}`);
    vals.push(stock.stockQuantity);
    sets.push(`low_stock_threshold = $${vals.length + 1}`);
    vals.push(stock.lowStockThreshold);
  }
  const result = await pool.query(
    `UPDATE menu_items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    vals,
  );
  return result.rows[0];
};

const remove = async (id) => {
  // Soft delete: o produto pode ter pedidos (FK em order_items), então não pode
  // ser apagado. Marca deleted_at — some do catálogo e do cardápio, mas continua
  // disponível para histórico/relatórios. Idempotente (só marca se ainda ativo).
  const result = await pool.query(
    "UPDATE menu_items SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *",
    [id],
  );
  return result.rows[0];
};

module.exports = { findAll, find, findByCompany, create, update, remove };
