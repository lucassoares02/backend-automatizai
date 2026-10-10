// Agendamento de serviços (Fase 2): horários livres, criação do pedido de
// serviço com reserva do horário, confirmação pelo pagamento, cancelamento e
// remarcação pelo cliente e liberação de reservas vencidas.
//
// Um pedido de serviço reaproveita orders/order_items/pagamento: o horário fica
// em `appointments` (1 por pedido no MVP) e também em orders.scheduled_for,
// para as telas atuais de pedidos já mostrarem o agendamento.

const pool = require("../db");
const campaignsService = require("./campaignsService");
const couponsService = require("./couponsService");
const productOptionsService = require("./productOptionsService");
const orderWebhookService = require("./orderWebhookService");
const orderAutoAcceptService = require("./orderAutoAcceptService");
const { columnExists, tableExists } = require("../helpers/schema");
const { generateUniqueOrderTag } = require("../helpers/orderTag");
const { UUID_RE } = require("../helpers/companySlug");
const slots = require("../helpers/bookingSlots");
const { hasStockControlSchema, reserveStock } = require("../helpers/stockReservation");
const { meetsInclusiveLeadDays } = require("../helpers/preorder");

const DEFAULTS = { step: 15, notice: 60, maxDays: 30, cancelWindow: 24 };
const MAX_DAYS_PER_REQUEST = 14;
// Produtos levados junto com o serviço (retirados no atendimento).
const MAX_ADDON_LINES = 30;
const MAX_ADDON_QUANTITY = 99;
const ADDON_PICKUP_NOTE = "Retirar junto com o atendimento";
const ACTIVE_STATUSES = ["hold", "confirmed", "in_progress"];
const ONLINE_PROVIDERS = ["pagarme", "stripe"];
// A reserva de um pedido online dura o PIX inteiro + folga. Enquanto houver uma
// tentativa de pagamento em andamento, o cron não libera o horário.
const HOLD_MINUTES = Number(
  process.env.BOOKING_HOLD_MINUTES ||
    Math.max(15, Math.ceil(Number(process.env.PAGARME_PIX_EXPIRES_IN || 3600) / 60) + 5),
);
const HOLD_EXPIRED_REASON = "hold_expired";

const _error = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const hasBookingSchema = async () => {
  const checks = await Promise.all([
    tableExists("appointments"),
    tableExists("professionals"),
    tableExists("professional_services"),
    tableExists("professional_working_hours"),
    tableExists("professional_time_off"),
    columnExists("menu_items", "item_type"),
    columnExists("menu_items", "duration_minutes"),
  ]);
  return checks.every(Boolean);
};

const _ensureSchema = async () => {
  if (!(await hasBookingSchema())) {
    throw _error(503, "O agendamento de serviços ainda não está disponível.");
  }
};

// ─── Leitura ──────────────────────────────────────────────────────────────────

const _companySettingsSelect = async () => {
  const [tz, step, notice, maxDays, cancel, slug] = await Promise.all([
    columnExists("companies", "timezone"),
    columnExists("companies", "booking_slot_step_minutes"),
    columnExists("companies", "booking_min_notice_minutes"),
    columnExists("companies", "booking_max_days_ahead"),
    columnExists("companies", "cancel_window_hours"),
    columnExists("companies", "slug"),
  ]);
  return {
    hasSlug: slug,
    select: [
      tz ? "timezone" : "NULL::text AS timezone",
      step ? "booking_slot_step_minutes" : `${DEFAULTS.step} AS booking_slot_step_minutes`,
      notice ? "booking_min_notice_minutes" : `${DEFAULTS.notice} AS booking_min_notice_minutes`,
      maxDays ? "booking_max_days_ahead" : `${DEFAULTS.maxDays} AS booking_max_days_ahead`,
      cancel ? "cancel_window_hours" : `${DEFAULTS.cancelWindow} AS cancel_window_hours`,
    ].join(", "),
  };
};

const _normalizeCompany = (row) =>
  row && {
    id: Number(row.id),
    name: row.name,
    timezone: slots.resolveTimezone(row.timezone),
    step: Number(row.booking_slot_step_minutes) || DEFAULTS.step,
    notice: Math.max(0, Number(row.booking_min_notice_minutes ?? DEFAULTS.notice)),
    maxDays: Math.max(1, Number(row.booking_max_days_ahead) || DEFAULTS.maxDays),
    cancelWindow: Math.max(0, Number(row.cancel_window_hours ?? DEFAULTS.cancelWindow)),
  };

/** Configurações de agenda da empresa por id, UUID ou slug. */
const loadCompanySettings = async (companyRef, db = pool) => {
  const ref = String(companyRef ?? "").trim();
  const { select, hasSlug } = await _companySettingsSelect();
  let column = null;
  if (/^\d+$/.test(ref)) column = "id";
  else if (UUID_RE.test(ref)) column = "uuid";
  else if (hasSlug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref.toLowerCase())) column = "slug";
  if (!column) return null;
  const result = await db.query(`SELECT id, name, ${select} FROM companies WHERE ${column} = $1`, [
    column === "slug" ? ref.toLowerCase() : ref,
  ]);
  return _normalizeCompany(result.rows[0]);
};

