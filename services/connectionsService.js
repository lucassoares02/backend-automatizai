const pool = require("../db");

/**
 * Get All Connections
 */
const findAll = async (company) => {
  const result = await pool.query(
    'SELECT id, company_id as "company", instance_name as "instanceName", instance_id as "description", status, hash FROM connections WHERE company_id = $1 ORDER BY id',
    [company],
  );
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM connections WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const { instanceName, instanceId, status, hash, company } = data;
  const result = await pool.query(
    "INSERT INTO connections (company_id, instance_name, instance_id, status, hash) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [company, instanceName, instanceId, status, hash],
  );
  return result.rows[0];
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, description } = data;
  const result = await pool.query("UPDATE connections SET id = $1, description = $2 WHERE id = $3 RETURNING *", [id, description, id]);
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM connections WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove };
