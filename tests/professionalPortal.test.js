const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const ordersService = require("../services/ordersService");
const appointmentsService = require("../services/appointmentsService");
const portal = require("../services/professionalPortalService");

const TOKEN = "11111111-2222-4333-8444-555555555555";
const PROFESSIONAL = { id: 4, company_id: 9, name: "Graça", photo_url: null, company_name: "Barbearia" };

// Banco falso: a migração existe, o token resolve o profissional 4 da empresa 9
// e o agendamento só é devolvido quando o escopo (profissional + empresa) bate.
let appointment = null;
let photosCount = 0;
const queries = [];
pool.query = async (sql, params = []) => {
  queries.push({ sql, params });
  if (sql.includes("to_regclass")) return { rows: [{ name: "x" }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };
  if (sql.includes("FROM professionals p") && sql.includes("public_token = $1")) {
    return params[0] === TOKEN ? { rows: [PROFESSIONAL], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes("a.professional_id = $2 AND a.company_id = $3")) {
    const own = appointment && params[1] === PROFESSIONAL.id && params[2] === PROFESSIONAL.company_id;
    return own && params[0] === appointment.id ? { rows: [appointment], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes("COUNT(*)::int AS n FROM appointment_photos")) return { rows: [{ n: photosCount }], rowCount: 1 };
  if (sql.includes("INSERT INTO appointment_photos")) {
    return { rows: [{ id: 1, url: params[3], created_at: new Date() }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

const statusCalls = [];
ordersService.updateStatus = async (id, status, note) => {
  statusCalls.push({ id, status, note });
  return { id, status };
};
const noShowCalls = [];
appointmentsService.markNoShow = async (orderId) => {
  noShowCalls.push(orderId);
  return { id: orderId };
};

test.beforeEach(() => {
  statusCalls.length = 0;
  noShowCalls.length = 0;
  queries.length = 0;
  photosCount = 0;
});

test("token inválido ou desconhecido não abre a tela", async () => {
  assert.equal(await portal.listAppointments("abc"), null);
  assert.equal(await portal.listAppointments("99999999-2222-4333-8444-555555555555"), null);
});

test("lista só agendamentos do profissional do token", async () => {
  await portal.listAppointments(TOKEN);
  const list = queries.find((q) => q.sql.includes("WHERE a.professional_id = $1"));
  assert.ok(list, "consulta de agendamentos não executada");
  assert.equal(list.params[0], PROFESSIONAL.id);
  assert.equal(list.params[1], PROFESSIONAL.company_id);
  assert.doesNotMatch(String(list.params[2]), /hold|cancelled/);
});

test("agendamento de outro profissional responde 404 (null)", async () => {
  appointment = null;
  assert.equal(await portal.startAppointment(TOKEN, 55), null);
  assert.equal(statusCalls.length, 0);
});

test("iniciar leva o pedido a 3 e exige confirmação da loja", async () => {
  appointment = { id: 55, order_id: 700, status: "confirmed" };
  const r = await portal.startAppointment(TOKEN, 55);
  assert.equal(r.status, "in_progress");
  assert.deepEqual(statusCalls.map((c) => [c.id, c.status]), [[700, 3]]);

  appointment = { id: 55, order_id: 700, status: "pending" };
  await assert.rejects(() => portal.startAppointment(TOKEN, 55), { status: 409, code: "awaiting_approval" });
});

test("concluir leva o pedido a 5 com o comentário opcional", async () => {
  appointment = { id: 55, order_id: 700, status: "in_progress" };
  const r = await portal.completeAppointment(TOKEN, 55, "  Retorno em 30 dias  ");
  assert.equal(r.status, "done");
  assert.equal(statusCalls[0].status, 5);
  assert.match(statusCalls[0].note, /Comentário: Retorno em 30 dias$/);

  statusCalls.length = 0;
  appointment = { id: 55, order_id: 700, status: "confirmed" };
  await portal.completeAppointment(TOKEN, 55);
  assert.equal(statusCalls[0].note, "Atendimento concluído pelo profissional");
});

test("não compareceu reaproveita o fluxo do painel", async () => {
  appointment = { id: 55, order_id: 700, status: "confirmed" };
  await portal.markNoShow(TOKEN, 55);
  assert.deepEqual(noShowCalls, [700]);

  appointment = { id: 55, order_id: 700, status: "done" };
  await assert.rejects(() => portal.markNoShow(TOKEN, 55), { status: 409 });
});

test("reabrir só vale para concluído e muda o agendamento antes do pedido", async () => {
  appointment = { id: 55, order_id: 700, status: "done" };
  await portal.reopenAppointment(TOKEN, 55);
  const idx = queries.findIndex((q) => q.sql.includes("SET status = 'in_progress'") && q.sql.includes("status = 'done'"));
  assert.ok(idx >= 0);
  assert.deepEqual(statusCalls.map((c) => c.status), [3]);

  appointment = { id: 55, order_id: 700, status: "confirmed" };
  await assert.rejects(() => portal.reopenAppointment(TOKEN, 55), { status: 409 });
});

test("foto é opcional, validada e guardada no escopo da empresa", async () => {
  appointment = { id: 55, order_id: 700, status: "in_progress" };
  const uploads = [];
  const fakeUpload = async (buffer, filename, mime) => {
    uploads.push({ filename, mime });
    return { url: `https://files/${filename}` };
  };
  const photo = await portal.addPhoto(
    TOKEN,
    55,
    { buffer: Buffer.from("x"), mimetype: "image/jpeg", originalname: "a.jpg" },
    fakeUpload,
  );
  assert.ok(photo.url.includes("appointments/9/55/"));
  assert.equal(uploads[0].mime, "image/jpeg");

  await assert.rejects(
    () => portal.addPhoto(TOKEN, 55, { buffer: Buffer.from("x"), mimetype: "application/pdf" }, fakeUpload),
    { status: 400 },
  );

  photosCount = portal._internal.MAX_PHOTOS;
  await assert.rejects(
    () => portal.addPhoto(TOKEN, 55, { buffer: Buffer.from("x"), mimetype: "image/png" }, fakeUpload),
    { status: 409, code: "photo_limit" },
  );

  appointment = { id: 55, order_id: 700, status: "cancelled" };
  photosCount = 0;
  await assert.rejects(
    () => portal.addPhoto(TOKEN, 55, { buffer: Buffer.from("x"), mimetype: "image/png" }, fakeUpload),
    { status: 409 },
  );
});
