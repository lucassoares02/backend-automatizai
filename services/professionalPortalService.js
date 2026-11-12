const pool = require("../db");
const { columnExists, tableExists } = require("../helpers/schema");
const slots = require("../helpers/bookingSlots");
const bookingService = require("./bookingService");
const ordersService = require("./ordersService");
const appointmentsService = require("./appointmentsService");

// ─── Tela pública do profissional (por token, sem auth) ──────────────────────
// Mesmo modelo do link/QR do motoboy (deliveriesService.getPublicRoute): a loja
// envia o link /profissional/{token} e o profissional vê SÓ os próprios
// clientes (agendamentos), executa as ações (iniciar, concluir, não compareceu,
// reabrir) e anexa fotos opcionais. Coluna/tabela da migração "Tela pública do
// profissional" em DB_CHANGES_NEEDED.md — sem ela, o link responde 404.

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ["pending", "confirmed", "in_progress"];
const CLOSED_STATUSES = ["done", "no_show"];
const PAST_OPEN_DAYS = 3; // atendimentos em aberto de dias anteriores continuam na lista
const AHEAD_DAYS = 30;
const HISTORY_DAYS = 30;
const MAX_PHOTOS = 20;
const ALLOWED_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const _error = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const _photosAvailable = () => tableExists("appointment_photos");

/** Profissional dono do token (ativo) ou null. */
const _professionalByToken = async (token, db = pool) => {
  const clean = String(token ?? "").trim();
  if (!clean || !_UUID_RE.test(clean)) return null;
  if (!(await tableExists("appointments"))) return null;
  if (!(await columnExists("professionals", "public_token"))) return null;
  const res = await db.query(
    `SELECT p.id, p.company_id, p.name, p.photo_url, comp.name AS company_name
     FROM professionals p
     JOIN companies comp ON comp.id = p.company_id
     WHERE p.public_token = $1 AND p.active = TRUE
     LIMIT 1`,
    [clean],
  );
  return res.rows[0] || null;
};

/** Agendamento do profissional (escopo token → profissional → empresa). */
const _ownAppointment = async (professional, appointmentId, db = pool) => {
  const id = Number(appointmentId);
  if (!Number.isInteger(id) || id <= 0) throw _error(400, "Atendimento inválido.", "invalid_appointment");
  const res = await db.query(
    `SELECT a.id, a.order_id, a.status, o.status AS order_status
     FROM appointments a
     JOIN orders o ON o.id = a.order_id
     WHERE a.id = $1 AND a.professional_id = $2 AND a.company_id = $3
     LIMIT 1`,
    [id, professional.id, professional.company_id],
  );
  return res.rows[0] || null;
};

const _localLabels = (date, tz) => {
  if (!date) return { local_date: null, local_time: null };
  const p = slots.zonedParts(date, tz);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    local_date: slots.formatDate(p),
    local_time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
};

const _mapAppointment = (row, tz, photosByAppointment) => {
  const start = _localLabels(row.starts_at, tz);
  const end = _localLabels(row.ends_at, tz);
  return {
    id: row.id,
    order_id: row.order_id,
    tag: row.tag,
    status: row.status,
    order_status: toNumber(row.order_status),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    local_date: start.local_date,
    local_time: start.local_time,
    local_end_time: end.local_time,
    service_name: row.service_name,
    duration_minutes: toNumber(row.duration_minutes),
    client_name: row.client_name,
    client_phone: row.client_phone,
    notes: row.notes,
    total: toNumber(row.total),
    completion_note: row.completion_note,
    items: Array.isArray(row.items) ? row.items : [],
    photos: photosByAppointment.get(Number(row.id)) || [],
  };
};

const _photosFor = async (appointmentIds) => {
  const map = new Map();
  if (!appointmentIds.length || !(await _photosAvailable())) return map;
  const res = await pool.query(
    `SELECT id, appointment_id, url, created_at
     FROM appointment_photos
     WHERE appointment_id = ANY($1::int[])
     ORDER BY created_at ASC, id ASC`,
    [appointmentIds],
  );
  for (const r of res.rows) {
    const key = Number(r.appointment_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: r.id, url: r.url, created_at: r.created_at });
  }
  return map;
};

/**
 * GET /public/professionals/:token/appointments — clientes do profissional:
 * em aberto (pendente/confirmado/em atendimento) de PAST_OPEN_DAYS atrás até
 * AHEAD_DAYS à frente e o histórico (concluído/não compareceu) recente.
 * Reservas 'hold' (pagamento online pendente) e canceladas ficam de fora.
 */
