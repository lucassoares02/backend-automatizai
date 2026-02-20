const pool = require("../db");

/**
 * Get All CompanyOpeningHours
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM company_opening_hours ORDER BY id");
  return result.rows;
};

/**
 * Get All CompanyOpeningHours
 */
const findByCompany = async (id) => {
  const result = await pool.query("SELECT * FROM company_opening_hours WHERE company_id = $1 ORDER BY id", [id]);
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM company_opening_hours WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  // espera um objeto com propriedades em camelCase (ex: { someField: 'x' })
  const { company_id, weekday, opens_at, closes_at, is_closed } = data;
  const result = await pool.query(
    "INSERT INTO company_opening_hours (company_id, weekday, opens_at, closes_at, is_closed) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [company_id, weekday, opens_at, closes_at, is_closed],
  );
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, companyId, weekday, opensAt, closesAt, isClosed } = data;
  const result = await pool.query(
    "UPDATE company_opening_hours SET id = $1, company_id = $2, weekday = $3, opens_at = $4, closes_at = $5, is_closed = $6 WHERE id = $7 RETURNING *",
    [id, companyId, weekday, opensAt, closesAt, isClosed, id],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM company_opening_hours WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, findByCompany, find, create, update, remove };
