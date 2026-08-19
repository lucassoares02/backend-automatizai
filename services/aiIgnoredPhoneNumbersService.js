const pool = require("../db");

const TABLE_NAME = "ai_ignored_phone_numbers";

const pendingDatabaseError = () =>
  Object.assign(
    new Error("A estrutura de números sem resposta da IA ainda não foi aplicada no banco de dados."),
    { status: 503, code: "AI_IGNORED_NUMBERS_SCHEMA_PENDING" },
  );

/**
 * Canoniza um telefone brasileiro para 55 + DDD + número, sem sinais.
 * Aceita valores nacionais e os JIDs entregues pela Evolution.
 */
const normalizeBrazilianPhone = (raw) => {
  if (raw == null) return null;

  let digits = String(raw).replace(/@.*$/, "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;

  if (![12, 13].includes(digits.length) || !digits.startsWith("55")) return null;
  return digits;
};

const validateMobilePhone = (raw) => {
  const phone = normalizeBrazilianPhone(raw);
  // 55 + DDD (primeiro dígito não pode ser zero) + celular iniciado por 9.
  if (!phone || !/^55[1-9]\d9\d{8}$/.test(phone)) {
    throw Object.assign(new Error("Informe um celular no formato 55 (DDD) 9 0000-0000."), { status: 400 });
  }
  return phone;
};

const tableExists = async () => {
  const { rows } = await pool.query("SELECT to_regclass($1) AS table_name", [`public.${TABLE_NAME}`]);
  return Boolean(rows[0]?.table_name);
};

const ensureTableExists = async () => {
  if (!(await tableExists())) throw pendingDatabaseError();
};

const findAllByCompany = async (companyId) => {
  await ensureTableExists();
  const { rows } = await pool.query(
    `SELECT id, company_id, description, phone, created_at, updated_at
       FROM ai_ignored_phone_numbers
      WHERE company_id = $1
      ORDER BY description ASC, id DESC`,
    [companyId],
  );
  return rows;
};

const create = async ({ companyId, description, phone }) => {
  await ensureTableExists();
  const normalizedPhone = validateMobilePhone(phone);
  const normalizedDescription = String(description || "").trim();

  if (!normalizedDescription) {
    throw Object.assign(new Error("Informe uma descrição para identificar o contato."), { status: 400 });
  }
  if (normalizedDescription.length > 120) {
    throw Object.assign(new Error("A descrição deve ter no máximo 120 caracteres."), { status: 400 });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_ignored_phone_numbers (company_id, description, phone)
       VALUES ($1, $2, $3)
       RETURNING id, company_id, description, phone, created_at, updated_at`,
      [companyId, normalizedDescription, normalizedPhone],
    );
    return rows[0];
  } catch (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("Este número já está na lista de contatos sem resposta da IA."), { status: 409 });
    }
    throw error;
  }
};

const remove = async (id) => {
  await ensureTableExists();
  const { rows } = await pool.query(
    `DELETE FROM ai_ignored_phone_numbers
      WHERE id = $1
      RETURNING id, company_id, description, phone`,
    [id],
  );
  return rows[0] || null;
};

/**
 * Extrai apenas identidades de remetente do envelope da Evolution. remoteJidAlt
 * cobre contas que chegam com um identificador @lid no remoteJid principal.
 */
const extractSenderPhones = (body, fallbackRemoteJid = null) => {
  const key = body?.data?.key || {};
  const candidates = [key.remoteJid, key.remoteJidAlt, key.participant, fallbackRemoteJid];
  return [...new Set(candidates.map(normalizeBrazilianPhone).filter(Boolean))];
};

/**
 * Consulta usada no caminho crítico do webhook. A ausência da nova tabela é
 * tolerada durante a janela de deploy para não derrubar todo o atendimento; as
 * rotas administrativas, por outro lado, respondem 503 até a migration existir.
 */
const shouldIgnoreMessage = async ({ companyId, body, remoteJid }) => {
  if (!companyId) return false;
  const phones = extractSenderPhones(body, remoteJid);
  if (phones.length === 0) return false;

  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM ai_ignored_phone_numbers
          WHERE company_id = $1
            AND phone = ANY($2::text[])
       ) AS ignored`,
      [companyId, phones],
    );
    return rows[0]?.ignored === true;
  } catch (error) {
    if (error.code === "42P01") {
      console.warn("[ai-ignore] tabela ausente; bloqueio ainda não está ativo");
      return false;
    }
    throw error;
  }
};

module.exports = {
  findAllByCompany,
  create,
  remove,
  shouldIgnoreMessage,
  _testing: { normalizeBrazilianPhone, validateMobilePhone, extractSenderPhones },
};
