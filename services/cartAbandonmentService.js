const cron = require("node-cron");
const pool = require("./../db");
const { n8nUrlWebhook } = require("./evolutionService");

const WEBHOOK_PATH = "abandono-carrinho";
const FETCH_TIMEOUT_MS = 15000;

// A cada 5 min varremos os carrinhos abandonados ainda não notificados.
const CRON_EXPRESSION = "*/5 * * * *";

// Tempo de inatividade para considerar o carrinho abandonado.
const INACTIVITY_MINUTES = 15;

// Janela máxima de retroatividade — evita enxurrada de disparos históricos no
// primeiro deploy (todas as sessões antigas teriam abandonment_notified_at NULL).
const LOOKBACK_HOURS = 24;

// Quantidade máxima de sessões processadas por ciclo.
const BATCH_LIMIT = 50;

const _buildPayload = (row) => ({
  event: "cart_abandoned",
  session_id: row.session_id,
  company: {
    id: row.company_id,
    name: row.company_name,
  },
  customer: {
    id: row.customer_id,
    name: row.customer_name,
    phone: row.customer_phone,
  },
  cart: {
    items_count: row.cart_items_count,
    subtotal: row.subtotal != null ? Number(row.subtotal) : null,
  },
  address: row.address,
  current_step: row.current_step,
  last_activity_at: row.last_activity_at,
  created_at: row.created_at,
});

// Busca os carrinhos abandonados: com itens, sem pedido criado, inativos há mais
// de INACTIVITY_MINUTES e ainda não notificados (dedup via abandonment_notified_at).
const _findAbandoned = async () => {
  const res = await pool.query(
    `SELECT s.id, s.session_id, s.company_id,
            s.customer_id, s.customer_name, s.customer_phone,
            s.cart_items_count, s.subtotal, s.address,
            s.current_step, s.last_activity_at, s.created_at,
            comp.name AS company_name
       FROM customer_tracking_sessions s
       JOIN companies comp ON comp.id = s.company_id
      WHERE s.cart_items_count > 0
        AND s.order_id IS NULL
        AND s.status <> 'order_created'
        AND s.abandonment_notified_at IS NULL
        AND s.last_activity_at < NOW() - ($1 || ' minutes')::interval
        AND s.last_activity_at > NOW() - ($2 || ' hours')::interval
      ORDER BY s.last_activity_at ASC
      LIMIT $3`,
    [String(INACTIVITY_MINUTES), String(LOOKBACK_HOURS), BATCH_LIMIT],
  );
  return res.rows;
};

// Busca uma sessão específica (para disparo manual sob demanda). Filtra por
// company para impedir disparo cruzado entre empresas.
const _findBySessionId = async (sessionId, companyId) => {
  const res = await pool.query(
    `SELECT s.id, s.session_id, s.company_id,
            s.customer_id, s.customer_name, s.customer_phone,
            s.cart_items_count, s.subtotal, s.address,
            s.current_step, s.last_activity_at, s.created_at,
            comp.name AS company_name
       FROM customer_tracking_sessions s
       JOIN companies comp ON comp.id = s.company_id
      WHERE s.session_id = $1
        AND s.company_id = $2
      LIMIT 1`,
    [sessionId, companyId],
  );
  return res.rows[0] || null;
};

const _markNotified = async (id) => {
  await pool.query(
    `UPDATE customer_tracking_sessions
        SET abandonment_notified_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id],
  );
};

// Faz o POST do webhook. Lança em caso de falha (HTTP != 2xx, timeout, rede).
const _postWebhook = async (row) => {
  const url = `${n8nUrlWebhook}${WEBHOOK_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(_buildPayload(row)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
};

// Notifica o n8n sobre um carrinho abandonado (ciclo do cron). Nunca lança:
// falhas do n8n não podem travar o ciclo. A sessão só é marcada como notificada
// em caso de sucesso (permite nova tentativa no próximo ciclo).
const _notify = async (row) => {
  try {
    await _postWebhook(row);
    await _markNotified(row.id);
    console.log(
      `[abandono-carrinho] webhook enviado. session=${row.session_id} company=${row.company_id} subtotal=${row.subtotal}`,
    );
  } catch (err) {
    console.error(
      `[abandono-carrinho] falha ao enviar webhook. session=${row.session_id} erro=${err.message}`,
    );
  }
};

// Disparo manual sob demanda (botão no painel de tracking). Força o reenvio
// mesmo que o cron já tenha notificado. Lança para o controller responder o
// status HTTP adequado (404 sessão inexistente / 502 falha no webhook).
const notifyBySessionId = async (sessionId, companyId) => {
  const row = await _findBySessionId(sessionId, companyId);
  if (!row) {
    const err = new Error("Sessão não encontrada");
    err.code = "NOT_FOUND";
    throw err;
  }
  await _postWebhook(row);
  await _markNotified(row.id);
  console.log(
    `[abandono-carrinho] webhook MANUAL enviado. session=${row.session_id} company=${row.company_id} subtotal=${row.subtotal}`,
  );
  return { session_id: row.session_id };
};

let running = false;

const runOnce = async () => {
  if (running) {
    console.log("[abandono-carrinho] ciclo anterior em andamento, pulando");
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const rows = await _findAbandoned();
    if (rows.length > 0) {
      console.log(`[abandono-carrinho] ${rows.length} carrinho(s) abandonado(s) a notificar`);
      for (const row of rows) {
        await _notify(row);
      }
    }
    console.log(`[abandono-carrinho] ciclo concluído em ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error(`[abandono-carrinho] erro no ciclo principal -> ${err.message}`);
  } finally {
    running = false;
  }
};

const start = () => {
  cron.schedule(CRON_EXPRESSION, runOnce);
  console.log(`[abandono-carrinho] agendado com expressão "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce, notifyBySessionId };
