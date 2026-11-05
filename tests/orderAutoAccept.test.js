const test = require("node:test");
const assert = require("node:assert/strict");
const { decideAction } = require("../services/orderAutoAcceptService");

const order = { status: 1, payment_method_type: 4 };

test("aceita automaticamente pedido em dinheiro quando configurado para aceitar", () => {
  assert.equal(
    decideAction(order, { auto_accept_cash_orders: "accept" }),
    "accept",
  );
});

test("recusa automaticamente pedido em dinheiro quando configurado para recusar", () => {
  assert.equal(
    decideAction(order, { auto_accept_cash_orders: "reject" }),
    "reject",
  );
});

test("mantém pedido em dinheiro manual quando configurado como manual", () => {
  assert.equal(
    decideAction(order, { auto_accept_cash_orders: "manual" }),
    null,
  );
});

test("reconhece o valor numérico como string e o identificador legado cash", () => {
  assert.equal(
    decideAction({ ...order, payment_method_type: "4" }, { auto_accept_cash_orders: "accept" }),
    "accept",
  );
  assert.equal(
    decideAction({ ...order, payment_method_type: "cash" }, { auto_accept_cash_orders: "accept" }),
    "accept",
  );
});

test("não aplica a configuração de dinheiro aos outros métodos presenciais", () => {
  assert.equal(
    decideAction({ ...order, payment_method_type: 5 }, { auto_accept_cash_orders: "accept" }),
    null,
  );
  assert.equal(
    decideAction({ ...order, payment_method_type: 6 }, { auto_accept_cash_orders: "reject" }),
    null,
  );
});
