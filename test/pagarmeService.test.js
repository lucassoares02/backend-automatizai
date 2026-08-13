const test = require("node:test");
const assert = require("node:assert/strict");

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
