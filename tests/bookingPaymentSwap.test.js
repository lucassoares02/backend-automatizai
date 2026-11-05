const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const bookingService = require("../services/bookingService");
const orderWebhookService = require("../services/orderWebhookService");
const orderAutoAcceptService = require("../services/orderAutoAcceptService");
const publicService = require("../services/publicService");

// Banco falso: tabelas/colunas existem; o pedido e o agendamento ficam em memória
// e a transação da troca de pagamento é registrada para conferência.
let requiresApproval = false;
let order;
let appointment;
let calls;

const COMPANY = 10;
const CLIENT = 500;
const ORDER = 256;

const query = async (sql, params = []) => {
  calls.push(sql);
  if (sql.includes("to_regclass")) return { rows: [{ name: params[0] }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };
  if (sql.includes("booking_requires_approval")) {
    return { rows: [{ booking_requires_approval: requiresApproval }], rowCount: 1 };
  }
  if (sql.includes("FROM orders o") && sql.includes("FOR UPDATE")) return { rows: [{ ...order }], rowCount: 1 };
  if (sql.includes("FROM payment_methods")) return { rows: [{ id: params[0] }], rowCount: 1 };
  if (sql.includes("FROM payment_attempts")) return { rows: [], rowCount: 0 };
  if (/^\s*UPDATE orders/.test(sql)) {
    if (sql.includes("status = 10")) Object.assign(order, { status: 10, payment_provider: "pagarme" });
    if (sql.includes("status = 1,")) Object.assign(order, { status: 1, payment_provider: null });
    return { rows: [{ id: order.id }], rowCount: 1 };
  }
  if (sql.includes("UPDATE appointments")) {
    if (sql.includes("SET status = 'hold'")) {
      if (!["pending", "confirmed"].includes(appointment.status)) return { rows: [], rowCount: 0 };
      Object.assign(appointment, { status: "hold", hold_expires_at: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (appointment.status !== "hold") return { rows: [], rowCount: 0 };
    Object.assign(appointment, { status: params[1], hold_expires_at: null });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("FROM appointments") && sql.includes("cancel_reason = $2")) {
    const lost = appointment.status === "cancelled" && appointment.cancel_reason === params[1];
    return { rows: lost ? [{}] : [], rowCount: lost ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};

pool.query = query;
pool.connect = async () => ({ query, release: () => {} });
orderWebhookService.notifyAwaitingOrder = () => {};
orderAutoAcceptService.applyToOrder = () => {};

const reset = ({ status, provider = null, appointmentStatus }) => {
  calls = [];
  order = {
    id: ORDER,
    company_id: COMPANY,
    client_id: CLIENT,
    status,
    payment_status: "pending",
    payment_provider: provider,
    pagarme_charge_id: null,
    service_fee: provider ? 1.49 : 0,
    total: provider ? 51.49 : 50,
  };
  appointment = { status: appointmentStatus, hold_expires_at: null, cancel_reason: null };
};

const swap = (extra) =>
  publicService.changePendingOnlinePaymentMethod({ orderId: ORDER, companyId: COMPANY, clientId: CLIENT, ...extra });

test("presencial → online de serviço coloca o agendamento em 'hold' com prazo", async () => {
  for (const appointmentStatus of ["confirmed", "pending"]) {
    reset({ status: 1, appointmentStatus });
    const before = Date.now();
    await swap({ onlinePaymentMethod: "pix" });
    assert.equal(order.status, 10);
    assert.equal(appointment.status, "hold");
    const expires = appointment.hold_expires_at.getTime();
    assert.ok(expires >= before + bookingService.HOLD_MINUTES * 60000);
    assert.ok(expires <= Date.now() + bookingService.HOLD_MINUTES * 60000);
    // Mesma transação: o agendamento muda antes do COMMIT.
    const hold = calls.findIndex((sql) => sql.includes("SET status = 'hold'"));
    assert.ok(hold > 0 && hold < calls.indexOf("COMMIT"));
  }
});

test("pedido de serviço já confirmado (2) não volta para Pagamento Pendente", async () => {
  reset({ status: 2, appointmentStatus: "confirmed" });
  await assert.rejects(swap({ onlinePaymentMethod: "card" }), { status: 409 });
  assert.equal(order.status, 2);
  assert.equal(appointment.status, "confirmed");
  assert.ok(calls.includes("ROLLBACK"));
});

test("online → presencial tira o agendamento de 'hold' conforme o aceite da empresa", async () => {
  reset({ status: 10, provider: "pagarme", appointmentStatus: "hold" });
  await swap({ paymentMethodId: 7 });
  assert.equal(order.status, 1);
  assert.deepEqual(appointment, { status: "confirmed", hold_expires_at: null, cancel_reason: null });

  requiresApproval = true;
  try {
    reset({ status: 10, provider: "pagarme", appointmentStatus: "hold" });
    await swap({ paymentMethodId: 7 });
    assert.equal(appointment.status, "pending");
  } finally {
    requiresApproval = false;
  }
});

test("online → presencial recusa quando o horário reservado já foi liberado", async () => {
  reset({ status: 10, provider: "pagarme", appointmentStatus: "cancelled" });
  appointment.cancel_reason = "hold_expired";
  await assert.rejects(swap({ paymentMethodId: 7 }), { status: 409 });
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.includes("COMMIT"));
});

test("pedido sem agendamento (alimentação) troca normalmente", async () => {
  reset({ status: 1, appointmentStatus: null });
  await swap({ onlinePaymentMethod: "card" });
  assert.equal(order.status, 10);
  assert.equal(appointment.status, null);
});
