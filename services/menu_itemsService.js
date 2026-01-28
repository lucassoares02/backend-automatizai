const pool = require("../db");

/**
 * Get All MenuItems
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM menu_items ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM menu_items WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  // espera um objeto com propriedades em camelCase (ex: { someField: 'x' })
  const { id, companyId, categoryId, name, description, price, available } = data;
  const result = await pool.query(
    "INSERT INTO menu_items (id, company_id, category_id, name, description, price, available) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
    [id, companyId, categoryId, name, description, price, available]
  );
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, companyId, categoryId, name, description, price, available } = data;
  const result = await pool.query(
    "UPDATE menu_items SET id = $1, company_id = $2, category_id = $3, name = $4, description = $5, price = $6, available = $7 WHERE id = $8 RETURNING *",
    [id, companyId, categoryId, name, description, price, available, id]
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM menu_items WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove };
