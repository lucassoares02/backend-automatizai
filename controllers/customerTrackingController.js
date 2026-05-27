const tracking = require("../services/customerTrackingService");

// ─── Público (fire-and-forget) ───────────────────────────────────────────────
const upsertSession = async (req, res) => {
  res.status(202).json({ ok: true });
  try {
    await tracking.upsertSession({
      ...req.body,
      user_agent: req.headers["user-agent"],
    });
  } catch (err) {
    console.error("tracking.upsert error:", err.message);
  }
};

const updateLocation = async (req, res) => {
  res.status(202).json({ ok: true });
  try {
    await tracking.updateLocation(req.body);
  } catch (err) {
    console.error("tracking.updateLocation error:", err.message);
  }
};

const attachOrder = async (req, res) => {
  res.status(202).json({ ok: true });
  try {
    await tracking.attachOrder(req.body);
  } catch (err) {
    console.error("tracking.attachOrder error:", err.message);
  }
};

const trackEvent = async (req, res) => {
  res.status(202).json({ ok: true });
  try {
    await tracking.trackEvent(req.body);
  } catch (err) {
    console.error("tracking.event error:", err.message);
  }
};

// ─── Admin (com auth) ────────────────────────────────────────────────────────
const listSessions = async (req, res) => {
  try {
    const data = await tracking.listSessions(req.params.companyId, {
      include_finished: req.query.include_finished !== "false",
      since_minutes: req.query.since_minutes,
    });
    res.json(data);
  } catch (err) {
    console.error("tracking.listSessions error:", err.message);
    res.status(500).json({ error: "Erro ao listar sessões" });
  }
};

const listMapPoints = async (req, res) => {
  try {
    const data = await tracking.listMapPoints(req.params.companyId);
    res.json(data);
  } catch (err) {
    console.error("tracking.listMapPoints error:", err.message);
    res.status(500).json({ error: "Erro ao listar pontos do mapa" });
  }
};

const getMetrics = async (req, res) => {
  try {
    const data = await tracking.getMetrics(req.params.companyId);
    res.json(data || {});
  } catch (err) {
    console.error("tracking.metrics error:", err.message);
    res.status(500).json({ error: "Erro ao obter métricas" });
  }
};

const listSessionEvents = async (req, res) => {
  try {
    const data = await tracking.listSessionEvents(
      req.params.companyId,
      req.params.sessionId,
      req.query.limit,
    );
    res.json(data);
  } catch (err) {
    console.error("tracking.events error:", err.message);
    res.status(500).json({ error: "Erro ao listar eventos" });
  }
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
