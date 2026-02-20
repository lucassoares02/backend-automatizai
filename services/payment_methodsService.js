const pool = require("../db");

/**
 * Get All PaymentMethods
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM payment_methods ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM payment_methods WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const findByCompany = async (id) => {
  const result = await pool.query("SELECT * FROM payment_methods WHERE company_id = $1", [id]);
  return result.rows || [];
};

const create = async (data) => {
  // espera um objeto com propriedades em camelCase (ex: { someField: 'x' })
  const { company_id, type, label, description, active } = data;
  const result = await pool.query(
    "INSERT INTO payment_methods (company_id, type, label, description, active) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [company_id, type, label, description, active],
  );
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, companyId, type, label, description, active, createdAt, updatedAt } = data;
  const result = await pool.query(
    "UPDATE payment_methods SET id = $1, company_id = $2, type = $3, label = $4, description = $5, active = $6, created_at = $7, updated_at = $8 WHERE id = $9 RETURNING *",
    [id, companyId, type, label, description, active, createdAt, updatedAt, id],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM payment_methods WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, findByCompany, create, update, remove };
