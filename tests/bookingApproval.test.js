const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const bookingService = require("../services/bookingService");
const orderAutoAcceptService = require("../services/orderAutoAcceptService");
const ordersService = require("../services/ordersService");
const orderWebhookService = require("../services/orderWebhookService");

// Banco falso: tabelas/colunas existem e a empresa aprova (ou não) manualmente.
let requiresApproval = false;
let serviceOrder = { status: 1 };
pool.query = async (sql) => {
  if (sql.includes("to_regclass")) return { rows: [{ name: "x" }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };
  if (sql.includes("booking_requires_approval") && sql.includes("FROM orders o")) {
    if (sql.includes("EXISTS (SELECT 1 FROM appointments")) {
      return serviceOrder
        ? { rows: [{ status: serviceOrder.status, requires_approval: requiresApproval }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [{ booking_requires_approval: requiresApproval }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

const fakeDb = () => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (sql.includes("booking_requires_approval")) {
        return { rows: [{ booking_requires_approval: requiresApproval }], rowCount: 1 };
      }
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
};

test("aceite da loja (2) confirma agendamento pendente", async () => {
  const db = fakeDb();
  await bookingService.syncOrderStatus(db, 7, 2);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /SET status = 'confirmed'/);
  assert.match(db.calls[0].sql, /status IN \('hold', 'pending'\)/);
});

test("recusa (7) libera o horário inclusive de agendamento pendente", async () => {
  const db = fakeDb();
  await bookingService.syncOrderStatus(db, 7, 7);
  assert.match(db.calls[0].sql, /SET status = 'cancelled'/);
  assert.match(db.calls[0].sql, /'pending'/);
  assert.deepEqual(db.calls[0].params, [7, "rejected"]);
});

test("voltar a Pendente com aprovação manual devolve o agendamento a 'pending'", async () => {
  requiresApproval = true;
  const db = fakeDb();
  await bookingService.syncOrderStatus(db, 7, 1);
  assert.match(db.calls[0].sql, /SET status = 'pending'/);
  requiresApproval = false;
  const auto = fakeDb();
  await bookingService.syncOrderStatus(auto, 7, 1);
  assert.match(auto.calls[0].sql, /SET status = 'confirmed'/);
  assert.match(auto.calls[0].sql, /status = 'hold'/);
});

test("agendamento é aceito automaticamente por padrão", async () => {
  const original = ordersService.updateStatus;
  const calls = [];
  ordersService.updateStatus = async (...args) => {
    calls.push(args);
    return { id: args[0] };
  };
  try {
    requiresApproval = false;
    serviceOrder = { status: 1 };
    assert.equal(await orderAutoAcceptService.applyToOrder(42), "accept");
    assert.deepEqual(calls[0], [42, 2, null, { onlyFrom: 1 }]);
  } finally {
    ordersService.updateStatus = original;
  }
});

test("com aceite manual o agendamento fica pendente e o cliente é avisado", async () => {
  const originalUpdate = ordersService.updateStatus;
  const originalNotify = orderWebhookService.notifyAppointmentEvent;
  const updates = [];
  const notified = [];
  ordersService.updateStatus = async (...args) => updates.push(args);
  orderWebhookService.notifyAppointmentEvent = async (...args) => notified.push(args);
  try {
    requiresApproval = true;
    serviceOrder = { status: 1 };
    assert.equal(await orderAutoAcceptService.applyToOrder(43), null);
    assert.equal(updates.length, 0);
    assert.deepEqual(notified, [[43, "awaiting_approval"]]);
  } finally {
    ordersService.updateStatus = originalUpdate;
    orderWebhookService.notifyAppointmentEvent = originalNotify;
    requiresApproval = false;
  }
});

test("mensagem de recusa troca {motivo} e não deixa espaço duplo sem motivo", () => {
  const tpl = "Olá {cliente}, recusado. {motivo} Escolha outro horário.";
  assert.equal(
    orderWebhookService.renderServiceMessage(tpl, { cliente: "Ana", motivo: "Profissional doente." }),
    "Olá Ana, recusado. Profissional doente. Escolha outro horário.",
  );
  assert.equal(
    orderWebhookService.renderServiceMessage(tpl, { cliente: "Ana", motivo: "" }),
    "Olá Ana, recusado. Escolha outro horário.",
  );
});