/** Resumo público das regras de agenda (vai junto do cardápio). */
const publicBookingInfo = async (companyId) => {
  const enabled = await hasBookingSchema();
  const company = await loadCompanySettings(companyId);
  return {
    enabled,
    timezone: company?.timezone || slots.DEFAULT_TIMEZONE,
    max_days_ahead: company?.maxDays ?? DEFAULTS.maxDays,
    min_notice_minutes: company?.notice ?? DEFAULTS.notice,
    cancel_window_hours: company?.cancelWindow ?? DEFAULTS.cancelWindow,
  };
};

const _loadService = async (db, companyId, serviceId) => {
  const result = await db.query(
    `SELECT id, name, price, duration_minutes, buffer_minutes, price_type
     FROM menu_items
     WHERE id = $1 AND company_id = $2 AND item_type = 'service'
       AND available = true AND deleted_at IS NULL`,
    [serviceId, companyId],
  );
  return result.rows[0] || null;
};

const _loadProfessionals = async (db, companyId, serviceId, { lock = false, onlyId = null } = {}) => {
  const params = [companyId, serviceId];
  let filter = "";
  if (onlyId) {
    params.push(onlyId);
    filter = `AND p.id = $${params.length}`;
  }
  // FOR UPDATE OF p serializa reservas concorrentes do mesmo profissional (vale
  // mesmo sem a EXCLUDE constraint). Ordem por id evita deadlock.
  const result = await db.query(
    `SELECT p.id, p.name, p.photo_url, ps.price_override, ps.duration_override
     FROM professional_services ps
     JOIN professionals p ON p.id = ps.professional_id
     WHERE p.company_id = $1 AND ps.menu_item_id = $2 AND p.active = TRUE ${filter}
     ORDER BY p.id
     ${lock ? "FOR UPDATE OF p" : ""}`,
    params,
  );
  return result.rows;
};

const _groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = Number(row[key]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};

// Reserva "vencida e liberável": hold expirado, pedido ainda em Pagamento
// Pendente, não pago e sem tentativa de pagamento (PIX/cartão) em andamento.
const _releasableHoldSql = async (alias = "a") => {
  const hasAttempts = await tableExists("payment_attempts");
  const attemptGuard = hasAttempts
    ? `AND NOT EXISTS (
         SELECT 1 FROM payment_attempts pa
         WHERE pa.order_id = ${alias}.order_id
           AND pa.status IN ('pending', 'processing')
           AND COALESCE(pa.expires_at, pa.created_at + INTERVAL '30 minutes') > NOW()
       )`
    : "";
  return `${alias}.status = 'hold'
    AND ${alias}.hold_expires_at IS NOT NULL
    AND ${alias}.hold_expires_at < NOW()
    AND EXISTS (
      SELECT 1 FROM orders ho
      WHERE ho.id = ${alias}.order_id
        AND ho.status::text = '10'
        AND COALESCE(ho.payment_status, '') NOT IN ('paid', 'refunded', 'refund_pending', 'chargedback')
    )
    ${attemptGuard}`;
};

/** Agenda ocupada + folgas + jornada dos profissionais no intervalo [from, to). */
const _loadAgenda = async (db, professionalIds, from, to, { excludeAppointmentId = null } = {}) => {
  if (!professionalIds.length) return { busy: new Map(), timeOff: new Map(), hours: new Map() };
  const releasable = await _releasableHoldSql("a");
  const [busyRes, offRes, hoursRes] = await Promise.all([
    db.query(
      `SELECT a.professional_id, a.starts_at AS start, a.blocked_until AS "end"
       FROM appointments a
       WHERE a.professional_id = ANY($1::int[])
         AND a.status = ANY($4::text[])
         AND a.starts_at < $3 AND a.blocked_until > $2
         AND ($5::int IS NULL OR a.id <> $5)
         AND NOT (${releasable})`,
      [professionalIds, from, to, ACTIVE_STATUSES, excludeAppointmentId],
    ),
    db.query(
      `SELECT professional_id, starts_at AS start, ends_at AS "end"
       FROM professional_time_off
       WHERE professional_id = ANY($1::int[]) AND starts_at < $3 AND ends_at > $2`,
      [professionalIds, from, to],
    ),
    db.query(
      `SELECT professional_id, weekday, start_time::text AS start_time, end_time::text AS end_time
       FROM professional_working_hours WHERE professional_id = ANY($1::int[])`,
      [professionalIds],
    ),
  ]);
  return {
    busy: _groupBy(busyRes.rows, "professional_id"),
    timeOff: _groupBy(offRes.rows, "professional_id"),
    hours: _groupBy(hoursRes.rows, "professional_id"),
  };
};

const _loadOpeningHours = async (db, companyId) => {
  const result = await db.query(
    "SELECT weekday, opens_at::text AS opens_at, closes_at::text AS closes_at, is_closed FROM company_opening_hours WHERE company_id = $1",
    [companyId],
  );
  return result.rows;
};

const _durationFor = (service, professional) =>
  Number(professional.duration_override) || Number(service.duration_minutes) || 0;

const _priceFor = (service, professional) =>
  professional.price_override != null ? Number(professional.price_override) : Number(service.price ?? 0);

/** Limites da agenda pública: [hoje, hoje + maxDays] no fuso da empresa. */
const _window = (company, now = new Date()) => {
  const today = slots.localDate(now, company.timezone);
  return { today, last: slots.addDays(today, company.maxDays), earliest: new Date(now.getTime() + company.notice * 60000) };
};

