const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const pagarmeService = require("../services/pagarmeService");
const productOptionsService = require("../services/productOptionsService");
const merchantNotifications = require("../services/merchantNotificationsService");
const orderWebhookService = require("../services/orderWebhookService");
const subscriptionBookingService = require("../services/subscriptionBookingService");
const subscriptionsService = require("../services/subscriptionsService");

test.after(() => pool.end());

// ─── Ações do cliente/loja com banco e Pagar.me simulados ────────────────────

const SUB_ROW = {
  id: 50, company_id: 5, menu_item_id: 9, user_id: "user-1", status: "active", interval: "month",
  amount_cents: 4990, items: [{ name: "Plano" }], pagarme_subscription_id: "sub_1",
};

// `route(q, params)` responde as consultas específicas do teste; o resto é comum.
const withFakes = async (route, stubs, fn) => {
  const log = [];
  const handle = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    log.push(q);
    if (q.includes("to_regclass") || q.includes("information_schema")) return { rowCount: 1, rows: [{ name: "x" }] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [] };
    const hit = await route(q, params);
    if (hit) return hit;
    if (q.startsWith("SELECT * FROM customer_subscriptions WHERE id = $1 AND user_id = $2")) return { rows: [{ ...SUB_ROW }] };
    if (q.includes("FROM customer_subscriptions cs")) return { rows: [{ ...SUB_ROW, item_type: "product" }] };
    if (q.includes("FROM subscription_invoices WHERE subscription_id = $1 ORDER BY created_at DESC")) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  const targets = [
    [pool, "query", handle],
    [pool, "connect", async () => ({ query: handle, release: () => {} })],
    [merchantNotifications, "notify", async () => true],
    [orderWebhookService, "notifySubscriptionCustomer", async () => true],
    [subscriptionBookingService, "cancelAfterClose", async () => []],
    ...stubs,
  ];
  const originals = targets.map(([obj, key]) => [obj, key, obj[key]]);
  for (const [obj, key, value] of targets) obj[key] = value;
  // Contratar exige a loja liberada (geral ou em teste); a loja simulada é a 5.
  const previewIds = process.env.SUBSCRIPTIONS_PREVIEW_COMPANY_IDS;
  process.env.SUBSCRIPTIONS_PREVIEW_COMPANY_IDS = "5";
  try {
    await fn(log);
  } finally {
    for (const [obj, key, value] of originals) obj[key] = value;
    if (previewIds === undefined) delete process.env.SUBSCRIPTIONS_PREVIEW_COMPANY_IDS;
    else process.env.SUBSCRIPTIONS_PREVIEW_COMPANY_IDS = previewIds;
  }
};

const subscribeStubs = (createSubscription) => [
  [pagarmeService, "assertCompanyRecipientActive", async () => ({ pagarme_recipient_id: "rp_loja", statementDescriptor: "LOJA" })],
  [pagarmeService, "platformRecipientId", () => "rp_arbian"],
  [pagarmeService, "resolveSavedCardForUser", async () => ({ id: 4, card_id: "card_1" })],
  [pagarmeService, "getUserPagarmeCustomerId", async () => "cus_1"],
  [pagarmeService, "createSubscription", createSubscription],
  [pagarmeService, "listSubscriptionInvoices", async () => { throw new Error("sem rede"); }],
  [productOptionsService, "validateSelections", async () => ({ snapshot: [] })],
];

const ITEM = {
  id: 9, company_id: 5, name: "Plano", description: "", price: 49.9, item_type: "product",
  subscription_interval: "month", subscription_duration_cycles: null, subscription_usage_limit: null,
};

const subscribeRoute = (insert) => async (q, params) => {
  if (q.startsWith("SELECT id FROM customer_subscriptions WHERE user_id = $1 AND client_request_id = $2")) return { rows: [] };
  if (q.includes("FROM menu_items")) return { rows: [ITEM] };
  if (q.startsWith("INSERT INTO customer_subscriptions")) return insert(params);
  return null;
};

const input = { clientRequestId: "req_1234567890abcdef", menuItemId: 9, paymentMethodId: 4 };

test("contratar: loja fora da liberação (geral ou de teste) responde 404 sem chamar a Pagar.me", async () => {
  let calls = 0;
  const create = async () => { calls += 1; return { id: "sub_x" }; };
  await withFakes(subscribeRoute(() => ({ rows: [{ id: 50 }] })), subscribeStubs(create), async (log) => {
    process.env.SUBSCRIPTIONS_PREVIEW_COMPANY_IDS = "25";
    await assert.rejects(subscriptionsService.subscribe("user-1", input), (err) => err.status === 404);
    assert.equal(calls, 0);
    assert.ok(!log.some((q) => q.startsWith("INSERT INTO customer_subscriptions")));
  });
});

test("contratar: timeout na Pagar.me repete com a mesma chave e aproveita a assinatura criada", async () => {
  const calls = [];
  const create = async (body, key) => {
    calls.push(key);
    if (calls.length === 1) throw new Error("timeout of 15000ms exceeded");
    return { id: "sub_1", status: "active" };
  };
  await withFakes(subscribeRoute(() => ({ rows: [{ id: 50 }] })), subscribeStubs(create), async (log) => {
    const out = await subscriptionsService.subscribe("user-1", input);
    assert.equal(out.id, 50);
    assert.deepEqual(calls, ["automatizai:subscription:50", "automatizai:subscription:50"]);
    assert.ok(log.some((q) => q.startsWith("UPDATE customer_subscriptions SET pagarme_subscription_id = $2")));
    assert.ok(!log.some((q) => q.includes("SET status = 'canceled'")));
  });
});

