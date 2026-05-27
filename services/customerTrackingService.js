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
  "success",
  "tracking",
  "history",
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

// Upsert da sessão. Idempotente — o cliente reenvia o estado completo a cada
// transição relevante e o backend atualiza por (company_id, session_id).
const upsertSession = async (payload) => {
  const companyId = _int(payload?.company_id);
  const sessionId = _str(payload?.session_id, 64);
  if (!companyId || !sessionId) return null;

  const status = VALID_STATUSES.has(payload?.status) ? payload.status : "browsing";
  const step = VALID_STEPS.has(payload?.current_step) ? payload.current_step : "menu";

  const params = [
    sessionId,
    companyId,
    _int(payload?.customer_id),
    _str(payload?.customer_name, 150),
    _str(payload?.customer_phone, 40),
    status,
    step,
    Math.max(0, parseInt(payload?.cart_items_count) || 0),
    Math.max(0, _num(payload?.subtotal) ?? 0),
    _num(payload?.latitude),
    _num(payload?.longitude),
    _str(payload?.address, 500),
    _int(payload?.order_id),
    _str(payload?.device_type, 30) || "web",
    _str(payload?.user_agent, 500),
  ];

  const res = await pool.query(
    `INSERT INTO customer_tracking_sessions
       (session_id, company_id, customer_id, customer_name, customer_phone,
        status, current_step, cart_items_count, subtotal,
        latitude, longitude, address, order_id,
        device_type, user_agent,
        is_active, last_activity_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             TRUE, NOW(), NOW(), NOW())
     ON CONFLICT (company_id, session_id) DO UPDATE SET
       customer_id      = COALESCE(EXCLUDED.customer_id, customer_tracking_sessions.customer_id),
       customer_name    = COALESCE(EXCLUDED.customer_name, customer_tracking_sessions.customer_name),
       customer_phone   = COALESCE(EXCLUDED.customer_phone, customer_tracking_sessions.customer_phone),
       status           = EXCLUDED.status,
       current_step     = EXCLUDED.current_step,
       cart_items_count = EXCLUDED.cart_items_count,
       subtotal         = EXCLUDED.subtotal,
       latitude         = COALESCE(EXCLUDED.latitude, customer_tracking_sessions.latitude),
       longitude        = COALESCE(EXCLUDED.longitude, customer_tracking_sessions.longitude),
       address          = COALESCE(EXCLUDED.address, customer_tracking_sessions.address),
       order_id         = COALESCE(EXCLUDED.order_id, customer_tracking_sessions.order_id),
       device_type      = COALESCE(EXCLUDED.device_type, customer_tracking_sessions.device_type),
       user_agent       = COALESCE(EXCLUDED.user_agent, customer_tracking_sessions.user_agent),
       is_active        = TRUE,
       last_activity_at = NOW(),
       updated_at       = NOW()
     RETURNING id, session_id, company_id, status, current_step, last_activity_at`,
    params,
  );

  return res.rows[0] || null;
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

// Marca a sessão como finalizada por order_id.
const attachOrder = async (payload) => {
  const companyId = _int(payload?.company_id);
  const sessionId = _str(payload?.session_id, 64);
  const orderId = _int(payload?.order_id);
  if (!companyId || !sessionId || !orderId) return null;

  const res = await pool.query(
    `UPDATE customer_tracking_sessions
        SET order_id         = $3,
            status           = 'order_created',
            current_step     = 'success',
            is_active        = TRUE,
            last_activity_at = NOW(),
            updated_at       = NOW()
      WHERE company_id = $1 AND session_id = $2
      RETURNING id`,
    [companyId, sessionId, orderId],
  );
  return res.rows[0] || null;
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

// Expira sessões inativas há mais de 30 min.
const _expireStale = async (companyId) => {
  await pool.query(
    `UPDATE customer_tracking_sessions
        SET is_active = FALSE,
            status    = CASE WHEN status NOT IN ('order_created','abandoned')
                              THEN 'abandoned' ELSE status END,
            updated_at = NOW()
      WHERE company_id = $1
        AND is_active = TRUE
        AND last_activity_at < NOW() - INTERVAL '30 minutes'`,
    [companyId],
  );
};

// Lista sessões ativas e finalizadas-recentes para o painel.
const listSessions = async (companyId, opts = {}) => {
  const cid = _int(companyId);
  if (!cid) return [];
  await _expireStale(cid);

  const includeFinished = opts.include_finished !== false;
  const sinceMinutes = parseInt(opts.since_minutes) || 120;

  const res = await pool.query(
    `SELECT s.id, s.session_id, s.company_id, s.customer_id,
            s.customer_name, s.customer_phone,
            s.status, s.current_step,
            s.cart_items_count, s.subtotal,
            s.latitude, s.longitude, s.address,
            s.order_id, s.device_type,
            s.is_active, s.last_activity_at, s.created_at, s.updated_at,
            o.status AS order_status
       FROM customer_tracking_sessions s
       LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.company_id = $1
        AND (
              s.is_active = TRUE
           OR ($2::boolean AND s.last_activity_at >= NOW() - ($3 || ' minutes')::interval)
        )
      ORDER BY s.last_activity_at DESC
      LIMIT 300`,
    [cid, includeFinished, sinceMinutes],
  );
  return res.rows;
};

// Sessões com coordenadas (para o mapa). Pedidos de retirada (delivery_type =
// 'pickup') são excluídos do mapa — eles não têm coordenadas relevantes para
// rastreio geográfico.
const listMapPoints = async (companyId) => {
  const cid = _int(companyId);
  if (!cid) return [];
  await _expireStale(cid);

  const res = await pool.query(
    `SELECT s.id, s.session_id, s.customer_name, s.customer_phone,
            s.status, s.current_step,
            s.cart_items_count, s.subtotal,
            s.latitude, s.longitude, s.address,
            s.order_id, s.last_activity_at, s.created_at,
            o.status AS order_status,
            o.delivery_type AS order_delivery_type
       FROM customer_tracking_sessions s
       LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.company_id = $1
        AND s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (s.order_id IS NULL OR COALESCE(o.delivery_type, TRUE) = TRUE)
        AND (
              s.is_active = TRUE
           OR s.last_activity_at >= NOW() - INTERVAL '2 hours'
        )
      ORDER BY s.last_activity_at DESC
      LIMIT 500`,
    [cid],
  );
  return res.rows;
};

// Métricas operacionais para o cabeçalho do mapa.
const getMetrics = async (companyId) => {
  const cid = _int(companyId);
  if (!cid) return null;
  await _expireStale(cid);

  const res = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active AND status IN ('browsing','selecting_products')) AS browsing,
       COUNT(*) FILTER (WHERE is_active AND status IN ('cart','checkout','address_filled','payment_selection')) AS in_checkout,
       COUNT(*) FILTER (WHERE status = 'order_created'
                         AND last_activity_at >= NOW() - INTERVAL '24 hours') AS completed_today,
       COUNT(*) FILTER (WHERE NOT is_active
                         AND status = 'abandoned'
                         AND cart_items_count > 0
                         AND last_activity_at >= NOW() - INTERVAL '24 hours') AS abandoned_carts,
       COUNT(*) FILTER (WHERE is_active) AS active_total,
       COALESCE(SUM(subtotal) FILTER (WHERE is_active AND status NOT IN ('order_created','abandoned')), 0) AS pipeline_value
     FROM customer_tracking_sessions
     WHERE company_id = $1`,
    [cid],
  );
  const row = res.rows[0] || {};
  return {
    browsing: parseInt(row.browsing) || 0,
    in_checkout: parseInt(row.in_checkout) || 0,
    completed_today: parseInt(row.completed_today) || 0,
    abandoned_carts: parseInt(row.abandoned_carts) || 0,
    active_total: parseInt(row.active_total) || 0,
    pipeline_value: Number(row.pipeline_value) || 0,
  };
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
  listMapPoints,
  getMetrics,
  listSessionEvents,
};