// A loja (painel/encaixe) não segue antecedência mínima nem limite de dias:
// pode marcar para daqui a 5 minutos ou para meses à frente.
const _adminWindow = () => ({ today: "0000-01-01", last: "9999-12-31", earliest: null });

/**
 * Slots por dia e por profissional. Retorna Map<date, Map<time, slot>> com a
 * lista dos profissionais livres em cada horário.
 */
const _computeSlots = ({ company, service, professionals, agenda, openingHours, dates, earliest }) => {
  const byDate = new Map();
  for (const date of dates) {
    const byTime = new Map();
    for (const professional of professionals) {
      const id = Number(professional.id);
      const daySlots = slots.buildDaySlots({
        date,
        timezone: company.timezone,
        openingHours,
        workingHours: agenda.hours.get(id) || [],
        durationMinutes: _durationFor(service, professional),
        bufferMinutes: Number(service.buffer_minutes) || 0,
        stepMinutes: company.step,
        busy: agenda.busy.get(id) || [],
        timeOff: agenda.timeOff.get(id) || [],
        earliest,
      });
      for (const slot of daySlots) {
        if (!byTime.has(slot.time)) {
          byTime.set(slot.time, { ...slot, professionals: [] });
        }
        byTime.get(slot.time).professionals.push({ professional, slot });
      }
    }
    byDate.set(date, byTime);
  }
  return byDate;
};

const _rangeFor = (company, firstDate, lastDate) => ({
  // Folga de 1 dia nas pontas cobre qualquer diferença de fuso.
  from: slots.zonedTimeToUtc(slots.addDays(firstDate, -1), 0, company.timezone),
  to: slots.zonedTimeToUtc(slots.addDays(lastDate, 2), 0, company.timezone),
});

/**
 * GET público: horários livres de um serviço a partir de `date` (padrão hoje)
 * por `days` dias (1–14). `professionalId` vazio/"any" agrega todos os
 * profissionais que executam o serviço ("Sem preferência").
 */
const getAvailability = async ({ companyRef, serviceId, professionalId, date, days }) => {
  await _ensureSchema();
  const company = await loadCompanySettings(companyRef);
  if (!company) throw _error(404, "Empresa não encontrada.");
  const service = await _loadService(pool, company.id, serviceId);
  if (!service) throw _error(404, "Serviço não encontrado.");

  const onlyId = professionalId && professionalId !== "any" ? Number(professionalId) : null;
  if (professionalId && professionalId !== "any" && !(Number.isInteger(onlyId) && onlyId > 0)) {
    throw _error(400, "Profissional inválido.");
  }
  const professionals = await _loadProfessionals(pool, company.id, service.id, { onlyId });

  const { today, last, earliest } = _window(company);
  let first = slots.parseDate(date) ? String(date) : today;
  if (first < today) first = today;
  const count = Math.min(MAX_DAYS_PER_REQUEST, Math.max(1, Number(days) || 1));
  const dates = [];
  for (let i = 0; i < count; i++) {
    const d = slots.addDays(first, i);
    if (d > last) break;
    dates.push(d);
  }

  const response = {
    timezone: company.timezone,
    today,
    max_date: last,
    service: {
      id: Number(service.id),
      name: service.name,
      duration_minutes: Number(service.duration_minutes) || null,
      price: Number(service.price ?? 0),
      price_type: service.price_type || "fixed",
    },
    professional_id: onlyId,
    professionals: professionals.map((p) => ({
      id: Number(p.id),
      name: p.name,
      photo_url: p.photo_url,
      price: _priceFor(service, p),
      duration_minutes: _durationFor(service, p),
    })),
    days: [],
  };
  if (!dates.length || !professionals.length) {
    response.days = dates.map((d) => ({ date: d, weekday: slots.weekdayOf(d), slots: [] }));
    return response;
  }

  const ids = professionals.map((p) => Number(p.id));
  const { from, to } = _rangeFor(company, dates[0], dates[dates.length - 1]);
  const [agenda, openingHours] = await Promise.all([
    _loadAgenda(pool, ids, from, to),
    _loadOpeningHours(pool, company.id),
  ]);
  const byDate = _computeSlots({ company, service, professionals, agenda, openingHours, dates, earliest });
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

/**
 * Valida o horário EXATO pedido (sem tolerância) e devolve o profissional que
 * vai atender. Deve rodar dentro da transação, com os profissionais travados.
 */
const _resolveSlot = async (db, { company, service, professionals, startsAt, excludeAppointmentId = null, admin = false }) => {
  const date = slots.localDate(startsAt, company.timezone);
  const { today, last, earliest } = admin ? _adminWindow() : _window(company);
  if (date < today || date > last) {
    throw _error(400, "Esse dia está fora do período de agendamento da loja.", "BOOKING_OUT_OF_WINDOW");
  }
  const ids = professionals.map((p) => Number(p.id));
  const { from, to } = _rangeFor(company, date, date);
  const [agenda, openingHours] = await Promise.all([
    _loadAgenda(db, ids, from, to, { excludeAppointmentId }),
    _loadOpeningHours(db, company.id),
  ]);
  const byTime = _computeSlots({ company, service, professionals, agenda, openingHours, dates: [date], earliest }).get(date);
  const match = [...byTime.values()].find((s) => s.startsAt.getTime() === startsAt.getTime());
  if (!match) {
    throw _error(409, "Esse horário não está mais disponível. Escolha outro.", "BOOKING_SLOT_TAKEN");
  }
  if (match.professionals.length === 1) return match.professionals[0];

  // "Sem preferência": atribui o profissional com menos agendamentos no dia.
  const dayStart = slots.zonedTimeToUtc(date, 0, company.timezone);
  const dayEnd = slots.zonedTimeToUtc(slots.addDays(date, 1), 0, company.timezone);
  const load = await db.query(
    `SELECT professional_id, COUNT(*)::int AS total
     FROM appointments
     WHERE professional_id = ANY($1::int[]) AND status = ANY($2::text[])
       AND starts_at >= $3 AND starts_at < $4
     GROUP BY professional_id`,
    [match.professionals.map((x) => Number(x.professional.id)), ACTIVE_STATUSES, dayStart, dayEnd],
  );
  const totals = new Map(load.rows.map((r) => [Number(r.professional_id), r.total]));
  return [...match.professionals].sort(
    (a, b) =>
      (totals.get(Number(a.professional.id)) || 0) - (totals.get(Number(b.professional.id)) || 0) ||
      Number(a.professional.id) - Number(b.professional.id),
  )[0];
};

/** Libera (cancela) holds vencidos dos profissionais informados. Retorna os pedidos afetados. */
const _releaseHolds = async (db, professionalIds = null) => {
  const releasable = await _releasableHoldSql("a");
  const params = [HOLD_EXPIRED_REASON];
  let filter = "";
  if (professionalIds) {
    params.push(professionalIds);
    filter = `AND a.professional_id = ANY($${params.length}::int[])`;
  }
  const result = await db.query(
    `UPDATE appointments a
     SET status = 'cancelled', cancel_reason = $1, cancelled_at = NOW(), updated_at = NOW()
     WHERE ${releasable} ${filter}
     RETURNING a.order_id`,
    params,
  );
  return result.rows.map((r) => Number(r.order_id));
};

// Pedidos cujo horário foi liberado saem de "Pagamento Pendente" (só se ainda
// estiverem lá — um pagamento que chegou no meio do caminho vence a corrida).
const _cancelReleasedOrders = async (orderIds) => {
  if (!orderIds.length) return;
  const ordersService = require("./ordersService");
  for (const orderId of orderIds) {
    try {
      await ordersService.updateStatus(
        orderId,
        6,
        "Horário liberado: o pagamento não foi confirmado a tempo.",
        { onlyFrom: 10 },
      );
    } catch (err) {
      console.error(`[booking] falha ao cancelar pedido ${orderId} com reserva vencida:`, err.message);
    }
  }
};

// ─── Criação do pedido de serviço ────────────────────────────────────────────

const _parseStartsAt = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw _error(400, "Escolha um horário válido.");
  date.setUTCSeconds(0, 0);
  return date;
};

/**
 * Produtos que o cliente leva junto com o serviço. Preço, opções, disponibilidade
 * e encomenda (antecedência até o dia do atendimento) resolvidos no servidor —
 * o payload só informa produto, quantidade, opções e observação.
 */
const _resolveAddOnProducts = async ({ companyId, products, startsAt, campaignPrices }) => {
  if (products == null) return [];
  if (!Array.isArray(products)) throw _error(400, "Lista de produtos inválida.");
  if (products.length > MAX_ADDON_LINES) throw _error(400, "Produtos demais para um agendamento.");
  if (!products.length) return [];

  const lines = products.map((raw) => {
    const menuItemId = Number(raw?.menu_item_id);
    const quantity = Number(raw?.quantity ?? 1);
    if (!Number.isInteger(menuItemId) || menuItemId <= 0) throw _error(400, "Produto inválido.");
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_ADDON_QUANTITY) {
      throw _error(400, "A quantidade de cada produto deve ser um número inteiro maior que zero.");
    }
    const notes = raw?.notes ? String(raw.notes).trim().slice(0, 300) || null : null;
    return { menuItemId, quantity, notes, options: Array.isArray(raw?.options) ? raw.options : [] };
  });

  const [hasPreorder, hasItemType] = await Promise.all([
    Promise.all([columnExists("menu_items", "preorder_only"), columnExists("menu_items", "preorder_lead_days")]).then(
      (cols) => cols.every(Boolean),
    ),
    columnExists("menu_items", "item_type"),
  ]);
  const ids = [...new Set(lines.map((l) => l.menuItemId))];
  const rows = await pool.query(
    `SELECT id, name, price
            ${hasPreorder ? ", COALESCE(preorder_only, false) AS preorder_only, preorder_lead_days" : ""}
     FROM menu_items
     WHERE company_id = $1 AND id = ANY($2::int[])
       AND available = true AND deleted_at IS NULL
       ${hasItemType ? "AND item_type <> 'service'" : ""}`,
    [companyId, ids],
  );
  const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));

  const resolved = [];
  for (const line of lines) {
    const product = byId.get(line.menuItemId);
    if (!product) throw _error(409, "Um dos produtos escolhidos não está mais disponível.");
    if (
      product.preorder_only === true &&
      !meetsInclusiveLeadDays({
        orderedAt: new Date(),
        scheduledAt: startsAt,
        leadDays: Number(product.preorder_lead_days || 1),
      })
    ) {
      throw _error(
        400,
        `"${product.name}" é sob encomenda e não fica pronto até a data do atendimento.`,
        "PREORDER_LEAD_TIME_NOT_MET",
      );
    }
    let selection;
    try {
      selection = await productOptionsService.validateSelections(line.menuItemId, line.options);
    } catch (err) {
      throw _error(400, `${product.name}: ${err.message}`);
    }
    const base = Number(product.price ?? 0);
    const campaign = campaignPrices.get(line.menuItemId);
    const baseUnit = campaign ? Math.min(base, campaign.final_price) : base;
    const unitPrice = Number((baseUnit + selection.extraTotalPerUnit).toFixed(2));
    resolved.push({
      menu_item_id: line.menuItemId,
      name: product.name,
      quantity: line.quantity,
      unit_price: unitPrice,
      subtotal: Number((unitPrice * line.quantity).toFixed(2)),
      notes: [ADDON_PICKUP_NOTE, line.notes].filter(Boolean).join(" · "),
      options: selection.snapshot,
    });
  }
  return resolved;
};

