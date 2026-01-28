const pool = require("../db");

/**
 * Get All Account
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM account ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT id,name,email,active,created_at,phone,document,birthday FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { id, name, email, active, createdAt, phone, document, birthday } = data;
  const result = await pool.query(
    "UPDATE users SET id = $1, name = $2, email = $3, active = $4, created_at = $5, phone = $6, document = $7, birthday = $8 WHERE id = $9 RETURNING *",
    [id, name, email, active, createdAt, phone, document, birthday, id]
  );
  return result.rows[0];
};

module.exports = { findAll, find, update };
