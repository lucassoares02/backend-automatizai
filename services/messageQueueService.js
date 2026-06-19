const cron = require("node-cron");
const { Client } = require("pg");
const pool = require("../db");
const evolution = require("./evolutionService");
const connectionsService = require("./connectionsService");

// ─── Config (via .env, com defaults seguros) ────────────────────────────────────
const ENABLED = (process.env.MESSAGE_QUEUE_ENABLED ?? "true").toLowerCase() !== "false";
const WINDOW_MS = Number(process.env.DEBOUNCE_WINDOW_MS || 10000); // janela deslizante
const MAX_WAIT_MS = Number(process.env.DEBOUNCE_MAX_WAIT_MS || 60000); // teto de segurança
const DISPATCH_CRON = process.env.QUEUE_DISPATCH_CRON || "*/2 * * * * *"; // a cada 2s
const STUCK_CRON = process.env.QUEUE_STUCK_CRON || "* * * * *"; // a cada 1min
const STUCK_TIMEOUT_MS = Number(process.env.QUEUE_STUCK_TIMEOUT_MS || 180000); // 3min
const MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS || 5);
const RETRY_BACKOFF_MS = Number(process.env.QUEUE_RETRY_BACKOFF_MS || 30000);
const NOTIFY_CHANNEL = "n8n_queue_released";

// Tipos de mensagem considerados mídia (forçam flush imediato).
const MEDIA_TYPES = [
  "imageMessage",
  "audioMessage",
  "videoMessage",
  "documentMessage",
  "documentWithCaptionMessage",
  "stickerMessage",
  "ptvMessage",
];

// ─── Parsing do payload da Evolution ────────────────────────────────────────────

const _isMedia = (messageType, message) => {
  if (messageType && MEDIA_TYPES.includes(messageType)) return true;
  if (message && typeof message === "object") return MEDIA_TYPES.some((k) => message[k]);
  return false;
};

const _parseMessage = (body) => {
  const data = body?.data || {};
  const key = data.key || {};
  const message = data.message || {};
  const remoteJid = key.remoteJid || null;
  const text =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null;

  return {
    remoteJid,
    fromMe: key.fromMe === true,
    messageKey: key.id || null,
    messageType: data.messageType || null,
    text,
    isMedia: _isMedia(data.messageType, message),
  };
};

// ─── Enqueue (buffer + debounce) ────────────────────────────────────────────────

/**
 * Recebe um MESSAGES_UPSERT da Evolution, grava no buffer e (re)arma a janela de
 * debounce do job pendente daquela conversa. Mensagens de mídia forçam flush
 * imediato. Mensagens próprias (fromMe) e sem remoteJid são ignoradas.
 */
const enqueue = async (instanceName, body) => {
  const parsed = _parseMessage(body);
  if (!parsed.remoteJid || parsed.fromMe) return;

  // Confirma a leitura da mensagem recebida (read receipt) via N8N → Evolution.
  // Fire-and-forget: falha aqui não pode impactar a fila de mensagens.
  if (parsed.messageKey) {
    evolution
      .markMessageAsRead(instanceName, {
        remoteJid: parsed.remoteJid,
        fromMe: false,
        id: parsed.messageKey,
      })
      .catch((e) => console.error(`[message-queue] markMessageAsRead falhou (instance=${instanceName}): ${e.message}`));
  }

  const conn = await connectionsService.find_by_instance(instanceName).catch(() => null);
  const companyId = conn?.company_id ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serializa enqueues concorrentes da mesma conversa (evita 2 jobs pendentes).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${instanceName}|${parsed.remoteJid}`]);

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO incoming_messages
           (instance_name, company_id, remote_jid, message_key, text, message_type, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [instanceName, companyId, parsed.remoteJid, parsed.messageKey, parsed.text, parsed.messageType, body],
      );
    } catch (err) {
      // 23505 = mensagem duplicada (webhook reenviado pela Evolution) → ignora.
      await client.query("ROLLBACK");
      if (err.code === "23505") return;
      throw err;
    }
    const messageId = inserted.rows[0].id;

    // Job pendente existente para a conversa?
    const existing = await client.query(
      `SELECT id, first_message_at
         FROM n8n_message_queue
        WHERE instance_name = $1 AND remote_jid = $2 AND status = 'pending'
        FOR UPDATE`,
      [instanceName, parsed.remoteJid],
    );

    let jobId;
    if (existing.rows.length > 0) {
      const job = existing.rows[0];
      const firstAt = new Date(job.first_message_at).getTime();
      const cap = firstAt + MAX_WAIT_MS; // teto de segurança
      const desired = Date.now() + WINDOW_MS; // reset da janela deslizante
      const flushAt = parsed.isMedia ? new Date() : new Date(Math.min(desired, cap));

      await client.query(
        `UPDATE n8n_message_queue
            SET message_ids = array_append(message_ids, $2),
                flush_at = $3
          WHERE id = $1`,
        [job.id, messageId, flushAt],
      );
      jobId = job.id;
    } else {
      const flushAt = parsed.isMedia ? new Date() : new Date(Date.now() + WINDOW_MS);
      const created = await client.query(
        `INSERT INTO n8n_message_queue
           (instance_name, company_id, remote_jid, message_ids, status, first_message_at, flush_at)
         VALUES ($1, $2, $3, ARRAY[$4]::bigint[], 'pending', NOW(), $5)
         RETURNING id`,
        [instanceName, companyId, parsed.remoteJid, messageId, flushAt],
      );
      jobId = created.rows[0].id;
    }

    await client.query("UPDATE incoming_messages SET group_id = $2 WHERE id = $1", [messageId, jobId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[message-queue] enqueue falhou (instance=${instanceName}): ${err.message}`);
  } finally {
    client.release();
  }

  // Mídia já vence agora — tenta despachar sem esperar o cron.
  if (parsed.isMedia) scheduleDispatch();
};