/**
 * POST /public/bookings — cria o pedido do serviço e reserva o horário.
 * Pagamento online: pedido em Pagamento Pendente (10) + agendamento 'hold' com
 * expiração. Pagamento no local: pedido em Aguardando (1) + 'confirmed'.
 */
const createBookingOrder = async (data) => {
  await _ensureSchema();
  const companyId = Number(data.company_id);
  const clientId = Number(data.client_id);
  const booking = data.booking || {};
  const serviceId = Number(booking.menu_item_id);
  if (!Number.isInteger(companyId) || !Number.isInteger(clientId) || !Number.isInteger(serviceId)) {
    throw _error(400, "Dados do agendamento incompletos.");
  }
  const requestedProfessional =
    booking.professional_id == null || booking.professional_id === "any" ? null : Number(booking.professional_id);
  if (requestedProfessional !== null && !(Number.isInteger(requestedProfessional) && requestedProfessional > 0)) {
    throw _error(400, "Profissional inválido.");
  }
  const startsAt = _parseStartsAt(booking.starts_at);

  const ownerParams = [clientId, companyId];
  let ownerFilter = "";
  if (data.authenticated_user_id) {
    ownerParams.push(data.authenticated_user_id);
    ownerFilter = `AND user_id = $${ownerParams.length}`;
  }
  const owner = await pool.query(
    `SELECT 1 FROM clients WHERE id = $1 AND company_id = $2 ${ownerFilter} AND deactivated_at IS NULL LIMIT 1`,
    ownerParams,
  );
  if (!owner.rows[0]) {
    throw _error(403, "Atualize sua identificação antes de agendar.");
  }

  const paymentProvider = ONLINE_PROVIDERS.includes(data.payment_provider) ? data.payment_provider : null;
  const onlineMethod =
    paymentProvider && ["pix", "card"].includes(data.online_payment_method) ? data.online_payment_method : null;
  let paymentMethodId = null;
  if (!paymentProvider) {
    paymentMethodId = Number(data.payment_method_id);
    const method = Number.isInteger(paymentMethodId)
      ? await pool.query("SELECT 1 FROM payment_methods WHERE id = $1 AND company_id = $2 AND active = true", [
          paymentMethodId,
          companyId,
        ])
      : { rows: [] };
    if (!method.rows[0]) throw _error(400, "Escolha uma forma de pagamento válida.");
  }

  const company = await loadCompanySettings(companyId);
  if (!company) throw _error(404, "Empresa não encontrada.");
  const notes = data.notes ? String(data.notes).trim().slice(0, 500) || null : null;
  const couponCode = data.coupon_code ? String(data.coupon_code).trim() : null;
  const activeCampaignPrices = await campaignsService.getActivePricesMap(companyId);
  const addOns = await _resolveAddOnProducts({
    companyId,
    products: data.products,
    startsAt,
    campaignPrices: activeCampaignPrices,
  });
  const addOnsSubtotal = Number(addOns.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2));
  const stockRequirements = new Map();
  if (addOns.length && (await hasStockControlSchema())) {
    for (const item of addOns) {
      stockRequirements.set(item.menu_item_id, (stockRequirements.get(item.menu_item_id) || 0) + item.quantity);
    }
  }

  const client = await pool.connect();
  let releasedOrders = [];
  try {
    await client.query("BEGIN");
    const service = await _loadService(client, companyId, serviceId);
    if (!service) throw _error(404, "Serviço indisponível.");
    const professionals = await _loadProfessionals(client, companyId, serviceId, {
      lock: true,
      onlyId: requestedProfessional,
    });
    if (!professionals.length) {
      throw _error(409, "Esse profissional não atende mais este serviço. Escolha outro.");
    }
    releasedOrders = await _releaseHolds(client, professionals.map((p) => Number(p.id)));
    const chosen = await _resolveSlot(client, { company, service, professionals, startsAt });
    const professional = chosen.professional;

    // Preço autoritativo: preço do profissional ou do serviço (campanha só sem preço próprio).
    let unitPrice = _priceFor(service, professional);
    const campaign = activeCampaignPrices.get(Number(service.id));
    if (professional.price_override == null && campaign) unitPrice = Math.min(unitPrice, campaign.final_price);
    unitPrice = Number(unitPrice.toFixed(2));

    const serviceFeeAmount = Number(process.env.PUBLIC_SERVICE_FEE_AMOUNT ?? 1.49);
    const serviceFee = paymentProvider ? Number(serviceFeeAmount.toFixed(2)) : 0;

    if (stockRequirements.size) await reserveStock(client, companyId, stockRequirements);
    const subtotal = Number((unitPrice + addOnsSubtotal).toFixed(2));

    let couponId = null;
    let couponDiscount = 0;
    if (couponCode) {
      const redeemed = await couponsService.redeemForOrder(client, {
        companyId,
        code: couponCode,
        clientId,
        subtotal,
        deliveryFee: 0,
        items: [
          { menu_item_id: Number(service.id), subtotal: unitPrice },
          ...addOns.map((item) => ({ menu_item_id: item.menu_item_id, subtotal: item.subtotal })),
        ],
      });
      couponId = redeemed.coupon_id;
      couponDiscount = Number(redeemed.discount || 0);
    }
    const total = Number(Math.max(0, subtotal + serviceFee - couponDiscount).toFixed(2));
    const initialStatus = paymentProvider ? 10 : 1;
    const tag = await generateUniqueOrderTag(client);

    const params = [
      companyId,
      clientId,
      notes,
      subtotal,
      total,
      paymentMethodId,
      startsAt,
      tag,
      paymentProvider,
      serviceFee,
      onlineMethod,
    ];
    let extraCols = "";
    let extraValues = "";
    if ((await columnExists("orders", "coupon_id")) && (await columnExists("orders", "coupon_discount"))) {
      params.push(couponId, couponDiscount);
      extraCols = ", coupon_id, coupon_discount";
      extraValues = `, $${params.length - 1}, $${params.length}`;
    }
    if (stockRequirements.size) {
      const reservation = Array.from(stockRequirements, ([menu_item_id, quantity]) => ({ menu_item_id, quantity }));
      params.push(true, JSON.stringify(reservation));
      extraCols += ", stock_reserved, stock_reservation_items";
      extraValues += `, $${params.length - 1}, $${params.length}`;
    }
    // delivery_type FALSE = atendimento no estabelecimento (sem entrega).
    const orderRes = await client.query(
      `INSERT INTO orders (
         company_id, client_id, status, notes, subtotal, delivery_fee, discount, total,
         payment_method_id, delivery_address, delivery_type, scheduled_for, tag, payment_provider,
         service_fee, online_payment_method${extraCols}
       )
       VALUES ($1, $2, ${initialStatus}, $3, $4, 0, 0, $5, $6, NULL, FALSE, $7, $8, $9, $10, $11${extraValues})
       RETURNING *`,
      params,
    );
    const order = orderRes.rows[0];
    if (couponId) {
      await couponsService.recordRedemption(client, { couponId, orderId: order.id, clientId, discount: couponDiscount });
    }

    const itemRes = await client.query(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal, notes)
       VALUES ($1, $2, $3, 1, $4, $4, $5) RETURNING id`,
      [order.id, service.id, service.name, unitPrice, `Profissional: ${professional.name}`],
    );

    for (const item of addOns) {
      const addOnRes = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [order.id, item.menu_item_id, item.name, item.quantity, item.unit_price, item.subtotal, item.notes],
      );
      for (const opt of item.options) {
        await client.query(
          `INSERT INTO order_item_options
             (order_item_id, menu_item_id, group_id, group_name, option_id, option_name, additional_price, quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            addOnRes.rows[0].id,
            item.menu_item_id,
            opt.group_id ?? null,
            opt.group_name,
            opt.option_id ?? null,
            opt.option_name,
            Number(opt.additional_price ?? 0),
            Math.max(1, Number(opt.quantity ?? 1)),
          ],
        );
      }
    }

    const slot = chosen.slot;
    const appointmentRes = await client.query(
      `INSERT INTO appointments (
         company_id, order_id, order_item_id, menu_item_id, professional_id,
         starts_at, ends_at, blocked_until, status, hold_expires_at, location_type
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'on_site')
       RETURNING *`,
      [
        companyId,
        order.id,
        itemRes.rows[0].id,
        service.id,
        professional.id,
        slot.startsAt,
        slot.endsAt,
        slot.blockedUntil,
        paymentProvider ? "hold" : "confirmed",
        paymentProvider ? new Date(Date.now() + HOLD_MINUTES * 60000) : null,
      ],
    );

    await client.query("INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)", [
      order.id,
      String(initialStatus),
    ]);
    await client.query("COMMIT");

    if (initialStatus === 1) {
      orderWebhookService.notifyAwaitingOrder(order.id);
      orderAutoAcceptService.applyToOrder(order.id);
    }
    _cancelReleasedOrders(releasedOrders);
    const appointment = appointmentRes.rows[0];
    return {
      ...order,
      appointment: {
        id: appointment.id,
        status: appointment.status,
        starts_at: appointment.starts_at,
        ends_at: appointment.ends_at,
        hold_expires_at: appointment.hold_expires_at,
        professional_id: Number(professional.id),
        professional_name: professional.name,
        service_name: service.name,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23P01") {
      throw _error(409, "Esse horário acabou de ser reservado. Escolha outro.", "BOOKING_SLOT_TAKEN");
    }
    throw err;
  } finally {
    client.release();
  }
};

