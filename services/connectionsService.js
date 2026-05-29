const pool = require("../db");

const findAll = async (company) => {
  const result = await pool.query(
    `SELECT id,
            company_id    AS "company",
            instance_name AS "instanceName",
            instance_id   AS "instanceId",
            description,
            integration,
            status,
            hash,
            created_at    AS "createdAt"
     FROM connections
     WHERE company_id = $1
     ORDER BY id`,
    [company],
  );
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM connections WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const find_by_instance = async (instanceName) => {
  const result = await pool.query("SELECT * FROM connections WHERE instance_name = $1 LIMIT 1", [instanceName]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const { instanceName, instanceId, status, hash, company, integration, description } = data;
  const result = await pool.query(
    `INSERT INTO connections (company_id, instance_name, instance_id, integration, description, status, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [company, instanceName, instanceId, integration ?? null, description ?? null, status, hash],
  );
  return result.rows[0];
};

const update = async (data) => {
  const { id, instanceName, status, description } = data;
  const result = await pool.query(
    `UPDATE connections
     SET instance_name = COALESCE($2, instance_name),
         status        = COALESCE($3, status),
         description   = COALESCE($4, description)
     WHERE id = $1
     RETURNING *`,
    [id, instanceName ?? null, status ?? null, description ?? null],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM connections WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

const updateStatusByInstance = async (instanceName, status) => {
  await pool.query(
    `UPDATE connections SET status = $1 WHERE instance_name = $2`,
    [status, instanceName],
  );
};

const getStatusByInstance = async (instanceName) => {
  const result = await pool.query(
    `SELECT status FROM connections WHERE instance_name = $1 LIMIT 1`,
    [instanceName],
  );
  return result.rows[0]?.status ?? null;
};

const findActive = async () => {
  const result = await pool.query(
    `SELECT id, instance_name, status, company_id
     FROM connections
     WHERE status IS NOT NULL
       AND status NOT IN ('disconnected', 'error')`,
  );
  return result.rows;
};

module.exports = { findAll, find, find_by_instance, create, update, remove, updateStatusByInstance, getStatusByInstance, findActive };
