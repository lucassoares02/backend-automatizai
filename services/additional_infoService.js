const pool = require("../db");

/**
 * Get All AdditionalInfo
 */
const findAll = async (id) => {
  const result = await pool.query("SELECT * FROM additional_info WHERE company_id = $1 ORDER BY id", [id]);
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM additional_info WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const { company_id, title, content, category, trigger_keywords, visibility } = data;
  const result = await pool.query(
    "INSERT INTO additional_info (company_id, title, content, category, trigger_keywords, visibility) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
    [company_id, title, content, category, trigger_keywords, visibility],
  );
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, company_id, title, content, category, trigger_keywords, visibility, created_at, updated_at } = data;
  const result = await pool.query(
    "UPDATE additional_info SET id = $1, company_id = $2, title = $3, content = $4, category = $5, trigger_keywords = $6, visibility = $7, created_at = $8, updated_at = $9 WHERE id = $10 RETURNING *",
    [id, company_id, title, content, category, trigger_keywords, visibility, created_at, updated_at, id],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM additional_info WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove };
