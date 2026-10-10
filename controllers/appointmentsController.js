const service = require("../services/appointmentsService");

const _fail = (res, error, fallback) => {
  if (!error.status || error.status >= 500) console.error(`${fallback}:`, error);
  return res
    .status(error.status || 500)
    .json({ error: error.status ? error.message : fallback, ...(error.code ? { code: error.code } : {}) });
};

const _validId = (value) => /^\d+$/.test(String(value ?? ""));

// GET /appointments/company/:companyId?from=YYYY-MM-DD&to=YYYY-MM-DD&include_cancelled=true
const listAgenda = async (req, res) => {
  const { companyId } = req.params;
  if (!_validId(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.listAgenda(companyId, {
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null,
      includeCancelled: String(req.query.include_cancelled || "") === "true",
    });
    return res.status(200).json(data);
  } catch (error) {
    return _fail(res, error, "Failed to fetch agenda");
  }
};

// GET /appointments/company/:companyId/availability?service_id&professional_id&date&days&exclude_appointment_id
const availability = async (req, res) => {
  const { companyId } = req.params;
  if (!_validId(companyId) || !_validId(req.query.service_id)) {
    return res.status(400).json({ error: "Serviço inválido." });
  }
  try {
    const data = await service.adminAvailability(companyId, {
      serviceId: Number(req.query.service_id),
      professionalId: req.query.professional_id ? String(req.query.professional_id) : null,
      date: req.query.date ? String(req.query.date) : null,
      days: req.query.days,
      excludeAppointmentId: req.query.exclude_appointment_id,
    });
    return res.status(200).json(data);
  } catch (error) {
    return _fail(res, error, "Failed to fetch availability");
  }
};

// POST /appointments — encaixe manual pela loja
const create = async (req, res) => {
  try {
    return res.status(201).json(await service.createManualBooking(req.body || {}));
  } catch (error) {
    return _fail(res, error, "Failed to create appointment");
  }
};

// PATCH /appointments/:id/reschedule { starts_at?, professional_id?, force? }
const reschedule = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  const { starts_at, professional_id, force, notify } = req.body || {};
  if (!starts_at && (professional_id == null || professional_id === "")) {
    return res.status(400).json({ error: "Informe o novo horário ou profissional." });
  }
  try {
    const data = await service.rescheduleByStore(id, {
      startsAt: starts_at || null,
      professionalId: professional_id ?? null,
      force: force === true,
      notify: notify !== false,
    });
    return res.status(200).json(data);
  } catch (error) {
    return _fail(res, error, "Failed to reschedule appointment");
  }
};

// GET /orders/:id/appointment
const findByOrder = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const data = await service.getOrderAppointment(Number(id));
    if (!data) return res.status(404).json({ error: "Este pedido não tem agendamento." });
    return res.status(200).json(data);
  } catch (error) {
    return _fail(res, error, "Failed to fetch appointment");
  }
};

// PATCH /orders/:id/no-show
const noShow = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    return res.status(200).json(await service.markNoShow(Number(id)));
  } catch (error) {
    return _fail(res, error, "Failed to mark no-show");
  }
};

// ─── n8n / IA de atendimento (x-api-key) ─────────────────────────────────────

// GET /n8n/company/:companyId/services
const aiServices = async (req, res) => {
  const { companyId } = req.params;
  if (!_validId(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    return res.status(200).json(await service.listServicesForAi(companyId));
  } catch (error) {
    return _fail(res, error, "Failed to fetch services");
  }
};

// GET /n8n/company/:companyId/appointments?phone=
const aiUpcoming = async (req, res) => {
  const { companyId } = req.params;
  if (!_validId(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  if (!req.query.phone) return res.status(400).json({ error: "Informe o telefone." });
  try {
    return res.status(200).json(await service.upcomingForPhone(companyId, String(req.query.phone)));
  } catch (error) {
    return _fail(res, error, "Failed to fetch appointments");
  }
};

// POST /n8n/bookings
const aiCreateBooking = async (req, res) => {
  const body = req.body || {};
  if (!_validId(body.company_id) || !_validId(body.menu_item_id) || !body.starts_at) {
    return res.status(400).json({ error: "company_id, menu_item_id e starts_at são obrigatórios." });
  }
  try {
    return res.status(201).json(await service.createBookingForAi(body));
  } catch (error) {
    return _fail(res, error, "Failed to create booking");
  }
};

module.exports = {
  listAgenda,
  availability,
  create,
  reschedule,
  findByOrder,
  noShow,
  aiServices,
  aiUpcoming,
  aiCreateBooking,
};
