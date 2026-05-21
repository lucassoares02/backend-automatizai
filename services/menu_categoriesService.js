const pool = require("../db");

/**
 * Get All MenuCategories
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM menu_categories ORDER BY company_id, sort_order NULLS LAST, id");
  return result.rows;
};

const findByCompany = async (companyId) => {
  const result = await pool.query(
    `SELECT * FROM menu_categories
     WHERE company_id = $1 AND COALESCE(active, true) = true
     ORDER BY sort_order NULLS LAST, id`,
    [companyId],
  );
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM menu_categories WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const companyId = data.companyId ?? data.company_id ?? null;
  const sortOrder = data.sortOrder ?? data.sort_order ?? null;
  const active = data.active ?? true;
  const name = (data.name ?? '').trim();
  if (!companyId) {
    const err = new Error('company_id é obrigatório');
    err.statusCode = 400;
    throw err;
  }
  if (!name) {
    const err = new Error('name é obrigatório');
    err.statusCode = 400;
    throw err;
  }
  // Reutilizar categoria existente com mesmo nome (case-insensitive) na empresa
  const existing = await pool.query(
    `SELECT * FROM menu_categories
     WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER($2)
     LIMIT 1`,
    [companyId, name],
  );
  if (existing.rows[0]) return existing.rows[0];
  const result = await pool.query(
    `INSERT INTO menu_categories (company_id, name, sort_order, active)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, name, sortOrder, active],
  );
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, companyId, name, sortOrder, active } = data;
  const result = await pool.query(
    "UPDATE menu_categories SET id = $1, company_id = $2, name = $3, sort_order = $4, active = $5 WHERE id = $6 RETURNING *",
    [id, companyId, name, sortOrder, active, id]
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM menu_categories WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, findByCompany, find, create, update, remove };