const listAppointments = async (token) => {
  const professional = await _professionalByToken(token);
  if (!professional) return null;
  const company = await bookingService.loadCompanySettings(professional.company_id);
  const tz = slots.resolveTimezone(company?.timezone || slots.DEFAULT_TIMEZONE);

  const res = await pool.query(
    `SELECT a.id, a.order_id, a.status, a.starts_at, a.ends_at,
            o.tag, o.status AS order_status, o.total, o.notes,
            mi.name AS service_name, mi.duration_minutes,
            c.name AS client_name, c.phone AS client_phone,
            (
              SELECT osh.notes
              FROM order_status_history osh
              WHERE osh.order_id = o.id AND osh.status = '5'
              ORDER BY osh.created_at DESC
              LIMIT 1
            ) AS completion_note,
            COALESCE((
              SELECT json_agg(json_build_object('name', oi.item_name, 'quantity', oi.quantity) ORDER BY oi.id)
              FROM order_items oi
              WHERE oi.order_id = o.id AND oi.id IS DISTINCT FROM a.order_item_id
            ), '[]') AS items
     FROM appointments a
     JOIN orders o ON o.id = a.order_id
     LEFT JOIN clients c ON c.id = o.client_id
     LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
     WHERE a.professional_id = $1
       AND a.company_id = $2
       AND (
         (a.status = ANY($3::text[])
           AND a.starts_at >= NOW() - ($5 || ' days')::interval
           AND a.starts_at < NOW() + ($6 || ' days')::interval)
         OR (a.status = ANY($4::text[])
           AND a.starts_at >= NOW() - ($7 || ' days')::interval)
       )
     ORDER BY a.starts_at ASC
     LIMIT 300`,
    [
      professional.id,
      professional.company_id,
      OPEN_STATUSES,
      CLOSED_STATUSES,
      String(PAST_OPEN_DAYS),
      String(AHEAD_DAYS),
      String(HISTORY_DAYS),
    ],
  );

  const photos = await _photosFor(res.rows.map((r) => Number(r.id)));
  return {
    company_name: professional.company_name,
    professional_name: professional.name,
    professional_photo_url: professional.photo_url,
    timezone: tz,
    today: slots.localDate(new Date(), tz),
    photos_enabled: await _photosAvailable(),
    max_photos: MAX_PHOTOS,
    appointments: res.rows.map((r) => _mapAppointment(r, tz, photos)),
  };
};

const _requireOwn = async (token, appointmentId) => {
  const professional = await _professionalByToken(token);
  if (!professional) return { professional: null, appointment: null };
  const appointment = await _ownAppointment(professional, appointmentId);
  return { professional, appointment };
};

const _cleanComment = (comment) => String(comment ?? "").trim().slice(0, 280);

/** Iniciar atendimento: pedido → 3 (agendamento vira 'in_progress'). */
const startAppointment = async (token, appointmentId) => {
  const { appointment } = await _requireOwn(token, appointmentId);
  if (!appointment) return null;
  if (appointment.status === "in_progress") return { id: appointment.id, status: "in_progress", already: true };
  if (appointment.status === "pending") {
    throw _error(409, "Aguarde a loja confirmar este agendamento.", "awaiting_approval");
  }
  if (appointment.status !== "confirmed") {
    throw _error(409, "Este atendimento não pode ser iniciado.", "invalid_status");
  }
  await ordersService.updateStatus(appointment.order_id, 3, "Atendimento iniciado pelo profissional");
  return { id: appointment.id, status: "in_progress", already: false };
};

/** Concluir atendimento (comentário opcional): pedido → 5 (agendamento 'done'). */
const completeAppointment = async (token, appointmentId, comment = null) => {
  const { appointment } = await _requireOwn(token, appointmentId);
  if (!appointment) return null;
  if (appointment.status === "done") return { id: appointment.id, status: "done", already: true };
  if (appointment.status === "pending") {
    throw _error(409, "Aguarde a loja confirmar este agendamento.", "awaiting_approval");
  }
  if (!["confirmed", "in_progress"].includes(appointment.status)) {
    throw _error(409, "Este atendimento não pode ser concluído.", "invalid_status");
  }
  const clean = _cleanComment(comment);
  const note = clean
    ? `Atendimento concluído pelo profissional. Comentário: ${clean}`
    : "Atendimento concluído pelo profissional";
  await ordersService.updateStatus(appointment.order_id, 5, note);
  return { id: appointment.id, status: "done", already: false, completion_note: note };
};