// ─── Ciclo de vida ───────────────────────────────────────────────────────────

/**
 * Pagamento confirmado: confirma a reserva. Se ela já tinha sido liberada por
 * vencimento, tenta recuperá-la (a EXCLUDE constraint recusa se o horário foi
 * ocupado por outra pessoa — nesse caso a loja precisa remarcar).
 */
const confirmForOrder = async (orderId) => {
  try {
    if (!(await tableExists("appointments"))) return;
    const confirmed = await pool.query(
      `UPDATE appointments SET status = 'confirmed', hold_expires_at = NULL, updated_at = NOW()
       WHERE order_id = $1 AND status = 'hold'`,
      [orderId],
    );
    if (confirmed.rowCount > 0) return;
    await pool.query(
      `UPDATE appointments a
       SET status = 'confirmed', hold_expires_at = NULL, cancel_reason = NULL, cancelled_at = NULL, updated_at = NOW()
       FROM orders o
       WHERE a.order_id = $1 AND o.id = a.order_id
         AND a.status = 'cancelled' AND a.cancel_reason = $2
         AND o.status::text NOT IN ('6', '7')`,
      [orderId, HOLD_EXPIRED_REASON],
    );
  } catch (err) {
    console.error(`[booking] não foi possível confirmar o agendamento do pedido ${orderId}:`, err.message);
  }
};

