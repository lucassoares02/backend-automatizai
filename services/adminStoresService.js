const pool = require("../db");

// Gestão de vínculos usuário ↔ loja (tabela user_companies) pelo admin do sistema.
// Grava o mesmo vínculo que o cadastro cria (registerService.createCompanies) e
// que antes era inserido à mão no banco: relation_type = 0.
const DEFAULT_RELATION_TYPE = 0;

const normalizeEmail = (email) => (typeof email === "string" ? email.trim().toLowerCase() : "");

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const _error = (code, message) => Object.assign(new Error(message), { code });

// Todas as lojas com a quantidade de usuários vinculados.
const listStores = async (db = pool) => {
  const result = await db.query(
    `SELECT c.id, c.name, c.business_segment, COUNT(uc.user_id)::int AS users_count
       FROM companies c
       LEFT JOIN user_companies uc ON uc.company_id = c.id
      GROUP BY c.id
      ORDER BY c.name ASC NULLS LAST, c.id ASC`,
  );
  return result.rows;
};

const _ensureStore = async (db, companyId) => {
  const result = await db.query("SELECT id FROM companies WHERE id = $1", [companyId]);
  if (!result.rows[0]) throw _error("STORE_NOT_FOUND", "Loja não encontrada");
};

const listStoreUsers = async (companyId, db = pool) => {
  await _ensureStore(db, companyId);
  const result = await db.query(
    `SELECT u.id, u.name, u.email, uc.created_at AS linked_at
       FROM user_companies uc
       JOIN users u ON u.id = uc.user_id
      WHERE uc.company_id = $1
      ORDER BY u.name ASC NULLS LAST, u.email ASC`,
    [companyId],
  );
  return result.rows;
};

// Vincula um usuário JÁ cadastrado à loja. Não cria usuário.
const linkUserByEmail = async (companyId, rawEmail, db = pool) => {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) throw _error("INVALID_EMAIL", "Informe um e-mail válido");

  await _ensureStore(db, companyId);

  const userRes = await db.query(
    "SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = $1 ORDER BY id LIMIT 1",
    [email],
  );
  const user = userRes.rows[0];
  if (!user) throw _error("USER_NOT_FOUND", "Nenhum usuário cadastrado com este e-mail");

  // Índice único (user_id, company_id): vínculo repetido não duplica.
  const insert = await db.query(
    `INSERT INTO user_companies (user_id, company_id, relation_type)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING created_at`,
    [user.id, companyId, DEFAULT_RELATION_TYPE],
  );
  if (!insert.rows[0]) throw _error("ALREADY_LINKED", "Este usuário já gerencia a loja");

  return { ...user, linked_at: insert.rows[0].created_at };
};

const unlinkUser = async (companyId, userId, db = pool) => {
  const result = await db.query(
    "DELETE FROM user_companies WHERE company_id = $1 AND user_id = $2",
    [companyId, userId],
  );
  if (result.rowCount === 0) throw _error("LINK_NOT_FOUND", "Vínculo não encontrado");
};

module.exports = { listStores, listStoreUsers, linkUserByEmail, unlinkUser, normalizeEmail, isValidEmail };
