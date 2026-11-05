const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const pagarmeService = require("../services/pagarmeService");
const bookingService = require("../services/bookingService");
const orderWebhookService = require("../services/orderWebhookService");
const ordersService = require("../services/ordersService");

let order;
let queries;
let refundResult;
let refundError;
let refundCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalRefund = pagarmeService.requestRefundForOrder;
const originalSync = bookingService.syncOrderStatus;
const originalNotify = orderWebhookService.notifyStatusChange;
const originalAwaiting = orderWebhookService.notifyAwaitingOrder;

const respond = async (sql, params = []) => {
  queries.push({ sql, params });
  if (sql.includes("information_schema.columns")) return { rows: [], rowCount: 0 };
  if (sql.includes("SELECT") && sql.includes("FROM orders o") && sql.includes("FOR UPDATE")) {
    return { rows: [{ ...order }], rowCount: 1 };
  }
  if (/UPDATE orders\s+SET status/.test(sql)) {
    order.status = params[1];
    order.cancel_reason = params[2];
    return { rows: [{ ...order }], rowCount: 1 };
  }
  if (sql.includes("SET payment_status = 'refund_pending'")) {
    order.payment_status = "refund_pending";
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
};

const reset = ({ status = 1, paymentStatus = "paid", provider = "pagarme", chargeId = "ch_123" } = {}) => {
  order = {
    id: 91,
    status,
    payment_status: paymentStatus,
    payment_provider: provider,
    pagarme_charge_id: chargeId,
    stock_reserved: false,
  };
  queries = [];
  refundCalls = [];
  refundResult = { status: "refunded" };
  refundError = null;
};

pool.query = respond;
pool.connect = async () => ({ query: respond, release() {} });
bookingService.syncOrderStatus = async () => {};
orderWebhookService.notifyStatusChange = () => {};
orderWebhookService.notifyAwaitingOrder = () => {};
pagarmeService.requestRefundForOrder = async (...args) => {
  refundCalls.push(args);
  if (refundError) throw refundError;
  order.payment_status = refundResult.status;
  return refundResult;
};

test.after(() => {
  pool.query = originalQuery;
  pool.connect = originalConnect;
  pagarmeService.requestRefundForOrder = originalRefund;
  bookingService.syncOrderStatus = originalSync;
  orderWebhookService.notifyStatusChange = originalNotify;
  orderWebhookService.notifyAwaitingOrder = originalAwaiting;
});

test("estorna pagamento Pagar.me pago quando a loja cancela ou recusa", async () => {
  for (const status of [6, 7]) {
    reset();
    const updated = await ordersService.updateStatus(91, status, "Sem disponibilidade");
    assert.deepEqual(refundCalls, [[91, "ch_123"]]);
    assert.equal(order.status, status);
    assert.equal(updated.payment_status, "refunded");
    assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
  }
});

test("falha ao pedir estorno mantém o pedido cancelado e marca refund_pending", async () => {
  reset();
  refundError = new Error("indisponível");
  const updated = await ordersService.updateStatus(91, 7, "Recusado");
  assert.equal(order.status, 7);
  assert.equal(order.payment_status, "refund_pending");
  assert.equal(updated.payment_status, "refund_pending");
  assert.ok(queries.some(({ sql }) => sql.includes("SET payment_status = 'refund_pending'")));
});

test("não solicita estorno para hold vencido não pago nem para outros meios", async () => {
  reset({ status: 10, paymentStatus: "pending" });
  await ordersService.updateStatus(91, 6, "hold_expired");
  assert.equal(refundCalls.length, 0);

  reset({ provider: "stripe" });
  await ordersService.updateStatus(91, 6, "Cancelado");
  assert.equal(refundCalls.length, 0);
});
