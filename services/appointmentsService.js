// Agenda do painel (Fase 3 do agendamento): visão por dia/semana, encaixe
// manual, remarcação pela loja (com revalidação do horário), "não compareceu",
// detalhes do agendamento no pedido e os atalhos usados pela IA de atendimento
// (n8n, via x-api-key).
//
// A loja não segue a antecedência mínima nem o limite de dias da agenda
// pública. Com `force` ela também pode encaixar fora da jornada do
// profissional — mas nunca sobre outro agendamento ativo.

const pool = require("../db");
const bookingService = require("./bookingService");
const identityService = require("./identityService");
const orderWebhookService = require("./orderWebhookService");
const { columnExists, tableExists } = require("../helpers/schema");
const { generateUniqueOrderTag } = require("../helpers/orderTag");
const { normalizePhone } = require("../helpers/phone");
const slots = require("../helpers/bookingSlots");

const {
  error: _error,
  ensureSchema: _ensureSchema,
  loadProfessionals: _loadProfessionals,
  loadAgenda: _loadAgenda,
  loadOpeningHours: _loadOpeningHours,
  computeSlots: _computeSlots,
  rangeFor: _rangeFor,
  resolveSlot: _resolveSlot,
  releaseHolds: _releaseHolds,
  cancelReleasedOrders: _cancelReleasedOrders,
  parseStartsAt: _parseStartsAt,
  durationFor: _durationFor,
  priceFor: _priceFor,
  ACTIVE_STATUSES,
  MAX_DAYS_PER_REQUEST,
} = bookingService._internal;

const MAX_AGENDA_DAYS = 31;
const NO_SHOW_REASON = "Cliente não compareceu";

const _company = async (companyId, db = pool) => {
  const company = await bookingService.loadCompanySettings(companyId, db);
  if (!company) throw _error(404, "Empresa não encontrada.");
  return company;
};

const _positiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Serviço para uso da LOJA: aceita serviço pausado (o agendamento já existe).
const _loadServiceAny = async (db, companyId, serviceId) => {
  const result = await db.query(
    `SELECT id, name, price, duration_minutes, buffer_minutes, price_type, image_url
     FROM menu_items
     WHERE id = $1 AND company_id = $2 AND item_type = 'service' AND deleted_at IS NULL`,
    [serviceId, companyId],
  );
  return result.rows[0] || null;
};

// Profissional para encaixe forçado: precisa ser da empresa, mas não
// necessariamente executar o serviço (o dono decide).
const _loadProfessionalForce = async (db, companyId, serviceId, professionalId) => {
  const result = await db.query(
    `SELECT p.id, p.name, p.photo_url, ps.price_override, ps.duration_override
     FROM professionals p
     LEFT JOIN professional_services ps ON ps.professional_id = p.id AND ps.menu_item_id = $2
     WHERE p.id = $3 AND p.company_id = $1
     FOR UPDATE OF p`,
    [companyId, serviceId, professionalId],
  );
  return result.rows[0] || null;
};

// Encaixe fora da jornada: só confere colisão com agendamentos ativos.
const _forcedSlot = async (db, { service, professional, startsAt, excludeAppointmentId = null }) => {
  const duration = _durationFor(service, professional);
  if (!duration) throw _error(400, "Defina a duração do serviço antes de agendar.");
  const endsAt = new Date(startsAt.getTime() + duration * 60000);
  const blockedUntil = new Date(endsAt.getTime() + (Number(service.buffer_minutes) || 0) * 60000);
  const clash = await db.query(
    `SELECT 1 FROM appointments
     WHERE professional_id = $1 AND status = ANY($2::text[])
       AND starts_at < $4 AND blocked_until > $3
       AND ($5::int IS NULL OR id <> $5)
     LIMIT 1`,
    [professional.id, ACTIVE_STATUSES, startsAt, blockedUntil, excludeAppointmentId],
  );
  if (clash.rows[0]) {
    throw _error(409, "Esse horário colide com outro agendamento do profissional.", "BOOKING_SLOT_TAKEN");
  }
  return { professional, slot: { time: null, startsAt, endsAt, blockedUntil } };
};

const _reminderResetSql = async () => {
  const [r24, r2] = await Promise.all([
    columnExists("appointments", "reminder_24h_sent_at"),
    columnExists("appointments", "reminder_2h_sent_at"),
  ]);
  return [r24 ? ", reminder_24h_sent_at = NULL" : "", r2 ? ", reminder_2h_sent_at = NULL" : ""].join("");
};

// ─── Agenda (dia/semana) ─────────────────────────────────────────────────────

const _dateRange = (company, from, to) => {
  const today = slots.localDate(new Date(), company.timezone);
  const first = slots.parseDate(from) ? String(from) : today;
  let last = slots.parseDate(to) ? String(to) : first;
  if (last < first) last = first;
  if (slots.addDays(first, MAX_AGENDA_DAYS - 1) < last) last = slots.addDays(first, MAX_AGENDA_DAYS - 1);
  return { first, last };
};

const _agendaAppointmentSelect = async () => {
  const hasCoupon = await columnExists("orders", "coupon_discount");
  return `
    SELECT a.id, a.order_id, a.status, a.starts_at, a.ends_at, a.blocked_until, a.hold_expires_at,
           a.professional_id, a.menu_item_id, a.rescheduled_count, a.cancel_reason,
           mi.name AS service_name, mi.image_url AS service_image_url,
           o.tag AS order_tag, o.uuid AS order_uuid, o.status AS order_status, o.total, o.service_fee,
           o.payment_provider, o.payment_status, o.online_payment_method, o.notes,
           ${hasCoupon ? "o.coupon_discount" : "0 AS coupon_discount"},
           pm.label AS payment_method_label,
           c.id AS client_id, c.name AS client_name, c.phone AS client_phone
    FROM appointments a
    JOIN orders o ON o.id = a.order_id
    JOIN clients c ON c.id = o.client_id
    LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id`;
};

/**
 * GET /appointments/company/:companyId?from&to — agenda do período (datas
 * locais inclusivas, até 31 dias): profissionais com jornada/folgas e os
 * agendamentos. Cancelados só com `include_cancelled=true`.
 */
const listAgenda = async (companyId, { from, to, includeCancelled = false } = {}) => {
  await _ensureSchema();
  const company = await _company(companyId);
  const { first, last } = _dateRange(company, from, to);
  const rangeStart = slots.zonedTimeToUtc(first, 0, company.timezone);
  const rangeEnd = slots.zonedTimeToUtc(slots.addDays(last, 1), 0, company.timezone);

  const statusFilter = includeCancelled ? "" : "AND a.status <> 'cancelled'";
  const appointmentsRes = await pool.query(
    `${await _agendaAppointmentSelect()}
     WHERE a.company_id = $1 AND a.starts_at < $3 AND a.blocked_until > $2 ${statusFilter}
     ORDER BY a.starts_at, a.id`,
    [company.id, rangeStart, rangeEnd],
  );
  const busyIds = [...new Set(appointmentsRes.rows.map((r) => Number(r.professional_id)))];

  const profRes = await pool.query(
    `SELECT p.id, p.name, p.photo_url, p.active,
            COALESCE((SELECT array_agg(ps.menu_item_id ORDER BY ps.menu_item_id)
                      FROM professional_services ps WHERE ps.professional_id = p.id), '{}') AS service_ids
     FROM professionals p
     WHERE p.company_id = $1 AND (p.active = TRUE OR p.id = ANY($2::int[]))
     ORDER BY p.active DESC, p.name, p.id`,
    [company.id, busyIds],
  );
  const ids = profRes.rows.map((p) => Number(p.id));
  const [hoursRes, offRes, openingHours] = await Promise.all([
    pool.query(
      `SELECT id, professional_id, weekday, start_time::text AS start_time, end_time::text AS end_time
       FROM professional_working_hours WHERE professional_id = ANY($1::int[])
       ORDER BY weekday, start_time`,
      [ids],
    ),
    pool.query(
      `SELECT id, professional_id, starts_at, ends_at, reason
       FROM professional_time_off
       WHERE professional_id = ANY($1::int[]) AND starts_at < $3 AND ends_at > $2
       ORDER BY starts_at`,
      [ids, rangeStart, rangeEnd],
    ),
    _loadOpeningHours(pool, company.id),
  ]);

  const byProf = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const k = Number(row.professional_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return map;
  };
  const hours = byProf(hoursRes.rows);
  const off = byProf(offRes.rows);

  return {
    timezone: company.timezone,
    from: first,
    to: last,
    step_minutes: company.step,
    opening_hours: openingHours,
    professionals: profRes.rows.map((p) => ({
      id: Number(p.id),
      name: p.name,
      photo_url: p.photo_url,
      active: p.active === true,
      service_ids: (p.service_ids || []).map(Number),
      working_hours: (hours.get(Number(p.id)) || []).map((h) => ({
        weekday: Number(h.weekday),
        start_time: h.start_time,
        end_time: h.end_time,
      })),
      time_off: (off.get(Number(p.id)) || []).map((t) => ({
        id: t.id,
        starts_at: t.starts_at,
        ends_at: t.ends_at,
        reason: t.reason,
      })),
    })),
    appointments: appointmentsRes.rows.map(_agendaRow),
  };
};

