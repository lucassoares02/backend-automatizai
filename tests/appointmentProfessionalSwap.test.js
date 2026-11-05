const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const slots = require("../helpers/bookingSlots");
const appointmentsService = require("../services/appointmentsService");
const orderWebhookService = require("../services/orderWebhookService");

// Terça, 10/11/2026, 14:00 em São Paulo (UTC-3). Serviço de 60 min.
const TZ = "America/Sao_Paulo";
const at = (hhmm) => new Date(`2026-11-10T${hhmm}:00-03:00`);
const WORKDAY = [{ weekday: 2, start_time: "09:00", end_time: "18:00" }];

test("checkStartAt: livre dentro da jornada, mesmo fora da grade de slots", () => {
  const r = slots.checkStartAt({
    startsAt: at("14:10"),
    timezone: TZ,
    openingHours: [],
    workingHours: WORKDAY,
    durationMinutes: 60,
    bufferMinutes: 10,
  });
  assert.equal(r.ok, true);
  assert.equal(r.endsAt.getTime(), at("15:10").getTime());
  assert.equal(r.blockedUntil.getTime(), at("15:20").getTime());
});

test("checkStartAt: ocupado, folga e fora da jornada", () => {
  const base = { startsAt: at("14:00"), timezone: TZ, openingHours: [], workingHours: WORKDAY, durationMinutes: 60 };
  assert.equal(slots.checkStartAt({ ...base, busy: [{ start: at("14:30"), end: at("15:30") }] }).reason, "busy");
  // Buffer do serviço também não pode encostar no próximo agendamento.
  assert.equal(
    slots.checkStartAt({ ...base, bufferMinutes: 15, busy: [{ start: at("15:10"), end: at("16:00") }] }).reason,
    "busy",
  );
  assert.equal(slots.checkStartAt({ ...base, timeOff: [{ start: at("13:00"), end: at("14:30") }] }).reason, "time_off");
  assert.equal(
    slots.checkStartAt({ ...base, workingHours: [{ weekday: 2, start_time: "09:00", end_time: "14:30" }] }).reason,
    "outside_hours",
  );
  assert.equal(slots.checkStartAt({ ...base, workingHours: [{ ...WORKDAY[0], weekday: 3 }] }).reason, "outside_hours");
  // Loja fechada no horário vence a jornada do profissional.
  assert.equal(
    slots.checkStartAt({ ...base, openingHours: [{ weekday: 2, opens_at: "08:00", closes_at: "12:00" }] }).reason,
    "outside_hours",
  );
  assert.equal(slots.checkStartAt({ ...base, busy: [{ start: at("15:00"), end: at("16:00") }] }).ok, true);
});

// ─── Banco falso ─────────────────────────────────────────────────────────────
// Agendamento 1 (prof. 1) às 14:00. Candidatos: 2 livre, 3 ocupado às 14:30,
// 4 só trabalha de manhã, 5 de folga à tarde.
const APPOINTMENT = { id: 1, company_id: 10, order_id: 100, order_item_id: 200, menu_item_id: 50, professional_id: 1, status: "confirmed", starts_at: at("14:00") };
const PROFESSIONALS = [1, 2, 3, 4, 5].map((id) => ({ id, name: `Prof ${id}`, photo_url: null, price_override: null, duration_override: null }));
const HOURS = {
  1: WORKDAY,
  2: WORKDAY,
  3: WORKDAY,
  4: [{ weekday: 2, start_time: "09:00", end_time: "12:00" }],
  5: WORKDAY,
};
const BUSY = [
  { id: 1, professional_id: 1, start: at("14:00"), end: at("15:00") },
  { id: 9, professional_id: 3, start: at("14:30"), end: at("15:30") },
];
const TIME_OFF = [{ professional_id: 5, start: at("13:00"), end: at("18:00") }];

