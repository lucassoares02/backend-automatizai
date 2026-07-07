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

// Atualização PARCIAL: só altera os campos realmente enviados (não-nulos). Isso
// evita que salvar apenas nome+telefone (ex.: etapa inicial do onboarding)
// sobrescreva/zere colunas obrigatórias como `email` (NOT NULL) — o que fazia a
// gravação do telefone falhar silenciosamente. O `id` vem sempre do req.user.
const update = async (data) => {
  const id = data.id;
  const allowed = ["name", "email", "active", "phone", "document", "birthday"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (data[key] !== undefined && data[key] !== null) {
      sets.push(`${key} = $${i++}`);
      values.push(data[key]);
    }
  }

  if (sets.length === 0) return find(id);

  values.push(id);
  const result = await pool.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i}
     RETURNING id,name,email,active,created_at,phone,document,birthday`,
    values,
  );
  return result.rows[0];
};

module.exports = { findAll, find, update };