/**
 * Espelha a etapa do pedido no agendamento. Roda DENTRO da transação de
 * ordersService.updateStatus para que cancelar o pedido libere o horário junto.
 */
const syncOrderStatus = async (db, orderId, status, { appointmentStatus = null } = {}) => {
  if (!(await tableExists("appointments"))) return;
  const s = Number(status);
  let sql = null;
  if ((s === 6 || s === 7) && appointmentStatus === "no_show") {
    // Não compareceu: o pedido é cancelado, mas o histórico guarda o no-show.
    sql = `UPDATE appointments
           SET status = 'no_show', cancelled_at = NOW(), cancel_reason = 'no_show', updated_at = NOW()
           WHERE order_id = $1 AND status IN ('hold', 'confirmed', 'in_progress')`;
  } else if (s === 6 || s === 7) {
    sql = `UPDATE appointments
           SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = COALESCE(cancel_reason, 'order_cancelled'), updated_at = NOW()
           WHERE order_id = $1 AND status IN ('hold', 'confirmed', 'in_progress')`;
  } else if (s === 5 || s === 9) {
    sql = `UPDATE appointments SET status = 'done', updated_at = NOW()
           WHERE order_id = $1 AND status IN ('hold', 'confirmed', 'in_progress')`;
  } else if (s === 3) {
    sql = `UPDATE appointments SET status = 'in_progress', hold_expires_at = NULL, updated_at = NOW()
           WHERE order_id = $1 AND status IN ('hold', 'confirmed')`;
  } else if (s === 1 || s === 2) {
    sql = `UPDATE appointments SET status = 'confirmed', hold_expires_at = NULL, updated_at = NOW()
           WHERE order_id = $1 AND status = 'hold'`;
  }
  if (sql) await db.query(sql, [orderId]);
};

/** Cron: libera holds vencidos e cancela os pedidos que ficaram sem horário. */
const releaseExpiredHolds = async () => {
  if (!(await tableExists("appointments"))) return 0;
  const orderIds = await _releaseHolds(pool);
  await _cancelReleasedOrders(orderIds);
  return orderIds.length;
};

// ─── Visão do cliente (acompanhamento) ───────────────────────────────────────

const _appointmentSelect = `
  SELECT a.id, a.order_id, a.company_id, a.status, a.starts_at, a.ends_at, a.hold_expires_at,
         a.location_type, a.menu_item_id, a.professional_id, a.rescheduled_count,
         mi.name AS service_name, p.name AS professional_name, p.photo_url AS professional_photo_url
  FROM appointments a
  LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
  LEFT JOIN professionals p ON p.id = a.professional_id`;

const _customerRules = (appointment, company, orderStatus, now = new Date()) => {
  const deadline = new Date(new Date(appointment.starts_at).getTime() - company.cancelWindow * 3600000);
  const active = ["hold", "confirmed"].includes(appointment.status) && ![6, 7].includes(Number(orderStatus));
  const withinWindow = now <= deadline;
  return {
    cancel_deadline: deadline.toISOString(),
    cancel_window_hours: company.cancelWindow,
    can_cancel: active && withinWindow,
    can_reschedule: active && withinWindow && Boolean(appointment.menu_item_id),
  };
};