test("contratar: recusa definitiva (4xx) não repete e fecha a linha local", async () => {
  let calls = 0;
  const create = async () => {
    calls += 1;
    throw Object.assign(new Error("Cartão inválido"), { status: 400 });
  };
  await withFakes(subscribeRoute(() => ({ rows: [{ id: 50 }] })), subscribeStubs(create), async (log) => {
    await assert.rejects(subscriptionsService.subscribe("user-1", input), (err) => err.status === 400);
    assert.equal(calls, 1);
    assert.ok(log.some((q) => q.includes("SET status = 'canceled'") && q.includes("pagarme_subscription_id IS NULL")));
  });
});

test("contratar: duas contratações simultâneas do mesmo item — o índice único vira 409", async () => {
  const insert = () => {
    throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "customer_subscriptions_open_item_uidx" });
  };
  await withFakes(subscribeRoute(insert), subscribeStubs(async () => ({ id: "sub_x" })), async () => {
    await assert.rejects(subscriptionsService.subscribe("user-1", input), (err) => err.status === 409);
  });
});

test("trocar cartão: erro de comunicação na recobrança devolve a fatura para a fila de retentativas", async () => {
  const nextRetry = new Date("2026-11-11T12:00:00.000Z");
  const updates = [];
  const route = async (q, params) => {
    if (q.startsWith("SELECT * FROM subscription_invoices WHERE subscription_id = $1 AND status = 'failed'")) {
      return { rows: [{ id: 7, subscription_id: 50, status: "failed", pagarme_charge_id: "ch_7", next_retry_at: nextRetry }] };
    }
    if (q.startsWith("UPDATE subscription_invoices")) {
      updates.push({ q, params });
      return { rows: [{ id: 7 }], rowCount: 1 };
    }
    return null;
  };
  const stubs = [
    [pagarmeService, "resolveSavedCardForUser", async () => ({ id: 4, card_id: "card_2" })],
    [pagarmeService, "updateSubscriptionCard", async () => ({})],
    [pagarmeService, "retryCharge", async () => { throw new Error("socket hang up"); }],
  ];
  await withFakes(route, stubs, async () => {
    const out = await subscriptionsService.changeCard("user-1", 50, { paymentMethodId: 4 });
    assert.equal(out.retry_error, "socket hang up");
    // 1) reserva (zera o next_retry_at); 2) devolve o horário que tinha.
    assert.equal(updates.length, 2);
    assert.match(updates[0].q, /next_retry_at IS NOT DISTINCT FROM \$2/);
    assert.match(updates[1].q, /COALESCE\(\$2::timestamptz/);
    assert.deepEqual(updates[1].params, [7, nextRetry, true]);
  });
});

test("cancelar: trava a linha durante a chamada à Pagar.me e grava canceled_by de quem pediu", async () => {
  const order = [];
  const route = async (q) => {
    if (q.startsWith("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE")) {
      order.push("lock");
      return { rows: [{ ...SUB_ROW }] };
    }
    if (q.startsWith("UPDATE customer_subscriptions SET status = 'canceled'")) {
      order.push("close");
      return { rows: [], rowCount: 1 };
    }
    if (q === "COMMIT") order.push("commit");
    return null;
  };
  const customer = [];
  const stubs = [
    [pagarmeService, "cancelSubscription", async () => { order.push("provider"); return {}; }],
    [orderWebhookService, "notifySubscriptionCustomer", async (id, kind, details) => { customer.push({ kind, details }); return true; }],
  ];
  await withFakes(route, stubs, async (log) => {
    await subscriptionsService.cancelByCustomer("user-1", 50);
    assert.deepEqual(order, ["lock", "provider", "close"]);
    assert.ok(log.indexOf("COMMIT") > log.findIndex((q) => q.startsWith("UPDATE customer_subscriptions SET status = 'canceled'")));
    assert.deepEqual(customer, [{ kind: "canceled", details: { canceledBy: "customer", cancelledAppointments: 0 } }]);
  });
});

test("cancelar: falha na Pagar.me desfaz e não avisa ninguém", async () => {
  const route = async (q) => (q.startsWith("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE") ? { rows: [{ ...SUB_ROW }] } : null);
  let notified = false;
  const stubs = [
    [pagarmeService, "cancelSubscription", async () => { throw Object.assign(new Error("indisponível"), { status: 502 }); }],
    [orderWebhookService, "notifySubscriptionCustomer", async () => { notified = true; return true; }],
  ];
  await withFakes(route, stubs, async (log) => {
    await assert.rejects(subscriptionsService.cancelByCustomer("user-1", 50), (err) => err.status === 502);
    assert.ok(log.includes("ROLLBACK"));
    assert.ok(!log.some((q) => q.startsWith("UPDATE customer_subscriptions SET status = 'canceled'")));
    assert.equal(notified, false);
  });
});

test("cancelar: assinatura já encerrada (webhook chegou antes) responde 409", async () => {
  const route = async (q) => (q.startsWith("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE")
    ? { rows: [{ ...SUB_ROW, status: "canceled" }] } : null);
  await withFakes(route, [], async () => {
    await assert.rejects(subscriptionsService.cancelByCustomer("user-1", 50), (err) => err.status === 409);
  });
});
