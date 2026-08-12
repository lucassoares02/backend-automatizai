const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PAGARME_PAYMENT_SESSION_SECRET = "test-payment-session-secret";
const {
  createPaymentSession,
  verifyPaymentSession,
} = require("../helpers/publicPaymentSession");

test("cria e valida uma sessão de pagamento vinculada ao pedido", () => {
  const token = createPaymentSession({
    orderId: 42,
    orderUuid: "b67f1df2-5d44-4f9e-b4c5-3a03d5a0f660",
    companyId: 7,
    clientId: 13,
  });
  const session = verifyPaymentSession(token);

  assert.equal(session.order_id, 42);
  assert.equal(session.company_id, 7);
  assert.equal(session.client_id, 13);
  assert.equal(session.customer_verified, undefined);
});

test("rejeita token alterado", () => {
  const token = createPaymentSession({ orderId: 1, orderUuid: "uuid", companyId: 1, clientId: 1 });
  assert.equal(verifyPaymentSession(`${token}x`), null);
});
