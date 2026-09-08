const pool = require("../db");

// Etapas do pedido que podem notificar o cliente (ordem de exibição no portal).
// Corresponde aos status_colors do portal, exceto os que não fazem sentido
// notificar (1 = Aguardando, 10 = Pagamento Pendente).
const NOTIFIABLE_STATUSES = [2, 3, 4, 5, 8, 9, 6, 7];

const STATUS_NAMES = {
  2: "Confirmado",
  3: "Em Preparo",
  4: "Em Entrega",
  5: "Entregue",
  6: "Cancelado",
  7: "Rejeitado",
  8: "Pronto para retirada",
  9: "Retirado",
};

// Comportamento histórico do webhook: só estes status disparavam. Mantemos como
// default para empresas que ainda não personalizaram a configuração.
const DEFAULT_ENABLED = new Set([2, 4, 6, 7, 8]);

const DEFAULT_MESSAGES = {
  2: "Olá {cliente}! Seu pedido {pedido} na {loja} foi confirmado e já está sendo preparado. 🍽️",
  3: "Oi {cliente}! Seu pedido {pedido} já está em preparo. Não vai demorar! 👨‍🍳",
  4: "{cliente}, seu pedido {pedido} saiu para entrega e está a caminho. 🛵",
  5: "Pedido {pedido} entregue! Obrigado pela preferência, {cliente}. 💚",
  6: "Olá {cliente}, infelizmente seu pedido {pedido} foi cancelado. Qualquer dúvida, fale com a {loja}.",
  7: "Olá {cliente}, não foi possível aceitar seu pedido {pedido}. Entre em contato com a {loja} para mais detalhes.",
  8: "{cliente}, seu pedido {pedido} está pronto para retirada na {loja}! 🎉",
  9: "Pedido {pedido} retirado. Obrigado pela preferência, {cliente}! 💚",
};

const _defaultFor = (statusId) => ({
  status_id: statusId,
  status_name: STATUS_NAMES[statusId] ?? String(statusId),
  enabled: DEFAULT_ENABLED.has(statusId),
  message: DEFAULT_MESSAGES[statusId] ?? "",
  is_default: true,
});

/**
 * Lista a configuração de todas as etapas notificáveis de uma empresa. Sempre
 * retorna a lista completa (uma linha por etapa), preenchendo com os defaults
 * as etapas ainda não personalizadas — assim o portal exibe tudo de imediato.
 */
const findByCompany = async (companyId) => {
  let rows = [];
  try {
    const result = await pool.query(
      `SELECT status_id, enabled, message
         FROM order_status_notifications
        WHERE company_id = $1`,
      [companyId],
    );
    rows = result.rows;
  } catch (err) {
    // Enquanto a migração (DB_CHANGES_NEEDED.md) não roda, a tabela não existe:
    // devolvemos apenas os defaults para não quebrar o portal.
    if (err.code === "42P01") return NOTIFIABLE_STATUSES.map(_defaultFor);
    throw err;
  }
  const byStatus = new Map(rows.map((r) => [Number(r.status_id), r]));

  return NOTIFIABLE_STATUSES.map((statusId) => {
    const row = byStatus.get(statusId);
    if (!row) return _defaultFor(statusId);
    return {
      status_id: statusId,
      status_name: STATUS_NAMES[statusId] ?? String(statusId),
      enabled: row.enabled,
      message:
        row.message != null && String(row.message).trim() !== ""
          ? row.message
          : DEFAULT_MESSAGES[statusId] ?? "",
      is_default: false,
    };
  });
};

/**
 * Grava (upsert) a configuração de várias etapas de uma vez. Ignora status que
 * não estejam na lista de etapas notificáveis.
 */
const upsertMany = async (companyId, items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return findByCompany(companyId);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of items) {
      const statusId = Number(item.status_id);
      if (!NOTIFIABLE_STATUSES.includes(statusId)) continue;
      const enabled = item.enabled === true;
      const message =
        item.message != null && String(item.message).trim() !== ""
          ? String(item.message)
          : null;
      await client.query(
        `INSERT INTO order_status_notifications
           (company_id, status_id, enabled, message, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (company_id, status_id)
         DO UPDATE SET enabled = EXCLUDED.enabled,
                       message = EXCLUDED.message,
                       updated_at = NOW()`,
        [companyId, statusId, enabled, message],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return findByCompany(companyId);
};

/**
 * Resolve a configuração de notificação de uma etapa específica para o webhook.
 * Se não houver linha personalizada, cai no default (preserva o comportamento
 * histórico do disparo por status). Retorna sempre { enabled, message }.
 */
const resolveForStatus = async (companyId, statusId) => {
  const id = Number(statusId);
  const def = _defaultFor(id);
  if (companyId == null) return def;

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT enabled, message
         FROM order_status_notifications
        WHERE company_id = $1 AND status_id = $2
        LIMIT 1`,
      [companyId, id],
    );
    row = rows[0];
  } catch (err) {
    // Tabela ainda não criada: mantém o comportamento histórico de disparo.
    if (err.code === "42P01") return { enabled: def.enabled, message: def.message };
    throw err;
  }
  if (!row) return { enabled: def.enabled, message: def.message };

  return {
    enabled: row.enabled === true,
    message:
      row.message != null && String(row.message).trim() !== ""
        ? row.message
        : DEFAULT_MESSAGES[id] ?? "",
  };
};

module.exports = {
  NOTIFIABLE_STATUSES,
  STATUS_NAMES,
  DEFAULT_MESSAGES,
  findByCompany,
  upsertMany,
  resolveForStatus,
};