/** Agendamento do pedido para o acompanhamento público (null se não houver). */
const getForOrder = async (orderId, orderStatus) => {
  try {
    if (!(await tableExists("appointments"))) return null;
    const result = await pool.query(`${_appointmentSelect} WHERE a.order_id = $1 ORDER BY a.id DESC LIMIT 1`, [orderId]);
    const row = result.rows[0];
    if (!row) return null;
    const company = await loadCompanySettings(row.company_id);
    const addressRes = await pool.query(
      `SELECT street, number, neighborhood, city, state FROM company_addresses
       WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
      [row.company_id],
    );
    const a = addressRes.rows[0];
    const address = a
      ? [[a.street, a.number].filter(Boolean).join(", "), a.neighborhood, [a.city, a.state].filter(Boolean).join(" - ")]
          .filter(Boolean)
          .join(" · ")
      : null;
    return {
      id: row.id,
      status: row.status,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      hold_expires_at: row.hold_expires_at,
      location_type: row.location_type,
      menu_item_id: row.menu_item_id,
      service_name: row.service_name,
      professional_id: row.professional_id,
      professional_name: row.professional_name,
      professional_photo_url: row.professional_photo_url,
      rescheduled_count: row.rescheduled_count,
      timezone: company?.timezone || slots.DEFAULT_TIMEZONE,
      company_name: company?.name || null,
      address,
      ..._customerRules(row, company || { cancelWindow: DEFAULTS.cancelWindow }, orderStatus),
    };
  } catch (err) {
    console.error(`[booking] falha ao carregar agendamento do pedido ${orderId}:`, err.message);
    return null;
  }
};

/**
 * Regra de cancelamento pelo cliente para pedidos de serviço: só até
 * `cancel_window_hours` antes do horário. Retorna mensagem de bloqueio ou null.
 */
const customerCancelBlock = async (orderId, orderStatus) => {
  const appointment = await getForOrder(orderId, orderStatus);
  if (!appointment || !["hold", "confirmed"].includes(appointment.status)) return null;
  if (appointment.can_cancel) return null;
  return `O cancelamento pelo site vai até ${appointment.cancel_window_hours}h antes do horário. Fale com o estabelecimento.`;
};

/** Remarcação pelo cliente (dono do link do pedido), dentro da janela de cancelamento. */
const rescheduleByCustomer = async ({ orderRef, phone, startsAt: rawStartsAt, professionalId }) => {
  await _ensureSchema();
  const publicService = require("./publicService");
  const order = await publicService.getPublicOrder({ id: orderRef, phone });
  if (!order) throw _error(404, "Pedido não encontrado.");
  const startsAt = _parseStartsAt(rawStartsAt);

  const client = await pool.connect();
  let releasedOrders = [];
  try {
    await client.query("BEGIN");
    const current = (
      await client.query(`SELECT * FROM appointments WHERE order_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`, [order.id])
    ).rows[0];
    if (!current) throw _error(404, "Este pedido não tem agendamento.");
    const company = await loadCompanySettings(current.company_id, client);
    const rules = _customerRules(current, company, order.status);
    if (!rules.can_reschedule) {
      throw _error(
        409,
        `A remarcação pelo site vai até ${company.cancelWindow}h antes do horário. Fale com o estabelecimento.`,
      );
    }
    const service = await _loadService(client, company.id, current.menu_item_id);
    if (!service) throw _error(409, "Este serviço não está mais disponível para remarcação.");

    const wanted =
      professionalId === "any" ? null : professionalId != null ? Number(professionalId) : Number(current.professional_id);
    const professionals = await _loadProfessionals(client, company.id, service.id, { lock: true, onlyId: wanted });
    if (!professionals.length) throw _error(409, "Esse profissional não atende mais este serviço. Escolha outro.");
    releasedOrders = await _releaseHolds(client, professionals.map((p) => Number(p.id)));
    const chosen = await _resolveSlot(client, {
      company,
      service,
      professionals,
      startsAt,
      excludeAppointmentId: current.id,
    });

    // O preço do pedido não muda na remarcação (troca de profissional mantém o valor pago).
    await client.query(
      `UPDATE appointments
       SET professional_id = $2, starts_at = $3, ends_at = $4, blocked_until = $5,
           rescheduled_count = rescheduled_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [current.id, chosen.professional.id, chosen.slot.startsAt, chosen.slot.endsAt, chosen.slot.blockedUntil],
    );
    await client.query("UPDATE orders SET scheduled_for = $2, updated_at = NOW() WHERE id = $1", [
      order.id,
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
      throw _error(409, "Esse horário acabou de ser reservado. Escolha outro.", "BOOKING_SLOT_TAKEN");
    }
    throw err;
  } finally {
    client.release();
  }
  _cancelReleasedOrders(releasedOrders);
  return getForOrder(order.id, order.status);
};

/** Profissional com agendamentos não pode ser excluído (o histórico depende dele). */
const professionalHasAppointments = async (professionalId) => {
  if (!(await tableExists("appointments"))) return false;
  const result = await pool.query("SELECT 1 FROM appointments WHERE professional_id = $1 LIMIT 1", [professionalId]);
  return result.rowCount > 0;
};

module.exports = {
  // Peças internas reaproveitadas pela agenda do painel (appointmentsService).
  _internal: {
    error: _error,
    ensureSchema: _ensureSchema,
    loadService: _loadService,
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
  },
  HOLD_MINUTES,
  hasBookingSchema,
  loadCompanySettings,
  publicBookingInfo,
  getAvailability,
  createBookingOrder,
  confirmForOrder,
  syncOrderStatus,
  releaseExpiredHolds,
  getForOrder,
  customerCancelBlock,
  rescheduleByCustomer,
  professionalHasAppointments,
};