const _agendaRow = (r) => ({
  id: r.id,
  order_id: r.order_id,
  order_tag: r.order_tag,
  order_uuid: r.order_uuid,
  order_status: Number(r.order_status),
  status: r.status,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  blocked_until: r.blocked_until,
  hold_expires_at: r.hold_expires_at,
  professional_id: Number(r.professional_id),
  menu_item_id: r.menu_item_id != null ? Number(r.menu_item_id) : null,
  service_name: r.service_name,
  service_image_url: r.service_image_url,
  rescheduled_count: r.rescheduled_count,
  cancel_reason: r.cancel_reason,
  client_id: r.client_id,
  client_name: r.client_name,
  client_phone: r.client_phone,
  total: r.total != null ? Number(r.total) : null,
  service_fee: r.service_fee != null ? Number(r.service_fee) : 0,
  coupon_discount: r.coupon_discount != null ? Number(r.coupon_discount) : 0,
  payment_provider: r.payment_provider,
  payment_status: r.payment_status,
  online_payment_method: r.online_payment_method,
  payment_method_label: r.payment_method_label,
  notes: r.notes,
});

// ─── Horários livres para a loja ─────────────────────────────────────────────

/**
 * GET /appointments/company/:companyId/availability — como a disponibilidade
 * pública, mas sem antecedência mínima/limite de dias e ignorando o próprio
 * agendamento ao remarcar (`exclude_appointment_id`).
 */
const adminAvailability = async (companyId, { serviceId, professionalId, date, days, excludeAppointmentId }) => {
  await _ensureSchema();
  const company = await _company(companyId);
  const service = await _loadServiceAny(pool, company.id, serviceId);
  if (!service) throw _error(404, "Serviço não encontrado.");
  const onlyId = professionalId && professionalId !== "any" ? _positiveInt(professionalId) : null;
  if (professionalId && professionalId !== "any" && !onlyId) throw _error(400, "Profissional inválido.");
  const professionals = await _loadProfessionals(pool, company.id, service.id, { onlyId });

  const today = slots.localDate(new Date(), company.timezone);
  const first = slots.parseDate(date) ? String(date) : today;
  const count = Math.min(MAX_DAYS_PER_REQUEST, Math.max(1, Number(days) || 1));
  const dates = Array.from({ length: count }, (_, i) => slots.addDays(first, i));

  const response = {
    timezone: company.timezone,
    today,
    service: {
      id: Number(service.id),
      name: service.name,
      duration_minutes: Number(service.duration_minutes) || null,
      buffer_minutes: Number(service.buffer_minutes) || 0,
      price: Number(service.price ?? 0),
    },
    professionals: professionals.map((p) => ({
      id: Number(p.id),
      name: p.name,
      photo_url: p.photo_url,
      price: _priceFor(service, p),
      duration_minutes: _durationFor(service, p),
    })),
    days: dates.map((d) => ({ date: d, weekday: slots.weekdayOf(d), slots: [] })),
  };
  if (!professionals.length) return response;

  const { from, to } = _rangeFor(company, dates[0], dates[dates.length - 1]);
  const [agenda, openingHours] = await Promise.all([
    _loadAgenda(pool, professionals.map((p) => Number(p.id)), from, to, {
      excludeAppointmentId: _positiveInt(excludeAppointmentId),
    }),
    _loadOpeningHours(pool, company.id),
  ]);
  const byDate = _computeSlots({ company, service, professionals, agenda, openingHours, dates, earliest: null });
  response.days = dates.map((d) => ({
    date: d,
    weekday: slots.weekdayOf(d),
    slots: [...byDate.get(d).values()]
      .sort((a, b) => a.startsAt - b.startsAt)
      .map((s) => ({
        time: s.time,
        starts_at: s.startsAt.toISOString(),
        ends_at: s.endsAt.toISOString(),
        professional_ids: s.professionals.map((x) => Number(x.professional.id)),
      })),
  }));
  return response;
};

