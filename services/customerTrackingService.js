const pool = require("../db");

// Status válidos para o funil de tracking
const VALID_STATUSES = new Set([
  "browsing",
  "selecting_products",
  "cart",
  "checkout",
  "address_filled",
  "payment_selection",
  "order_created",
  "abandoned",
]);

// Steps (corresponde ao enum _Step do front público)
const VALID_STEPS = new Set([
  "menu",
  "cart",
  "identify",
  "address",
  "checkout",
  "card_entry",
  "payment_processing",
  "payment",
  "success",
  "tracking",
  "history",
  "cancel",
]);

const _str = (v, max = 255) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s.length) return null;
  return s.slice(0, max);
};

const _num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const _int = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Serializa um array (snapshot do carrinho) para jsonb. Retorna null se não for
// array ou se exceder o teto de tamanho (proteção contra payloads abusivos).
const _jsonArray = (v, maxLen = 20000) => {
  if (!Array.isArray(v)) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > maxLen ? null : s;
  } catch (_) {
    return null;
  }
};

// ─── Regras de visita/presença ──────────────────────────────────────────────
// Uma linha de customer_tracking_sessions representa UMA VISITA de carrinho. O
// cardápio público reaproveita o mesmo token do dispositivo (localStorage) em
// todas as visitas; por isso o backend "arquiva" a linha anterior (renomeia o
// session_id com o sufixo ~xxxx) e abre uma nova quando:
//   • a visita anterior terminou em pedido e o cliente voltou a comprar; ou
//   • a visita anterior está sem sinal (interação ou heartbeat) há mais de
//     VISIT_IDLE_MINUTES — a pessoa fechou o cardápio e voltou depois.
// Assim um pedido antigo nunca marca como "comprado" um carrinho novo.
const VISIT_IDLE_MINUTES = 30;
// O cardápio manda heartbeat a cada 45 s enquanto a aba está aberta; com a aba
// em segundo plano o navegador espaça os timers (intervalos de 2–3 min), por
// isso a tolerância de 5 min.
const ONLINE_SECONDS = 300;
// Janela dos carrinhos abandonados exibidos no painel.
const ABANDONED_LOOKBACK_HOURS = 24;
// Etapas em que o cliente está montando um carrinho NOVO (não pagando o pedido
// que acabou de criar).
const SHOPPING_STEPS = new Set(["menu", "cart", "identify", "address", "history"]);
const ARCHIVE_SEPARATOR = "~";

const _rotationReason = (row, incoming, now = new Date()) => {
  if (!row) return null;
  // last_seen_at = última interação OU heartbeat: aba aberta parada não é
  // visita nova.
  const lastRaw = row.last_seen_at || row.last_activity_at;
  const last = lastRaw ? new Date(lastRaw) : null;
  if (last && now.getTime() - last.getTime() > VISIT_IDLE_MINUTES * 60 * 1000) {
    return "new_visit";
  }
  const rowOrderId = row.order_id ? Number(row.order_id) : null;
  if (
    rowOrderId &&
    incoming.status !== "order_created" &&
    incoming.order_id !== rowOrderId &&
    SHOPPING_STEPS.has(incoming.current_step)
  ) {
    return "after_order";
  }
  return null;
};

const _archivedSessionId = (sessionId, now = new Date()) => {
  const suffix = `${ARCHIVE_SEPARATOR}${now.getTime().toString(36)}`;
  return `${sessionId.slice(0, 64 - suffix.length)}${suffix}`;
};

// Fecha a visita atual renomeando o session_id (libera o token para a nova
// visita). Carrinho sem pedido vira "abandoned"; os demais mantêm o status.
const _archiveRow = async (client, row) => {
  await client.query(
    `UPDATE customer_tracking_sessions
        SET session_id = $2,
            is_active  = FALSE,
            status     = CASE WHEN order_id IS NULL AND cart_items_count > 0
                                   AND status <> 'order_created'
                              THEN 'abandoned' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`,
    [row.id, _archivedSessionId(row.session_id)],
  );
};