/** Cliente não compareceu: mesmo fluxo do painel (pedido 6 + agendamento 'no_show'). */
const markNoShow = async (token, appointmentId) => {
  const { appointment } = await _requireOwn(token, appointmentId);
  if (!appointment) return null;
  if (appointment.status === "no_show") return { id: appointment.id, status: "no_show", already: true };
  if (!["confirmed", "in_progress"].includes(appointment.status)) {
    throw _error(409, "Este atendimento não pode ser marcado como não comparecimento.", "invalid_status");
  }
  await appointmentsService.markNoShow(appointment.order_id);
  return { id: appointment.id, status: "no_show", already: false };
};

/**
 * Reabrir atendimento concluído (equivale ao "Retornar para rota" do motoboy):
 * agendamento 'done' → 'in_progress' e pedido → 3. O agendamento muda antes do
 * pedido para não deixar os dois divergentes se o horário já tiver sido ocupado.
 */
const reopenAppointment = async (token, appointmentId) => {
  const { appointment } = await _requireOwn(token, appointmentId);
  if (!appointment) return null;
  if (appointment.status === "in_progress") return { id: appointment.id, status: "in_progress", already: true };
  if (appointment.status !== "done") {
    throw _error(409, "Somente atendimentos concluídos podem ser reabertos.", "invalid_status");
  }
  try {
    await pool.query(
      `UPDATE appointments SET status = 'in_progress', updated_at = NOW()
       WHERE id = $1 AND status = 'done'`,
      [appointment.id],
    );
  } catch (e) {
    if (e?.code === "23P01") {
      throw _error(409, "O horário deste atendimento já foi ocupado por outro agendamento.", "slot_taken");
    }
    throw e;
  }
  await ordersService.updateStatus(appointment.order_id, 3, "Atendimento reaberto pelo profissional");
  return { id: appointment.id, status: "in_progress", already: false };
};

/** Foto opcional do atendimento (enviada ao MinIO pelo controller). */
const addPhoto = async (token, appointmentId, { buffer, mimetype, originalname }, upload) => {
  const { professional, appointment } = await _requireOwn(token, appointmentId);
  if (!appointment) return null;
  if (!(await _photosAvailable())) {
    throw _error(503, "Fotos ainda não habilitadas: a migração do banco está pendente.", "photos_unavailable");
  }
  if (!["pending", "confirmed", "in_progress", "done"].includes(appointment.status)) {
    throw _error(409, "Não é possível adicionar fotos a este atendimento.", "invalid_status");
  }
  const mime = String(mimetype || "").toLowerCase();
  if (!ALLOWED_MIME.includes(mime)) throw _error(400, "Formato não suportado. Use JPG, PNG ou WEBP.", "invalid_file");
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM appointment_photos WHERE appointment_id = $1", [
    appointment.id,
  ]);
  if (Number(count.rows[0]?.n || 0) >= MAX_PHOTOS) {
    throw _error(409, `Limite de ${MAX_PHOTOS} fotos por atendimento.`, "photo_limit");
  }

  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const filename = `appointments/${professional.company_id}/${appointment.id}/${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;
  const { url } = await upload(buffer, filename, mime, originalname);
  const inserted = await pool.query(
    `INSERT INTO appointment_photos (appointment_id, company_id, professional_id, url)
     VALUES ($1, $2, $3, $4)
     RETURNING id, url, created_at`,
    [appointment.id, professional.company_id, professional.id, url],
  );
  return inserted.rows[0];
};

/** Remove uma foto do próprio atendimento. */
const removePhoto = async (token, appointmentId, photoId) => {
  const { appointment } = await _requireOwn(token, appointmentId);
  if (!appointment) return null;
  if (!(await _photosAvailable())) return null;
  const id = Number(photoId);
  if (!Number.isInteger(id) || id <= 0) throw _error(400, "Foto inválida.", "invalid_photo");
  const res = await pool.query("DELETE FROM appointment_photos WHERE id = $1 AND appointment_id = $2 RETURNING id", [
    id,
    appointment.id,
  ]);
  return res.rows[0] ? { id, removed: true } : null;
};

/** Fotos de um agendamento (para o detalhe na Agenda do painel). */
const photosForAppointment = async (appointmentId) => {
  const map = await _photosFor([Number(appointmentId)]);
  return map.get(Number(appointmentId)) || [];
};

module.exports = {
  listAppointments,
  startAppointment,
  completeAppointment,
  markNoShow,
  reopenAppointment,
  addPhoto,
  removePhoto,
  photosForAppointment,
  _internal: { MAX_PHOTOS },
};