// ─── Remarcação / troca de profissional pela loja ────────────────────────────

/**
 * PATCH /appointments/:id/reschedule — `starts_at` e/ou `professional_id`.
 * Revalida o horário no servidor (jornada, folgas, colisões). `force` aceita
 * horário fora da jornada desde que não colida com outro agendamento.
 */
const rescheduleByStore = async (appointmentId, { startsAt: rawStartsAt, professionalId, force = false, notify = true }) => {
  await _ensureSchema();
  const id = _positiveInt(appointmentId);
  if (!id) throw _error(400, "Agendamento inválido.");

  const client = await pool.connect();
  let releasedOrders = [];
  let current;
  let chosen;
  try {
    await client.query("BEGIN");
    current = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!current) throw _error(404, "Agendamento não encontrado.");
    if (!ACTIVE_STATUSES.includes(current.status)) {
      throw _error(409, "Só é possível remarcar agendamentos ativos.");
    }
    const startsAt = rawStartsAt ? _parseStartsAt(rawStartsAt) : new Date(current.starts_at);
    const wanted = professionalId != null && professionalId !== "" ? _positiveInt(professionalId) : Number(current.professional_id);
    if (!wanted) throw _error(400, "Profissional inválido.");

    const company = await _company(current.company_id, client);
    const service = current.menu_item_id ? await _loadServiceAny(client, company.id, current.menu_item_id) : null;
    if (!service) throw _error(409, "O serviço deste agendamento não existe mais.");

    if (force) {
      const professional = await _loadProfessionalForce(client, company.id, service.id, wanted);
      if (!professional) throw _error(404, "Profissional não encontrado.");
      releasedOrders = await _releaseHolds(client, [wanted]);
      chosen = await _forcedSlot(client, { service, professional, startsAt, excludeAppointmentId: id });
    } else {
      const professionals = await _loadProfessionals(client, company.id, service.id, { lock: true, onlyId: wanted });
      if (!professionals.length) throw _error(409, "Esse profissional não executa este serviço.");
      releasedOrders = await _releaseHolds(client, [wanted]);
      chosen = await _resolveSlot(client, {
        company,
        service,
        professionals,
        startsAt,
        excludeAppointmentId: id,
        admin: true,
      });
    }

    const moved = new Date(current.starts_at).getTime() !== chosen.slot.startsAt.getTime();
    await client.query(
      `UPDATE appointments
       SET professional_id = $2, starts_at = $3, ends_at = $4, blocked_until = $5,
           rescheduled_count = rescheduled_count + $6, updated_at = NOW()${moved ? await _reminderResetSql() : ""}
       WHERE id = $1`,
      [id, chosen.professional.id, chosen.slot.startsAt, chosen.slot.endsAt, chosen.slot.blockedUntil, moved ? 1 : 0],
    );
    await client.query("UPDATE orders SET scheduled_for = $2, updated_at = NOW() WHERE id = $1", [
      current.order_id,
      chosen.slot.startsAt,
    ]);
    if (current.order_item_id) {
      await client.query("UPDATE order_items SET notes = $2 WHERE id = $1", [
        current.order_item_id,
        `Profissional: ${chosen.professional.name}`,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23P01") {
      throw _error(409, "Esse horário colide com outro agendamento do profissional.", "BOOKING_SLOT_TAKEN");
    }
    throw err;
  } finally {
    client.release();
  }
  _cancelReleasedOrders(releasedOrders);
  if (notify) orderWebhookService.notifyAppointmentEvent(current.order_id, "rescheduled");
  return getOrderAppointment(current.order_id);
};

// ─── Encaixe manual (painel) ─────────────────────────────────────────────────

const _resolveClient = async (companyId, data) => {
  const clientId = _positiveInt(data.client_id);
  if (clientId) {
    const found = await pool.query("SELECT id FROM clients WHERE id = $1 AND company_id = $2", [clientId, companyId]);
    if (!found.rows[0]) throw _error(404, "Cliente não encontrado.");
    return clientId;
  }
  const info = data.client || {};
  const name = String(info.name ?? data.client_name ?? "").trim();
  const phone = String(info.phone ?? data.phone ?? "").trim();
  if (phone) {
    if (!normalizePhone(phone)) throw _error(400, "Telefone do cliente inválido.");
    const { client } = await identityService.resolveClientByPhone({ companyId, phone, name: name || null });
    return Number(client.id);
  }
  if (!name) throw _error(400, "Informe o cliente do agendamento.");
  const created = await pool.query(
    "INSERT INTO clients (company_id, name, phone) VALUES ($1, $2, NULL) RETURNING id",
    [companyId, name],
  );
  return Number(created.rows[0].id);
};

/**
 * POST /appointments — encaixe criado pela loja (pagamento no local). Já nasce
 * Confirmado: pedido em 2 e agendamento 'confirmed'.
 */
const createManualBooking = async (data) => {
  await _ensureSchema();
  const companyId = _positiveInt(data.company_id);
  const serviceId = _positiveInt(data.menu_item_id);
  const professionalId = _positiveInt(data.professional_id);
  if (!companyId || !serviceId || !professionalId) {
    throw _error(400, "Escolha o serviço, o profissional e o horário.");
  }
  const startsAt = _parseStartsAt(data.starts_at);
  const force = data.force === true;
  const notes = data.notes ? String(data.notes).trim().slice(0, 500) || null : null;

  let paymentMethodId = null;
  if (data.payment_method_id != null && data.payment_method_id !== "") {
    paymentMethodId = _positiveInt(data.payment_method_id);
    const method = paymentMethodId
      ? await pool.query("SELECT 1 FROM payment_methods WHERE id = $1 AND company_id = $2", [paymentMethodId, companyId])
      : { rows: [] };
    if (!method.rows[0]) throw _error(400, "Forma de pagamento inválida.");
  }

  const company = await _company(companyId);
  const clientId = await _resolveClient(companyId, data);

  const db = await pool.connect();
  let releasedOrders = [];
  let orderId;
  try {
    await db.query("BEGIN");
    const service = await _loadServiceAny(db, companyId, serviceId);
    if (!service) throw _error(404, "Serviço não encontrado.");

    let chosen;
    if (force) {
      const professional = await _loadProfessionalForce(db, companyId, serviceId, professionalId);
      if (!professional) throw _error(404, "Profissional não encontrado.");
      releasedOrders = await _releaseHolds(db, [professionalId]);
      chosen = await _forcedSlot(db, { service, professional, startsAt });
    } else {
      const professionals = await _loadProfessionals(db, companyId, serviceId, { lock: true, onlyId: professionalId });
      if (!professionals.length) throw _error(409, "Esse profissional não executa este serviço.");
      releasedOrders = await _releaseHolds(db, [professionalId]);
      chosen = await _resolveSlot(db, { company, service, professionals, startsAt, admin: true });
    }
    const professional = chosen.professional;

    let unitPrice = _priceFor(service, professional);
    if (data.price != null && data.price !== "" && Number.isFinite(Number(data.price)) && Number(data.price) >= 0) {
      unitPrice = Number(data.price);
    }
    unitPrice = Number(unitPrice.toFixed(2));
    const tag = await generateUniqueOrderTag(db);
    const orderRes = await db.query(
      `INSERT INTO orders (
         company_id, client_id, status, notes, subtotal, delivery_fee, discount, total,
         payment_method_id, delivery_address, delivery_type, scheduled_for, tag
       )
       VALUES ($1, $2, 2, $3, $4, 0, 0, $4, $5, NULL, FALSE, $6, $7)
       RETURNING *`,
      [companyId, clientId, notes, unitPrice, paymentMethodId, chosen.slot.startsAt, tag],
    );
    const order = orderRes.rows[0];
    orderId = order.id;
    const itemRes = await db.query(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal, notes)
       VALUES ($1, $2, $3, 1, $4, $4, $5) RETURNING id`,
      [order.id, service.id, service.name, unitPrice, `Profissional: ${professional.name}`],
    );
    await db.query(
      `INSERT INTO appointments (
         company_id, order_id, order_item_id, menu_item_id, professional_id,
         starts_at, ends_at, blocked_until, status, location_type
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', 'on_site')`,
      [
        companyId,
        order.id,
        itemRes.rows[0].id,
        service.id,
        professional.id,
        chosen.slot.startsAt,
        chosen.slot.endsAt,
        chosen.slot.blockedUntil,
      ],
    );
    await db.query("INSERT INTO order_status_history (order_id, status, notes) VALUES ($1, '2', $2)", [
      order.id,
      "Agendamento criado pela loja",
    ]);
    await db.query("COMMIT");
    if (data.notify_customer !== false) orderWebhookService.notifyStatusChange(order, 2);
  } catch (err) {
    await db.query("ROLLBACK");
    if (err.code === "23P01") {
      throw _error(409, "Esse horário colide com outro agendamento do profissional.", "BOOKING_SLOT_TAKEN");
    }
    throw err;
  } finally {
    db.release();
  }
  _cancelReleasedOrders(releasedOrders);
  const ordersService = require("./ordersService");
  return ordersService.find(orderId);
};

// ─── Não compareceu ──────────────────────────────────────────────────────────

/** PATCH /orders/:id/no-show — cancela o pedido e marca o agendamento como no-show. */
const markNoShow = async (orderId) => {
  await _ensureSchema();
  const appointment = (
    await pool.query("SELECT status FROM appointments WHERE order_id = $1 ORDER BY id DESC LIMIT 1", [orderId])
  ).rows[0];
  if (!appointment) throw _error(404, "Este pedido não tem agendamento.");
  if (!["confirmed", "in_progress", "hold"].includes(appointment.status)) {
    throw _error(409, "Este agendamento já foi encerrado.");
  }
  const ordersService = require("./ordersService");
  const order = await ordersService.updateStatus(orderId, 6, NO_SHOW_REASON, { appointmentStatus: "no_show" });
  if (!order) throw _error(404, "Pedido não encontrado.");
  return ordersService.find(orderId);
};

// ─── Detalhes do agendamento de um pedido ────────────────────────────────────

/**
 * GET /orders/:id/appointment — agendamento + fotos do serviço + profissionais
 * que podem assumir + histórico do cliente (comparecimentos e no-shows).
 */
const getOrderAppointment = async (orderId) => {
  if (!(await tableExists("appointments"))) return null;
  const row = (
    await pool.query(
      `SELECT a.*, mi.name AS service_name, mi.image_url AS service_image_url, mi.description AS service_description,
              mi.duration_minutes, mi.price AS service_price,
              p.name AS professional_name, p.photo_url AS professional_photo_url, p.phone AS professional_phone,
              o.client_id
       FROM appointments a
       JOIN orders o ON o.id = a.order_id
       LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
       LEFT JOIN professionals p ON p.id = a.professional_id
       WHERE a.order_id = $1
       ORDER BY a.id DESC LIMIT 1`,
      [orderId],
    )
  ).rows[0];
  if (!row) return null;
  const company = await bookingService.loadCompanySettings(row.company_id);

  const [images, professionals, stats, history] = await Promise.all([
    (async () => {
      if (!row.menu_item_id || !(await tableExists("menu_item_images"))) return [];
      const res = await pool.query(
        "SELECT url FROM menu_item_images WHERE menu_item_id = $1 ORDER BY position, id",
        [row.menu_item_id],
      );
      return res.rows.map((r) => r.url);
    })(),
    row.menu_item_id
      ? pool.query(
          `SELECT p.id, p.name, p.photo_url, ps.price_override, ps.duration_override
           FROM professional_services ps JOIN professionals p ON p.id = ps.professional_id
           WHERE ps.menu_item_id = $1 AND p.company_id = $2 AND p.active = TRUE
           ORDER BY p.name`,
          [row.menu_item_id, row.company_id],
        )
      : { rows: [] },
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'done')::int AS done,
              COUNT(*) FILTER (WHERE a.status = 'no_show')::int AS no_show,
              COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
              MAX(a.starts_at) FILTER (WHERE a.status = 'done') AS last_visit_at
       FROM appointments a JOIN orders o ON o.id = a.order_id
       WHERE o.client_id = $1 AND a.company_id = $2`,
      [row.client_id, row.company_id],
    ),
    pool.query(
      `SELECT a.id, a.order_id, a.status, a.starts_at, mi.name AS service_name, p.name AS professional_name
       FROM appointments a JOIN orders o ON o.id = a.order_id
       LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
       LEFT JOIN professionals p ON p.id = a.professional_id
       WHERE o.client_id = $1 AND a.company_id = $2 AND a.order_id <> $3
       ORDER BY a.starts_at DESC LIMIT 6`,
      [row.client_id, row.company_id, orderId],
    ),
  ]);

  const coverUrl = row.service_image_url;
  const gallery = images.length ? images : coverUrl ? [coverUrl] : [];
  return {
    id: row.id,
    order_id: row.order_id,
    status: row.status,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    blocked_until: row.blocked_until,
    hold_expires_at: row.hold_expires_at,
    rescheduled_count: row.rescheduled_count,
    cancel_reason: row.cancel_reason,
    cancelled_at: row.cancelled_at,
    timezone: company?.timezone || slots.DEFAULT_TIMEZONE,
    service: row.menu_item_id
      ? {
          id: Number(row.menu_item_id),
          name: row.service_name,
          description: row.service_description,
          duration_minutes: row.duration_minutes != null ? Number(row.duration_minutes) : null,
          price: row.service_price != null ? Number(row.service_price) : null,
          images: gallery,
        }
      : null,
    professional: {
      id: Number(row.professional_id),
      name: row.professional_name,
      photo_url: row.professional_photo_url,
      phone: row.professional_phone,
    },
    eligible_professionals: professionals.rows.map((p) => ({
      id: Number(p.id),
      name: p.name,
      photo_url: p.photo_url,
    })),
    client_stats: stats.rows[0] || { total: 0, done: 0, no_show: 0, cancelled: 0, last_visit_at: null },
    client_history: history.rows,
  };
};

// ─── IA de atendimento (n8n via x-api-key) ───────────────────────────────────

/** Catálogo de serviços com profissionais, preço e duração (para a IA ofertar). */
const listServicesForAi = async (companyId) => {
  await _ensureSchema();
  const company = await _company(companyId);
  const services = await pool.query(
    `SELECT id, name, description, price, price_type, duration_minutes
     FROM menu_items
     WHERE company_id = $1 AND item_type = 'service' AND available = TRUE AND deleted_at IS NULL
     ORDER BY name`,
    [company.id],
  );
  const links = await pool.query(
    `SELECT ps.menu_item_id, p.id, p.name, ps.price_override, ps.duration_override
     FROM professional_services ps JOIN professionals p ON p.id = ps.professional_id
     WHERE p.company_id = $1 AND p.active = TRUE
     ORDER BY p.name`,
    [company.id],
  );
  return {
    timezone: company.timezone,
    min_notice_minutes: company.notice,
    max_days_ahead: company.maxDays,
    cancel_window_hours: company.cancelWindow,
    services: services.rows.map((s) => ({
      id: Number(s.id),
      name: s.name,
      description: s.description,
      price: Number(s.price ?? 0),
      price_type: s.price_type || "fixed",
      duration_minutes: s.duration_minutes != null ? Number(s.duration_minutes) : null,
      professionals: links.rows
        .filter((l) => Number(l.menu_item_id) === Number(s.id))
        .map((l) => ({
          id: Number(l.id),
          name: l.name,
          price: _priceFor(s, l),
          duration_minutes: _durationFor(s, l),
        })),
    })),
  };
};

const _clientIdsByPhone = async (companyId, phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) throw _error(400, "Telefone inválido.");
  const local = normalized.slice(2);
  const res = await pool.query(
    `SELECT id FROM clients
     WHERE company_id = $1 AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') IN ($2, $3)`,
    [companyId, normalized, local],
  );
  return res.rows.map((r) => Number(r.id));
};

/** Próximos agendamentos ativos de um telefone (para a IA confirmar/remarcar). */
const upcomingForPhone = async (companyId, phone) => {
  await _ensureSchema();
  const company = await _company(companyId);
  const clientIds = await _clientIdsByPhone(company.id, phone);
  if (!clientIds.length) return { timezone: company.timezone, appointments: [] };
  const res = await pool.query(
    `${await _agendaAppointmentSelect()}
     WHERE a.company_id = $1 AND o.client_id = ANY($2::int[])
       AND a.status = ANY($3::text[]) AND a.ends_at > NOW()
     ORDER BY a.starts_at`,
    [company.id, clientIds, ACTIVE_STATUSES],
  );
  return { timezone: company.timezone, appointments: res.rows.map(_agendaRow) };
};

/**
 * POST /n8n/bookings — a IA agenda pelo WhatsApp seguindo as MESMAS regras do
 * site (antecedência, janela, jornada). Pagamento no local; sem
 * `payment_method_id` usa a primeira forma de pagamento ativa da loja.
 */
const createBookingForAi = async (data) => {
  await _ensureSchema();
  const companyId = _positiveInt(data.company_id);
  if (!companyId) throw _error(400, "company_id inválido.");
  const phone = String(data.phone ?? "").trim();
  let clientId = _positiveInt(data.client_id);
  if (!clientId) {
    if (!phone || !normalizePhone(phone)) throw _error(400, "Informe o telefone do cliente.");
    const name = data.name ? String(data.name).trim() : null;
    const { client } = await identityService.resolveClientByPhone({ companyId, phone, name });
    clientId = Number(client.id);
  }
  let paymentMethodId = _positiveInt(data.payment_method_id);
  if (!paymentMethodId) {
    const method = await pool.query(
      "SELECT id FROM payment_methods WHERE company_id = $1 AND active = TRUE ORDER BY id LIMIT 1",
      [companyId],
    );
    paymentMethodId = method.rows[0]?.id ?? null;
    if (!paymentMethodId) throw _error(400, "A loja não tem forma de pagamento ativa.");
  }
  return bookingService.createBookingOrder({
    company_id: companyId,
    client_id: clientId,
    payment_method_id: paymentMethodId,
    notes: data.notes,
    coupon_code: data.coupon_code,
    booking: {
      menu_item_id: data.menu_item_id,
      professional_id: data.professional_id ?? "any",
      starts_at: data.starts_at,
    },
  });
};

module.exports = {
  NO_SHOW_REASON,
  listAgenda,
  adminAvailability,
  rescheduleByStore,
  createManualBooking,
  markNoShow,
  getOrderAppointment,
  listServicesForAi,
  upcomingForPhone,
  createBookingForAi,
};
