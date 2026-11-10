process.env.URL_N8N = "https://n8n.example.test/webhook/";
process.env.WEBHOOK_N8N_USER = "test-user";
process.env.WEBHOOK_N8N_PASS = "test-pass";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const orderWebhookService = require("../services/orderWebhookService");

const originalQuery = pool.query;
const originalFetch = global.fetch;

test.after(() => {
  pool.query = originalQuery;
  global.fetch = originalFetch;
});

test("aviso de assinatura envia cliente, empresa, assinatura e mensagem ao webhook dedicado", async () => {
  pool.query = async (sql, params) => {
    assert.match(sql, /LEFT JOIN clients cli ON cli\.id = cs\.client_id AND cli\.company_id = cs\.company_id/);
    assert.match(sql, /FROM user_identifiers ui/);
    assert.deepEqual(params, [42]);
    return {
      rows: [{
        id: 42,
        company_id: 8,
        menu_item_id: 19,
        user_id: "user-3",
        client_id: 27,
        status: "paused",
        amount_cents: 4500,
        interval: "month",
        current_cycle_end: "2026-12-01T00:00:00.000Z",
        items: [{ name: "Plano mensal" }],
        company_name: "Loja Central",
        client_name: "Ana",
        client_phone: "+5511999999999",
        failed_attempts: 2,
      }],
    };
  };
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };

  const sent = await orderWebhookService.notifySubscriptionCustomer(42, "paused", {
    cancelledAppointments: 2,
  });

  assert.equal(sent, true);
  assert.equal(request.url, "https://n8n.example.test/webhook/subscription-notification");
  assert.equal(request.options.method, "POST");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.event, "subscription_notification");
  assert.equal(payload.notification_id, "paused");
  assert.deepEqual(payload.company, { id: 8, name: "Loja Central" });
  assert.equal(payload.customer.phone, "+5511999999999");
  assert.equal(payload.subscription.id, 42);
  assert.equal(payload.subscription.failed_attempts, 2);
  assert.match(payload.message, /2 agendamentos foram cancelados automaticamente/);
  assert.match(request.options.headers.Authorization, /^Basic /);
});

test("aviso usa o telefone verificado da conta quando a assinatura ainda não tem cliente da loja", async () => {
  pool.query = async () => ({ rows: [{
    id: 42,
    user_id: "user-3",
    client_phone: null,
    account_phone: "+5511888888888",
    items: [{ name: "Plano mensal" }],
    amount_cents: 4500,
    interval: "month",
  }] });
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };

  assert.equal(await orderWebhookService.notifySubscriptionCustomer(42, "paused"), true);
  assert.equal(JSON.parse(request.options.body).customer.phone, "+5511888888888");
});

test("aviso de assinatura sem telefone do cliente não chama o n8n", async () => {
  pool.query = async () => ({ rows: [{ id: 42, client_phone: null }] });
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true };
  };

  assert.equal(await orderWebhookService.notifySubscriptionCustomer(42, "ended"), false);
  assert.equal(called, false);
});