let updates;
const query = async (sql, params = []) => {
  if (sql.includes("to_regclass")) return { rows: [{ name: params[0] }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };
  if (/SELECT \* FROM appointments WHERE id = \$1/.test(sql)) return { rows: [{ ...APPOINTMENT }], rowCount: 1 };
  if (sql.includes("FROM companies")) {
    return { rows: [{ id: 10, name: "Loja", timezone: TZ, booking_slot_step_minutes: 30 }], rowCount: 1 };
  }
  if (sql.includes("FROM menu_items")) {
    return { rows: [{ id: 50, name: "Corte", price: 40, duration_minutes: 60, buffer_minutes: 0 }], rowCount: 1 };
  }
  if (sql.includes("FROM professional_services ps") && sql.includes("JOIN professionals p")) {
    const only = params[2] ? Number(params[2]) : null;
    const rows = PROFESSIONALS.filter((p) => !only || p.id === only);
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("FROM professionals p") && sql.includes("LEFT JOIN professional_services")) {
    const rows = PROFESSIONALS.filter((p) => p.id === Number(params[2]));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("SELECT 1 FROM appointments") && sql.includes("professional_id = $1")) {
    const [prof, , start, end, exclude] = params;
    const rows = BUSY.filter((b) => b.professional_id === prof && b.id !== exclude && b.start < end && b.end > start);
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("FROM appointments a") && sql.includes("a.professional_id = ANY")) {
    const [ids, , , , exclude] = params;
    const rows = BUSY.filter((b) => ids.includes(b.professional_id) && b.id !== exclude);
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("FROM professional_time_off")) {
    const rows = TIME_OFF.filter((t) => params[0].includes(t.professional_id));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("FROM professional_working_hours")) {
    const rows = params[0].flatMap((id) => (HOURS[id] || []).map((h) => ({ professional_id: id, ...h })));
    return { rows, rowCount: rows.length };
  }
  if (/^\s*UPDATE appointments\s+SET professional_id/.test(sql)) updates.push({ sql, params });
  return { rows: [], rowCount: 0 };
};

pool.query = query;
pool.connect = async () => ({ query, release: () => {} });
let notified;
orderWebhookService.notifyAppointmentEvent = (...args) => notified.push(args);

test("lista só profissionais livres no horário do agendamento (sem o atual)", async () => {
  const data = await appointmentsService.professionalOptions(1);
  assert.deepEqual(
    data.professionals.map((p) => p.id),
    [2],
  );
  assert.equal(data.current_professional_id, 1);
  assert.deepEqual(data.unavailable, { busy: 1, time_off: 1, outside_hours: 1 });
});

test("lista considera o novo horário informado", async () => {
  // 16:00: o 3 já está livre; o 5 continua de folga e o 4 fora da jornada.
  const data = await appointmentsService.professionalOptions(1, { startsAt: at("16:00").toISOString() });
  assert.deepEqual(
    data.professionals.map((p) => p.id),
    [2, 3],
  );
});

test("salvar troca para profissional livre grava sem avisar remarcação", async () => {
  updates = [];
  notified = [];
  await appointmentsService.rescheduleByStore(1, { professionalId: 2 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 2);
  assert.equal(updates[0].params[5], 0, "mesmo horário não conta como remarcação");
  assert.equal(notified.length, 0);
});

test("salvar troca para profissional ocupado é bloqueado (inclusive com force)", async () => {
  for (const force of [false, true]) {
    updates = [];
    await assert.rejects(
      appointmentsService.rescheduleByStore(1, { professionalId: 3, force }),
      (err) => err.status === 409 && err.code === "BOOKING_SLOT_TAKEN",
    );
    assert.equal(updates.length, 0);
  }
});

test("salvar troca para profissional fora da jornada ou de folga é bloqueado", async () => {
  for (const professionalId of [4, 5]) {
    await assert.rejects(
      appointmentsService.rescheduleByStore(1, { professionalId }),
      (err) => err.status === 409,
    );
  }
});

test("alterar horário grava e avisa o cliente", async () => {
  updates = [];
  notified = [];
  await appointmentsService.rescheduleByStore(1, { startsAt: at("16:10").toISOString() });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[2].getTime(), at("16:10").getTime());
  assert.equal(updates[0].params[5], 1);
  assert.deepEqual(notified, [[100, "rescheduled"]]);
});
