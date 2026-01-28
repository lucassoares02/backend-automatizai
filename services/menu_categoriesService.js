const pool = require("../db");

/**
 * Get All MenuCategories
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM menu_categories ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM menu_categories WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  // espera um objeto com propriedades em camelCase (ex: { someField: 'x' })
  const { id, companyId, name, sortOrder, active } = data;
  const result = await pool.query(
    "INSERT INTO menu_categories (id, company_id, name, sort_order, active) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [id, companyId, name, sortOrder, active]
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

module.exports = { findAll, find, create, update, remove };
