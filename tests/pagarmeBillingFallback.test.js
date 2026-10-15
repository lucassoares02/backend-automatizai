const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { _testing } = require("../services/pagarmeService");

test.after(() => pool.end());

test("endereço de cobrança incompleto da tela cai no endereço do pedido", () => {
  const order = {
    delivery_address_snapshot: {
      street: "Rua do Pedido", number: "45", neighborhood: "Centro",
      city: "Vitória", state: "ES", zip: "29000-000",
    },
  };
  assert.deepEqual(_testing.buildBillingAddress(order, { line_1: "", zip_code: "290" }), {
    line_1: "45, Rua do Pedido, Centro",
    zip_code: "29000000",
    city: "Vitória",
    state: "ES",
    country: "BR",
  });
});

test("retirada sem endereço conhecido continua sem billing", () => {
  assert.equal(_testing.buildBillingAddress({}, { line_1: "" }), null);
});

test("endereço válido da tela tem precedência sobre o do pedido", () => {
  const order = {
    delivery_address_snapshot: {
      street: "Rua do Pedido", number: "45", neighborhood: "Centro",
      city: "Vitória", state: "ES", zip: "29000-000",
    },
  };
  assert.equal(
    _testing.buildBillingAddress(order, {
      line_1: "24, Rua Rio Purús, Hélio Ferraz",
      zip_code: "29160-516",
      city: "Serra",
      state: "ES",
    }).zip_code,
    "29160516",
  );
});