// Upsert da sessão. Idempotente — o cliente reenvia o estado completo a cada
// transição relevante e o backend atualiza por (company_id, session_id).
const upsertSession = async (payload) => {
  const companyId = _int(payload?.company_id);
  const sessionId = _str(payload?.session_id, 64);
  if (!companyId || !sessionId) return null;

  const incoming = {
    status: VALID_STATUSES.has(payload?.status) ? payload.status : "browsing",
    current_step: VALID_STEPS.has(payload?.current_step) ? payload.current_step : "menu",
    order_id: _int(payload?.order_id),
  };
  const cartItems = _jsonArray(payload?.cart_items);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT s.id, s.session_id, s.status, s.order_id, s.last_activity_at,
              GREATEST(s.last_activity_at,
                       COALESCE((SELECT MAX(e.created_at) FROM tracking_events e
                                  WHERE e.session_id = s.session_id
                                    AND e.company_id = s.company_id
                                    AND e.created_at >= s.last_activity_at),
                                s.last_activity_at)) AS last_seen_at,
              s.customer_id, s.customer_name, s.customer_phone,
              s.abandonment_notified_at,
              (s.cart_items IS NOT DISTINCT FROM $3::jsonb) AS same_cart
         FROM customer_tracking_sessions s
        WHERE s.company_id = $1 AND s.session_id = $2
        FOR UPDATE OF s`,
      [companyId, sessionId, cartItems],
    );
    let row = existing.rows[0] || null;

    // Visita nova herda a identidade do dispositivo. O aviso de abandono só é
    // herdado se o carrinho for exatamente o mesmo (evita reenviar o WhatsApp a
    // cada vez que o cliente reabre o cardápio com o carrinho salvo).
    let carried = null;
    if (_rotationReason(row, incoming)) {
      await _archiveRow(client, row);
      carried = {
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        abandonment_notified_at:
          row.same_cart && !row.order_id ? row.abandonment_notified_at : null,
      };
      row = null;
    }

    // "Pedido criado" só vale para a visita que tem o pedido. Sem pedido (ex.:
    // cliente abrindo o acompanhamento de um pedido antigo) é só navegação.
    const hasOrder = Boolean(incoming.order_id || row?.order_id);
    const status =
      incoming.status === "order_created" && !hasOrder ? "browsing" : incoming.status;

    const params = [
      sessionId,
      companyId,
      _int(payload?.customer_id) ?? carried?.customer_id ?? null,
      _str(payload?.customer_name, 150) ?? carried?.customer_name ?? null,
      _str(payload?.customer_phone, 40) ?? carried?.customer_phone ?? null,
      status,
      incoming.current_step,
      Math.max(0, parseInt(payload?.cart_items_count) || 0),
      Math.max(0, _num(payload?.subtotal) ?? 0),
      _num(payload?.latitude),
      _num(payload?.longitude),
      _str(payload?.address, 500),
      incoming.order_id,
      _str(payload?.device_type, 30) || "web",
      _str(payload?.user_agent, 500),
      cartItems,
      carried?.abandonment_notified_at ?? null,
    ];

    const res = await client.query(
      `INSERT INTO customer_tracking_sessions
         (session_id, company_id, customer_id, customer_name, customer_phone,
          status, current_step, cart_items_count, subtotal,
          latitude, longitude, address, order_id,
          device_type, user_agent, cart_items, abandonment_notified_at,
          is_active, last_activity_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,
               TRUE, NOW(), NOW(), NOW())
       ON CONFLICT (company_id, session_id) DO UPDATE SET
         customer_id      = COALESCE(EXCLUDED.customer_id, customer_tracking_sessions.customer_id),
         customer_name    = COALESCE(EXCLUDED.customer_name, customer_tracking_sessions.customer_name),
         customer_phone   = COALESCE(EXCLUDED.customer_phone, customer_tracking_sessions.customer_phone),
         -- Visita com pedido fica congelada como "Pedido criado" (o pós-pedido,
         -- como o pagamento online, não reabre o funil). Carrinho novo abre
         -- outra visita (ver _rotationReason).
         status = CASE
           WHEN customer_tracking_sessions.status = 'order_created'
           THEN customer_tracking_sessions.status
           ELSE EXCLUDED.status
         END,
         current_step = CASE
           WHEN customer_tracking_sessions.status = 'order_created'
            AND EXCLUDED.status <> 'order_created'
           THEN customer_tracking_sessions.current_step
           ELSE EXCLUDED.current_step
         END,
         -- O cliente esvazia o carrinho logo após o pedido (clearCart) e essa
         -- sincronização pode chegar antes/depois do attachOrder: preserva os
         -- itens do pedido em vez de zerá-los.
         cart_items_count = CASE
           WHEN (customer_tracking_sessions.status = 'order_created'
                 OR EXCLUDED.status = 'order_created'
                 OR customer_tracking_sessions.order_id IS NOT NULL)
            AND customer_tracking_sessions.cart_items_count > 0
           THEN customer_tracking_sessions.cart_items_count
           ELSE EXCLUDED.cart_items_count
         END,
         subtotal = CASE
           WHEN (customer_tracking_sessions.status = 'order_created'
                 OR EXCLUDED.status = 'order_created'
                 OR customer_tracking_sessions.order_id IS NOT NULL)
            AND customer_tracking_sessions.cart_items_count > 0
           THEN customer_tracking_sessions.subtotal
           ELSE EXCLUDED.subtotal
         END,
         cart_items = CASE
           WHEN (customer_tracking_sessions.status = 'order_created'
                 OR EXCLUDED.status = 'order_created'
                 OR customer_tracking_sessions.order_id IS NOT NULL)
            AND customer_tracking_sessions.cart_items_count > 0
           THEN customer_tracking_sessions.cart_items
           ELSE COALESCE(EXCLUDED.cart_items, customer_tracking_sessions.cart_items)
         END,
         latitude         = COALESCE(EXCLUDED.latitude, customer_tracking_sessions.latitude),
         longitude        = COALESCE(EXCLUDED.longitude, customer_tracking_sessions.longitude),
         address          = COALESCE(EXCLUDED.address, customer_tracking_sessions.address),
         order_id         = COALESCE(customer_tracking_sessions.order_id, EXCLUDED.order_id),
         device_type      = COALESCE(EXCLUDED.device_type, customer_tracking_sessions.device_type),
         user_agent       = COALESCE(EXCLUDED.user_agent, customer_tracking_sessions.user_agent),
         is_active        = TRUE,
         last_activity_at = NOW(),
         updated_at       = NOW()
       RETURNING id, session_id, company_id, status, current_step, last_activity_at`,
      params,
    );
    await client.query("COMMIT");
    return res.rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// Atualiza apenas localização (chamado quando o cliente preenche o endereço).
const updateLocation = async (payload) => {
  const companyId = _int(payload?.company_id);
  const sessionId = _str(payload?.session_id, 64);
  const lat = _num(payload?.latitude);
  const lng = _num(payload?.longitude);
  const address = _str(payload?.address, 500);
  if (!companyId || !sessionId) return null;

  const res = await pool.query(
    `UPDATE customer_tracking_sessions
        SET latitude         = COALESCE($3, latitude),
            longitude        = COALESCE($4, longitude),
            address          = COALESCE($5, address),
            status           = CASE WHEN $5 IS NOT NULL AND status NOT IN ('order_created','abandoned')
                                     THEN 'address_filled' ELSE status END,
            is_active        = TRUE,
            last_activity_at = NOW(),
            updated_at       = NOW()
      WHERE company_id = $1 AND session_id = $2
      RETURNING id`,
    [companyId, sessionId, lat, lng, address],
  );
  return res.rows[0] || null;
};

// Marca a sessão como finalizada por order_id. Se a visita já tinha OUTRO
// pedido (o cliente comprou de novo sem voltar ao cardápio), a visita anterior
// é arquivada e o novo pedido ganha uma visita própria.
const attachOrder = async (payload) => {
  const companyId = _int(payload?.company_id);
  const sessionId = _str(payload?.session_id, 64);
  const orderId = _int(payload?.order_id);
  if (!companyId || !sessionId || !orderId) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id, session_id, order_id FROM customer_tracking_sessions
        WHERE company_id = $1 AND session_id = $2
        FOR UPDATE`,
      [companyId, sessionId],
    );
    const row = existing.rows[0];
    if (row?.order_id && Number(row.order_id) !== orderId) {
      await _archiveRow(client, row);
      await client.query(
        `INSERT INTO customer_tracking_sessions
           (session_id, company_id, customer_id, customer_name, customer_phone,
            status, current_step, order_id, device_type, user_agent,
            is_active, last_activity_at, created_at, updated_at)
         SELECT $2, company_id, customer_id, customer_name, customer_phone,
                'order_created', 'success', $3, device_type, user_agent,
                TRUE, NOW(), NOW(), NOW()
           FROM customer_tracking_sessions WHERE id = $1`,
        [row.id, sessionId, orderId],
      );
    } else {
      await client.query(
        `UPDATE customer_tracking_sessions
            SET order_id         = $3,
                status           = 'order_created',
                current_step     = 'success',
                is_active        = TRUE,
                last_activity_at = NOW(),
                updated_at       = NOW()
          WHERE company_id = $1 AND session_id = $2`,
        [companyId, sessionId, orderId],
      );
    }
    await client.query("COMMIT");
    return { session_id: sessionId, order_id: orderId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// Insere evento de funil (fire-and-forget).
const trackEvent = async (payload) => {
  const companyId = _int(payload?.company_id);
  const sessionId = _str(payload?.session_id, 64);
  const eventType = _str(payload?.event_type, 40);
  if (!companyId || !sessionId || !eventType) return;

  const step = VALID_STEPS.has(payload?.step) ? payload.step : null;
  let eventPayload = null;
  if (payload?.payload && typeof payload.payload === "object") {
    try {
      eventPayload = JSON.stringify(payload.payload);
      if (eventPayload.length > 4000) eventPayload = null;
    } catch (_) {
      eventPayload = null;
    }
  }

  await pool.query(
    `INSERT INTO tracking_events (session_id, company_id, event_type, step, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [sessionId, companyId, eventType, step, eventPayload],
  );
};

// Marca como inativas as visitas paradas há mais de VISIT_IDLE_MINUTES e sem a
// aba aberta (sem heartbeat recente). Só vira "abandoned" quem tinha carrinho e
// não comprou — visitante que só olhou o cardápio não é carrinho abandonado.
const _expireStale = async (companyId) => {
  await pool.query(
    `UPDATE customer_tracking_sessions
        SET is_active = FALSE,
            status    = CASE WHEN cart_items_count > 0 AND order_id IS NULL
                              AND status <> 'order_created'
                             THEN 'abandoned' ELSE status END,
            updated_at = NOW()
      WHERE company_id = $1
        AND is_active = TRUE
        AND last_activity_at < NOW() - ($2 || ' minutes')::interval
        AND NOT EXISTS (
              SELECT 1 FROM tracking_events e
               WHERE e.session_id = customer_tracking_sessions.session_id
                 AND e.company_id = customer_tracking_sessions.company_id
                 AND e.created_at >= NOW() - ($3 || ' seconds')::interval
        )`,
    [companyId, String(VISIT_IDLE_MINUTES), String(ONLINE_SECONDS)],
  );
};

// Linhas do painel "Carrinhos abertos": UMA por pessoa, classificada em
//   • online    → cardápio aberto agora (heartbeat/atividade nos últimos
//                 ONLINE_SECONDS), mesmo que a pessoa esteja só olhando;
//   • abandoned → saiu com itens no carrinho e sem pedido (últimas 24h).
// A deduplicação é em dois níveis: primeiro por dispositivo (token sem o
// sufixo de arquivamento), depois por pessoa (cliente → telefone → dispositivo),
// mantendo sempre a visita mais recente. Assim uma visita antiga não reaparece
// quando a pessoa voltou, e quem comprou depois do abandono sai da lista.
const _panelRows = async (cid) => {
  const res = await pool.query(
    `WITH base AS (
       SELECT s.id, s.session_id, s.company_id, s.customer_id,
              s.customer_name, s.customer_phone,
              s.status, s.current_step,
              s.cart_items_count, s.subtotal,
              s.latitude, s.longitude, s.address,
              s.order_id, s.device_type,
              s.is_active, s.last_activity_at, s.created_at, s.updated_at,
              s.abandonment_notified_at,
              o.status AS order_status,
              o.delivery_type AS order_delivery_type,
              GREATEST(s.last_activity_at, COALESCE(hb.at, s.last_activity_at)) AS last_seen_at,
              split_part(s.session_id, '${ARCHIVE_SEPARATOR}', 1) AS device_key
         FROM customer_tracking_sessions s
         LEFT JOIN orders o ON o.id = s.order_id
         LEFT JOIN LATERAL (
           SELECT MAX(e.created_at) AS at
             FROM tracking_events e
            WHERE e.session_id = s.session_id
              AND e.company_id = s.company_id
              AND e.created_at >= NOW() - ($2 || ' seconds')::interval
         ) hb ON TRUE
        WHERE s.company_id = $1
          AND s.last_activity_at >= NOW() - ($3 || ' hours')::interval
     ),
     per_device AS (
       SELECT DISTINCT ON (device_key) *
         FROM base
        ORDER BY device_key, last_seen_at DESC, id DESC
     ),
     per_person AS (
       SELECT DISTINCT ON (COALESCE(customer_id::text, NULLIF(customer_phone, ''), device_key)) *
         FROM per_device
        ORDER BY COALESCE(customer_id::text, NULLIF(customer_phone, ''), device_key),
                 last_seen_at DESC, id DESC
     ),
     classified AS (
       SELECT *,
              CASE
                WHEN last_seen_at >= NOW() - ($2 || ' seconds')::interval
                THEN 'online'
                WHEN cart_items_count > 0 AND order_id IS NULL
                 AND status <> 'order_created'
                THEN 'abandoned'
              END AS presence
         FROM per_person
     )
     SELECT * FROM classified
      WHERE presence IS NOT NULL
      ORDER BY (presence = 'online') DESC, last_seen_at DESC
      LIMIT 300`,
    [cid, String(ONLINE_SECONDS), String(ABANDONED_LOOKBACK_HOURS)],
  );
  return res.rows.map(({ device_key, ...row }) => row);
};

// Lista o painel: pessoas navegando agora + carrinhos abandonados.
const listSessions = async (companyId) => {
  const cid = _int(companyId);
  if (!cid) return [];
  await _expireStale(cid);
  return _panelRows(cid);
};

const getSessionDetails = async (companyId, sessionId) => {
  const cid = _int(companyId);
  const sid = _str(sessionId, 64);
  if (!cid || !sid) return null;

  const res = await pool.query(
    `SELECT s.id, s.session_id, s.company_id, s.customer_id,
            s.customer_name, s.customer_phone, s.status, s.current_step,
            s.cart_items_count, s.subtotal, s.cart_items,
            s.latitude, s.longitude, s.address, s.order_id, s.device_type,
            s.is_active, s.last_activity_at, s.created_at, s.updated_at,
            s.abandonment_notified_at,
            o.status AS order_status
       FROM customer_tracking_sessions s
       LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.company_id = $1 AND s.session_id = $2
      LIMIT 1`,
    [cid, sid],
  );
  return res.rows[0] || null;
};

// Pontos do mapa: as mesmas pessoas do painel, só as que têm coordenadas.
// Pedidos de retirada (delivery_type = FALSE) não entram no mapa.
const listMapPoints = async (companyId) => {
  const rows = await listSessions(companyId);
  return rows.filter(
    (r) =>
      r.latitude != null &&
      r.longitude != null &&
      (r.order_id == null || r.order_delivery_type !== false),
  );
};

// Agrega as linhas do painel nos indicadores do topo.
const _buildMetrics = (rows) => {
  const online = rows.filter((r) => r.presence === "online");
  const abandoned = rows.filter((r) => r.presence === "abandoned");
  const sum = (list) => list.reduce((acc, r) => acc + (Number(r.subtotal) || 0), 0);
  const onlineCarts = online.filter((r) => r.cart_items_count > 0 && r.order_id == null);
  return {
    online: online.length,
    online_with_cart: onlineCarts.length,
    online_cart_value: sum(onlineCarts),
    abandoned_carts: abandoned.length,
    abandoned_value: sum(abandoned),
  };
};

// Métricas operacionais para o cabeçalho do painel.
const getMetrics = async (companyId) => {
  const cid = _int(companyId);
  if (!cid) return null;
  return _buildMetrics(await listSessions(cid));
};

const listSessionEvents = async (companyId, sessionId, limit = 50) => {
  const cid = _int(companyId);
  const sid = _str(sessionId, 64);
  if (!cid || !sid) return [];
  const res = await pool.query(
    `SELECT id, session_id, event_type, step, payload, created_at
       FROM tracking_events
      WHERE company_id = $1 AND session_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [cid, sid, Math.min(parseInt(limit) || 50, 200)],
  );
  return res.rows;
};

module.exports = {
  upsertSession,
  updateLocation,
  attachOrder,
  trackEvent,
  listSessions,
  getSessionDetails,
  listMapPoints,
  getMetrics,
  listSessionEvents,
  VISIT_IDLE_MINUTES,
  ONLINE_SECONDS,
  ARCHIVE_SEPARATOR,
  _testing: { rotationReason: _rotationReason, archivedSessionId: _archivedSessionId, buildMetrics: _buildMetrics },
};
