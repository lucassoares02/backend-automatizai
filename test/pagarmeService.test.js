const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { _testing } = require("../services/pagarmeService");

test("prioriza a decisão estruturada do antifraude sobre mensagem positiva da adquirente", () => {
  const charge = {
    status: "failed",
    last_transaction: {
      acquirer_message: "Transação aprovada com sucesso",
      antifraud_response: {
        status: "reproved",
        return_code: "fraud_reproved",
        return_message: "Recusado pela análise de risco",
        provider_name: "antifraud_provider",
      },
    },
  };

  assert.equal(_testing.isAntifraudDecline(charge), true);
  assert.equal(
    _testing.cardFailureMessage(charge, "antifraud"),
    "Pagamento não aprovado pela análise de segurança.",
  );
});

test("nunca expõe uma mensagem positiva da adquirente para uma cobrança falha", () => {
  const charge = {
    status: "failed",
    last_transaction: { acquirer_message: "Transação aprovada com sucesso" },
  };

  assert.equal(_testing.isAntifraudDecline(charge), false);
  assert.equal(
    _testing.cardFailureMessage(charge, "card_declined"),
    "O pagamento não foi aprovado pelo cartão. Verifique os dados ou tente outro cartão.",
  );
});

test("descarta IP interno e preserva IP público para o antifraude", () => {
  assert.equal(_testing.normalizeClientIp("10.0.0.8"), null);
  assert.equal(_testing.normalizeClientIp("::1"), null);
  assert.equal(_testing.normalizeClientIp("::ffff:200.147.67.12"), "200.147.67.12");
});

test("não duplica a taxa de entrega entre items e shipping da Pagar.me", async (t) => {
  // Pedido 58: produtos R$32,90 + serviço R$1,49 + entrega R$2,00 = R$36,39.
  const result = _testing.itemTotalAfterShipping(3639, 200);

  assert.deepEqual(result, { shippingCents: 200, itemsTotalCents: 3439 });
  assert.equal(result.itemsTotalCents + result.shippingCents, 3639);

  t.mock.method(pool, "query", async () => ({
    rows: [
      { menu_item_id: 1, item_name: "Produto A", quantity: 1, subtotal: "11.00" },
      { menu_item_id: 2, item_name: "Produto B", quantity: 1, subtotal: "21.90" },
    ],
  }));

  const items = await _testing.buildPagarmeItems(
    { id: 58, tag: "ABC", delivery_fee: "2.00", service_fee: "1.49" },
    3639,
    200,
  );

  assert.deepEqual(
    items.map(({ code, amount }) => ({ code, amount })),
    [
      { code: "1", amount: 1100 },
      { code: "2", amount: 2190 },
      { code: "service", amount: 149 },
    ],
  );
  assert.equal(items.reduce((sum, item) => sum + item.amount, 0), 3439);
});