// ─── Dispatch (lock por conversa + envio ao N8N) ────────────────────────────────

/**
 * Reivindica atomicamente o próximo job pronto (flush_at vencido) que NÃO tenha
 * outro job 'processing' na mesma conversa. FOR UPDATE SKIP LOCKED garante que
 * múltiplas instâncias da API não peguem o mesmo job.
 */
const _claimNext = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT *
         FROM n8n_message_queue q
        WHERE q.status = 'pending'
          AND q.flush_at <= NOW()
          AND NOT EXISTS (
            SELECT 1 FROM n8n_message_queue p
             WHERE p.instance_name = q.instance_name
               AND p.remote_jid = q.remote_jid
               AND p.status = 'processing'
          )
        ORDER BY q.flush_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }
    const job = rows[0];
    await client.query(
      `UPDATE n8n_message_queue
          SET status = 'processing', started_at = NOW(), attempts = attempts + 1
        WHERE id = $1`,
      [job.id],
    );
    await client.query("UPDATE incoming_messages SET status = 'grouped' WHERE id = ANY($1::bigint[])", [job.message_ids]);
    await client.query("COMMIT");
    return job;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Monta o payload encaminhado ao N8N: usa o envelope da última mensagem (mantém
 * o formato Evolution que o fluxo já lê), injeta o texto agregado em
 * data.message.conversation e adiciona o bloco _queue com o id de liberação.
 */
const _buildPayload = async (job) => {
  const { rows } = await pool.query(
    `SELECT id, text, message_type, raw
       FROM incoming_messages
      WHERE id = ANY($1::bigint[])
      ORDER BY id ASC`,
    [job.message_ids],
  );

  const texts = rows.map((r) => r.text).filter(Boolean);
  const aggregated = texts.join("\n");
  const last = rows.length ? rows[rows.length - 1].raw : {};
  const payload = JSON.parse(JSON.stringify(last || {}));

  if (aggregated && payload.data && payload.data.message) {
    payload.data.message = { ...payload.data.message, conversation: aggregated };
  }

  payload._queue = {
    id: job.id,
    instance_name: job.instance_name,
    remote_jid: job.remote_jid,
    message_count: rows.length,
    aggregated_text: aggregated,
    messages: rows.map((r) => ({ id: r.id, text: r.text, type: r.message_type })),
  };

  // Best-effort: guarda o texto agregado no job para auditoria.
  pool.query("UPDATE n8n_message_queue SET aggregated_text = $2 WHERE id = $1", [job.id, aggregated]).catch(() => {});

  return payload;
};

const _onForwardFailure = async (job, err) => {
  console.error(`[message-queue] forward N8N falhou (job=${job.id}, attempts=${job.attempts + 1}): ${err.message}`);
  await pool
    .query(
      `UPDATE n8n_message_queue
          SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
              flush_at = CASE WHEN attempts >= $2 THEN flush_at ELSE NOW() + ($3 || ' milliseconds')::interval END,
              started_at = NULL
        WHERE id = $1`,
      [job.id, MAX_ATTEMPTS, String(RETRY_BACKOFF_MS)],
    )
    .catch((e) => console.error(`[message-queue] não consegui reagendar job ${job.id}: ${e.message}`));
};

let dispatching = false;
let redispatchRequested = false;

/**
 * Drena todos os jobs prontos. Reentrante: chamadas concorrentes apenas marcam
 * um novo ciclo ao final, evitando despachos paralelos sobrepostos.
 */
const runDispatch = async () => {
  if (dispatching) {
    redispatchRequested = true;
    return;
  }
  dispatching = true;
  try {
    do {
      redispatchRequested = false;
      let job;
      // eslint-disable-next-line no-cond-assign
      while ((job = await _claimNext())) {
        try {
          const payload = await _buildPayload(job);
          await evolution.forwardToN8n(job.instance_name, payload);
          console.log(`[message-queue] job ${job.id} despachado (${job.remote_jid}, ${job.message_ids.length} msg)`);
        } catch (err) {
          await _onForwardFailure(job, err);
        }
      }
    } while (redispatchRequested);
  } catch (err) {
    console.error(`[message-queue] erro no ciclo de dispatch: ${err.message}`);
  } finally {
    dispatching = false;
  }
};

// Pequeno debounce para coalescer rajadas de NOTIFY/enqueue.
let dispatchTimer = null;
const scheduleDispatch = () => {
  if (dispatchTimer) return;
  dispatchTimer = setTimeout(() => {
    dispatchTimer = null;
    runDispatch();
  }, 50);
};

// ─── Watchdog: jobs presos em 'processing' (N8N caiu no meio) ───────────────────
const _recoverStuck = async () => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE n8n_message_queue
          SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
              flush_at = NOW(),
              started_at = NULL
        WHERE status = 'processing'
          AND started_at < NOW() - ($1 || ' milliseconds')::interval`,
      [String(STUCK_TIMEOUT_MS), MAX_ATTEMPTS],
    );
    if (rowCount > 0) {
      console.warn(`[message-queue] ${rowCount} job(s) preso(s) recuperado(s)`);
      scheduleDispatch();
    }
  } catch (err) {
    console.error(`[message-queue] watchdog falhou: ${err.message}`);
  }
};

// ─── LISTEN/NOTIFY: liberação disparada pelo nó do N8N ──────────────────────────
let listenerClient = null;

const _startListener = () => {
  listenerClient = new Client({
    connectionString: process.env.POSTGRESQL_EXTERNAL_URL,
    ssl: (process.env.ENVIROMENT || "development") === "development" ? false : { rejectUnauthorized: false },
  });

  listenerClient.on("notification", (msg) => {
    if (msg.channel === NOTIFY_CHANNEL) scheduleDispatch();
  });

  listenerClient.on("error", (err) => {
    console.error(`[message-queue] listener erro: ${err.message}; reconectando em 5s`);
    try {
      listenerClient.end().catch(() => {});
    } catch {
      /* noop */
    }
    setTimeout(_startListener, 5000);
  });

  listenerClient
    .connect()
    .then(() => listenerClient.query(`LISTEN ${NOTIFY_CHANNEL}`))
    .then(() => console.log(`[message-queue] escutando canal "${NOTIFY_CHANNEL}"`))
    .catch((err) => {
      console.error(`[message-queue] falha ao conectar listener: ${err.message}; tentando em 5s`);
      setTimeout(_startListener, 5000);
    });
};

// ─── Bootstrap ──────────────────────────────────────────────────────────────────
const _tablesExist = async () => {
  const { rows } = await pool.query(
    "SELECT to_regclass('public.incoming_messages') AS a, to_regclass('public.n8n_message_queue') AS b",
  );
  return rows[0]?.a && rows[0]?.b;
};

const start = async () => {
  if (!ENABLED) {
    console.warn("[message-queue] desabilitado via MESSAGE_QUEUE_ENABLED=false");
    return;
  }
  try {
    if (!(await _tablesExist())) {
      console.warn("[message-queue] tabelas ausentes (rode a migration do DB_CHANGES_NEEDED.md); serviço não iniciado");
      return;
    }
  } catch (err) {
    console.error(`[message-queue] não consegui verificar tabelas: ${err.message}; serviço não iniciado`);
    return;
  }

  _startListener();
  cron.schedule(DISPATCH_CRON, runDispatch);
  cron.schedule(STUCK_CRON, _recoverStuck);
  console.log(
    `[message-queue] iniciado (janela=${WINDOW_MS}ms, teto=${MAX_WAIT_MS}ms, dispatch="${DISPATCH_CRON}", stuck="${STUCK_CRON}")`,
  );
  // Drena qualquer job pendente deixado por um deploy anterior.
  scheduleDispatch();
};

module.exports = { start, enqueue, runDispatch };
