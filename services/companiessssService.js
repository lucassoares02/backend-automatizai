const pool = require("../db");

/**
 * Get All companies
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM companies ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM companies WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  // espera um objeto com propriedades em camelCase (ex: { someField: 'x' })
  const { id, name, description, status, phone } = data;
  const result = await pool.query("INSERT INTO companies (id, name, description, status, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *", [
    id,
    name,
    description,
    status,
    phone,
  ]);
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, name, description, status, phone } = data;
  const result = await pool.query("UPDATE companies SET id = $1, name = $2, description = $3, status = $4, phone = $5 WHERE id = $6 RETURNING *", [
    id,
    name,
    description,
    status,
    phone,
    id,
  ]);
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM companies WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove };
