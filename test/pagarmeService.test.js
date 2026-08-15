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

test("normaliza e valida a agenda de transferências automáticas", () => {
  assert.deepEqual(
    _testing.normalizeTransferSettings({
      transfer_enabled: true,
      transfer_interval: "weekly",
      transfer_day: 5,
    }),
    { transfer_enabled: true, transfer_interval: "Weekly", transfer_day: 5 },
  );

  assert.throws(
    () => _testing.normalizeTransferSettings({ transfer_enabled: true, transfer_interval: "daily", transfer_day: 1 }),
    { message: "Para transferências diárias, transfer_day deve ser 0." },
  );
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

test("prioriza o endereço informado no pagamento e usa o snapshot do pedido como fallback", () => {
  const snapshotOrder = {
    delivery_address_snapshot: {
      street: "Rua do Pedido",
      number: "45",
      neighborhood: "Centro",
      complement: null,
      city: "Vitória",
      state: "es",
      zip: "29000-000",
    },
  };

  assert.deepEqual(_testing.buildBillingAddress(snapshotOrder), {
    line_1: "45, Rua do Pedido, Centro",
    zip_code: "29000000",
    city: "Vitória",
    state: "ES",
    country: "BR",
  });

  assert.deepEqual(_testing.buildBillingAddress(snapshotOrder, {
    line_1: "101, Avenida da Cobrança, Praia",
    line_2: "Apto 7",
    zip_code: "30140-110",
    city: "Belo Horizonte",
    state: "mg",
  }), {
    line_1: "101, Avenida da Cobrança, Praia",
    line_2: "Apto 7",
    zip_code: "30140110",
    city: "Belo Horizonte",
    state: "MG",
    country: "BR",
  });
});

test("recusa CEP e UF incompletos no endereço de cobrança", () => {
  assert.equal(_testing.toBillingAddress({
    street: "Rua A", number: "1", neighborhood: "Centro", city: "Vitória", state: "E", zip: "29000",
  }), null);
});

test("transforma erro abstrato do provedor em orientação sobre endereço", () => {
  assert.equal(
    _testing.friendlyPaymentValidationMessage({
      message: "Invalid request payload",
      errors: { billing_address: ["line_1 is required"] },
    }),
    "Informe um endereço de cobrança completo: rua, número, bairro, cidade, estado e CEP.",
  );
});

test("recompõe bruto, taxas e líquido usando os campos reais do recebível", () => {
  assert.deepEqual(
    _testing.publicPayable({
      id: 123,
      type: "credit",
      status: "waiting_funds",
      amount: 9450,
      fee: 500,
      anticipation_fee: 0,
      fraud_coverage_fee: 50,
      payment_method: "credit_card",
      installment: 1,
    }),
    {
      id: "123",
      charge_id: null,
      type: "credit",
      status: "waiting_funds",
      payment_method: "credit_card",
      installment: 1,
      created_at: null,
      payment_date: null,
      gross_cents: 10000,
      net_cents: 9450,
      provider_fee_cents: 500,
      anticipation_fee_cents: 0,
      fraud_fee_cents: 50,
    },
  );

  const refund = _testing.publicPayable({ id: "refund-1", type: "refund", amount: 2000 });
  assert.equal(refund.gross_cents, -2000);
  assert.equal(refund.net_cents, -2000);
});

test("calcula a taxa Arbian com a mesma regra usada no split da cobrança", () => {
  // R$ 100,00 em itens + R$ 1,49 de serviço: 10% dos itens + serviço.
  assert.equal(
    _testing.platformSplitCents({ total: 101.49, service_fee: 1.49 }),
    1149,
  );
});

test("calcula somente uma previsão de agenda a partir da configuração", () => {
  const saturday = new Date("2026-08-15T12:00:00Z");
  assert.equal(
    _testing.nextTransferDate({
      transfer_enabled: true,
      transfer_interval: "daily",
      transfer_day: 0,
    }, saturday),
    "2026-08-17",
  );
  assert.equal(
    _testing.nextTransferDate({
      transfer_enabled: true,
      transfer_interval: "weekly",
      transfer_day: 5,
    }, saturday),
    "2026-08-21",
  );
  assert.equal(
    _testing.nextTransferDate({ transfer_enabled: false }, saturday),
    null,
  );
});

test("limita o histórico financeiro ao período suportado pela integração", () => {
  assert.equal(_testing.financialPeriodDays(15), 30);
  assert.equal(_testing.financialPeriodDays(80), 90);
  assert.equal(_testing.financialPeriodDays(900), 730);
});

test("expõe antecipação histórica com todas as taxas discriminadas", () => {
  const item = _testing.publicAnticipation({
    id: "ba_123",
    status: "approved",
    amount: 100000,
    fee: 5000,
    anticipation_fee: 3000,
    fraud_coverage_fee: 0,
    automatic_transfer: false,
  });

  assert.equal(item.gross_amount, 1000);
  assert.equal(item.fees, 80);
  assert.equal(item.net_amount, 920);
  assert.deepEqual(item.fee_breakdown, {
    provider: 50,
    anticipation: 30,
    antifraud: 0,
  });
});
