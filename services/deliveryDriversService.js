const pool = require("../db");

// ─── Motoboys (delivery_drivers) ─────────────────────────────────────────────
// CRUD escopado por company_id. Estrutura preparada para rastreamento em tempo
// real futuro (basta adicionar last_lat/last_lng/last_seen_at na tabela).

const findByCompany = async (companyId, { onlyActive = false } = {}) => {
  const activeFilter = onlyActive ? "AND is_active = TRUE" : "";
  const result = await pool.query(
    `SELECT id, company_id, name, phone, whatsapp, plate, notes, is_active, created_at, updated_at
     FROM delivery_drivers
     WHERE company_id = $1 ${activeFilter}
     ORDER BY is_active DESC, name ASC`,
    [companyId],
  );
  return result.rows || [];
};

const find = async (id) => {
  const result = await pool.query(`SELECT * FROM delivery_drivers WHERE id = $1`, [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const { company_id, name, phone, whatsapp, plate, notes, is_active } = data;
  const result = await pool.query(
    `INSERT INTO delivery_drivers (company_id, name, phone, whatsapp, plate, notes, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
     RETURNING *`,
    [company_id, name, phone || null, whatsapp || null, plate || null, notes || null, is_active],
  );
  return result.rows[0];
};

const update = async (id, data) => {
  const { name, phone, whatsapp, plate, notes, is_active } = data;
  const result = await pool.query(
    `UPDATE delivery_drivers SET
       name       = COALESCE($2, name),
       phone      = COALESCE($3, phone),
       whatsapp   = COALESCE($4, whatsapp),
       plate      = COALESCE($5, plate),
       notes      = COALESCE($6, notes),
       is_active  = COALESCE($7, is_active),
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, name, phone, whatsapp, plate, notes, is_active],
  );
  return result.rows[0] || null;
};

const remove = async (id) => {
  const result = await pool.query(`DELETE FROM delivery_drivers WHERE id = $1 RETURNING *`, [id]);
  return result.rows[0] || null;
};

module.exports = { findByCompany, find, create, update, remove };
