const pool = require("../db");
const { normalizePhone } = require("../helpers/phone");

// user_addresses.state é varchar(2) (UF). O Google Places (/address/details)
// devolve o nome completo do estado ("Espírito Santo"), que estoura a coluna.
// Este helper converte nome completo -> sigla; se já vier sigla, normaliza; se
// não reconhecer, corta em 2 (evita quebrar o insert). Sem acento e case-insensitive.
const _UF_BY_NAME = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA",
  ceara: "CE", "distrito federal": "DF", "espirito santo": "ES", goias: "GO",
  maranhao: "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG",
  para: "PA", paraiba: "PB", parana: "PR", pernambuco: "PE", piaui: "PI",
  "rio de janeiro": "RJ", "rio grande do norte": "RN", "rio grande do sul": "RS",
  rondonia: "RO", roraima: "RR", "santa catarina": "SC", "sao paulo": "SP",
  sergipe: "SE", tocantins: "TO",
};
const _toUf = (state) => {
  const raw = String(state ?? "").trim();
  if (!raw) return null;
  if (raw.length === 2) return raw.toUpperCase();
  const key = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase();
  return _UF_BY_NAME[key] || raw.slice(0, 2).toUpperCase();
};

// ─────────────────────────────────────────────────────────────────────────────
// Camada de IDENTIDADE (global) — separa "quem é a pessoa" do "relacionamento
// com um restaurante" (clients) e dos "endereços salvos" (user_addresses).
//
// Tabelas usadas (criadas na FASE A do DB_CHANGES_NEEDED.md — este código só
// funciona em runtime APÓS a FASE A ser aplicada manualmente no banco):
//   platform_users, user_identifiers, user_addresses.
//
// Fronteira: o restaurante NUNCA lê a camada global. `clients` continua sendo o
// hub por empresa; ele apenas ganha a coluna user_id. `clients` só é criado no
// ponto de resolução de identidade — nunca no cadastro de endereço nem no
// fechamento de pedido.
// ─────────────────────────────────────────────────────────────────────────────

// Resolve (ou cria) a identidade global a partir de um telefone.
// Retorna { userId, phoneNorm }. Lança { status:400 } se o telefone é inválido.
const resolveUserByPhone = async (db, phoneRaw, { name } = {}) => {
  const phoneNorm = normalizePhone(phoneRaw);
  if (!phoneNorm) {
    const err = new Error("Telefone inválido");
    err.status = 400;
    throw err;
  }

  const found = await db.query(
    `SELECT user_id FROM user_identifiers
     WHERE type = 'phone' AND value_norm = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [phoneNorm],
  );
  if (found.rows[0]) {
    const userId = found.rows[0].user_id;
    await db.query(
      `UPDATE user_identifiers SET last_seen_at = now()
       WHERE type = 'phone' AND value_norm = $1 AND revoked_at IS NULL`,
      [phoneNorm],
    );
    return { userId, phoneNorm };
  }

  // Não existe: cria identidade + canal telefone.
  const u = await db.query(
    `INSERT INTO platform_users (name) VALUES ($1) RETURNING id`,
    [name ?? null],
  );
  const userId = u.rows[0].id;
  await db.query(
    `INSERT INTO user_identifiers (user_id, type, value_norm, last_seen_at)
     VALUES ($1, 'phone', $2, now())`,
    [userId, phoneNorm],
  );
  return { userId, phoneNorm };
};

// Resolve (ou cria) o relacionamento com UM restaurante: clients (company_id, user_id).
// `clients` só é criado aqui.
const resolveClient = async (db, { companyId, userId, name, phone }) => {
  const existing = await db.query(
    `SELECT * FROM clients
     WHERE company_id = $1 AND user_id = $2 AND deactivated_at IS NULL
     ORDER BY id ASC LIMIT 1`,
    [companyId, userId],
  );
  if (existing.rows[0]) {
    // Mantém nome mais recente informado (não sobrescreve com vazio).
    if (name && name !== existing.rows[0].name) {
      const upd = await db.query(
        `UPDATE clients SET name = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [existing.rows[0].id, name],
      );
      return upd.rows[0];
    }
    return existing.rows[0];
  }

  const created = await db.query(
    `INSERT INTO clients (company_id, name, phone, user_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, name ?? "Cliente", phone ?? null, userId],
  );
  return created.rows[0];
};

// Fluxo completo usado pelo pedido web e pelo n8n:
// telefone -> identidade -> client da empresa. Tudo em uma transação.
const resolveClientByPhone = async ({ companyId, phone, name }) => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { userId, phoneNorm } = await resolveUserByPhone(db, phone, { name });
    const client = await resolveClient(db, { companyId, userId, name, phone });
    await db.query("COMMIT");
    return { client, userId, phoneNorm };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
};

// Lookup puro (NÃO cria) — usado por leituras (GET de endereços). Retorna userId|null.
const lookupUserIdByPhone = async (phoneRaw) => {
  const phoneNorm = normalizePhone(phoneRaw);
  if (!phoneNorm) return null;
  const r = await pool.query(
    `SELECT user_id FROM user_identifiers
     WHERE type = 'phone' AND value_norm = $1 AND revoked_at IS NULL LIMIT 1`,
    [phoneNorm],
  );
  return r.rows[0]?.user_id ?? null;
};

// ─── Endereços salvos (globais, do usuário) ─────────────────────────────────

const listAddresses = async (userId) => {
  const r = await pool.query(
    `SELECT * FROM user_addresses
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return r.rows;
};

const createAddress = async (userId, data) => {
  const {
    label, street, number, complement, neighborhood,
    city, state, zip, latitude, longitude, is_default,
  } = data;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (is_default) {
      await db.query(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    }
    // Primeiro endereço do usuário vira default automaticamente.
    const count = await db.query(
      `SELECT count(*)::int n FROM user_addresses WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const makeDefault = is_default || count.rows[0].n === 0;
    const r = await db.query(
      `INSERT INTO user_addresses
        (user_id, label, street, number, complement, neighborhood, city, state, zip,
         latitude, longitude, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, label ?? null, street, number ?? null, complement ?? null, neighborhood ?? null,
       city ?? null, _toUf(state), zip ?? null, latitude ?? null, longitude ?? null, makeDefault],
    );
    await db.query("COMMIT");
    return r.rows[0];
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
};

const updateAddress = async (id, userId, data) => {
  const {
    label, street, number, complement, neighborhood,
    city, state, zip, latitude, longitude, is_default,
  } = data;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (is_default) {
      await db.query(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    }
    const r = await db.query(
      `UPDATE user_addresses SET
         label = $3, street = $4, number = $5, complement = $6, neighborhood = $7,
         city = $8, state = $9, zip = $10, latitude = $11, longitude = $12,
         is_default = COALESCE($13, is_default)
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [id, userId, label ?? null, street, number ?? null, complement ?? null, neighborhood ?? null,
       city ?? null, _toUf(state), zip ?? null, latitude ?? null, longitude ?? null,
       is_default ?? null],
    );
    await db.query("COMMIT");
    return r.rows[0] || null;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
};

const deleteAddress = async (id, userId) => {
  const r = await pool.query(
    `UPDATE user_addresses SET deleted_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
    [id, userId],
  );
  return !!r.rows[0];
};

module.exports = {
  resolveUserByPhone,
  resolveClient,
  resolveClientByPhone,
  lookupUserIdByPhone,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
};
