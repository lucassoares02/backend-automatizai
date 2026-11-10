const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const pagarmeService = require("../services/pagarmeService");
const subscriptionsService = require("../services/subscriptionsService");
const billing = require("../helpers/subscriptionBilling");
const merchantNotifications = require("../services/merchantNotificationsService");
const orderWebhookService = require("../services/orderWebhookService");
const subscriptionBookingService = require("../services/subscriptionBookingService");

test.after(() => pool.end());

// ─── Split percentual e itens ────────────────────────────────────────────────

test("split da recorrência: objeto enabled/rules, 95% loja e 5% Arbian, só percentual inteiro", () => {
  const { split, merchantPercent, platformPercent } = billing.buildSubscriptionSplit({
    merchantRecipientId: "rp_loja",
    platformRecipientId: "rp_arbian",
  });
  assert.equal(merchantPercent, 95);
  assert.equal(platformPercent, 5);
  assert.equal(split.enabled, true);
  assert.deepEqual(split.rules.map((r) => [r.recipient_id, r.amount, r.type]), [
    ["rp_loja", 95, "percentage"],
    ["rp_arbian", 5, "percentage"],
  ]);
  assert.ok(split.rules.every((r) => Number.isInteger(r.amount)));
  assert.equal(split.rules.reduce((s, r) => s + r.amount, 0), 100);
  // A loja responde por chargeback, taxas e resto; a Arbian por nada.
  assert.deepEqual(split.rules[0].options, { charge_processing_fee: true, charge_remainder_fee: true, liable: true });
  assert.deepEqual(split.rules[1].options, { charge_processing_fee: false, charge_remainder_fee: false, liable: false });
});

test("split recusa loja sem recebedor (409) e plataforma sem recebedor (503)", () => {
  assert.throws(() => billing.buildSubscriptionSplit({ platformRecipientId: "rp_a" }), { status: 409 });
  assert.throws(() => billing.buildSubscriptionSplit({ merchantRecipientId: "rp_l" }), { status: 503 });
});

test("parte da Arbian na assinatura: 5% sem taxa fixa", () => {
  assert.equal(billing.subscriptionPlatformSplitCents(4990), 250);
  assert.equal(billing.subscriptionPlatformSplitCents(10000, 5), 500);
  assert.equal(pagarmeService._testing.subscriptionPlatformSplitCents({ amount_cents: 2000, platform_split_percent: 5 }), 100);
});

test("itens espelham o produto e as opções pagas; entrega não vira item", () => {
  const { items, amountCents } = billing.buildSubscriptionItems({
    item: { name: "Marmita semanal", description: "5 marmitas", price: 120 },
    options: [
      { group_name: "Proteína", option_name: "Frango", additional_price: 0, quantity: 1 },
      { group_name: "Extra", option_name: "Suco", additional_price: 4.5, quantity: 2 },
    ],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].pricing_scheme, { scheme_type: "unit", price: 12000 });
  assert.match(items[0].description, /Frango/);
  assert.equal(items[1].quantity, 2);
  assert.equal(items[1].pricing_scheme.price, 450);
  assert.equal(amountCents, 12900);
  assert.ok(!items.some((it) => /entrega/i.test(it.name)));
});

// ─── Máquina de estados (pura) ───────────────────────────────────────────────

const sub = (extra = {}) => ({ id: 1, status: "active", paid_cycles: 1, duration_cycles: null, ...extra });
const inv = (extra = {}) => ({ id: 10, status: "pending", failed_attempts: 0, ...extra });

test("1ª cobrança paga ativa; fatura paga não conta duas vezes", () => {
  const first = billing.applyInvoicePaid(sub({ status: "pending", paid_cycles: 0 }), inv());
  assert.equal(first.subscription.status, "active");
  assert.equal(first.subscription.paid_cycles, 1);
  const again = billing.applyInvoicePaid(first.subscription, first.invoice);
  assert.equal(again.changed, false);
  assert.equal(again.subscription.paid_cycles, 1);
});

test("recusa: 2 retentativas e depois pausa; pagamento retoma (active → paused → active)", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  let s = sub();
  let i = inv();
  let r = billing.applyPaymentFailed(s, i, { transactionId: "tran_1", now, retryHours: 24 });
  assert.equal(r.subscription.status, "active");
  assert.equal(r.invoice.failed_attempts, 1);
  assert.equal(r.invoice.next_retry_at.toISOString(), "2026-11-10T12:00:00.000Z");

  // Mesma transação (charge.payment_failed + invoice.payment_failed) conta uma vez.
  const dup = billing.applyPaymentFailed(r.subscription, r.invoice, { transactionId: "tran_1", now });
  assert.equal(dup.changed, false);

  r = billing.applyPaymentFailed(r.subscription, r.invoice, { transactionId: "tran_2", now });
  assert.equal(r.subscription.status, "active");
  r = billing.applyPaymentFailed(r.subscription, r.invoice, { transactionId: "tran_3", now });
  assert.equal(r.subscription.status, "paused");
  assert.equal(r.invoice.failed_attempts, billing.MAX_ATTEMPTS);
  assert.equal(r.invoice.next_retry_at, null);

  s = r.subscription;
  i = r.invoice;
  const paid = billing.applyInvoicePaid(s, i, { otherFailedInvoices: 0 });
  assert.equal(paid.subscription.status, "active");
  assert.equal(paid.subscription.paused_at, null);
  // Outra fatura ainda recusada mantém pausada.
  assert.equal(billing.applyInvoicePaid(s, i, { otherFailedInvoices: 1 }).subscription.status, "paused");
});

test("recusa sem id de transação: eventos repetidos em 10 min contam uma vez", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const r = billing.applyPaymentFailed(sub(), inv(), { now });
  const later = new Date(now.getTime() + 60 * 1000);
  assert.equal(billing.applyPaymentFailed(r.subscription, r.invoice, { now: later }).changed, false);
});

test("recusa da 1ª cobrança cancela a contratação e para na Pagar.me", () => {
  const r = billing.applyPaymentFailed(sub({ status: "pending", paid_cycles: 0 }), inv(), { transactionId: "t" });
  assert.equal(r.subscription.status, "canceled");
  assert.equal(r.subscription.cancel_reason, "first_payment_failed");
  assert.equal(r.cancelProvider, true);
});

test("prazo de N cobranças: a N-ésima fatura paga encerra (ended) e cancela na Pagar.me", () => {
  const r = billing.applyInvoicePaid(sub({ paid_cycles: 11, duration_cycles: 12 }), inv());
  assert.equal(r.subscription.status, "ended");
  assert.equal(r.subscription.paid_cycles, 12);
  assert.equal(r.cancelProvider, true);
  // Sem prazo nunca encerra sozinha.
  assert.equal(billing.applyInvoicePaid(sub({ paid_cycles: 500 }), inv()).subscription.status, "active");
});

test("chargeback cancela; cancelada/encerrada não reabre", () => {
  const r = billing.applyChargeback(sub(), inv({ status: "paid" }));
  assert.equal(r.subscription.status, "canceled");
  assert.equal(r.subscription.cancel_reason, "chargeback");
  assert.equal(r.invoice.status, "chargedback");
  assert.equal(billing.applyInvoicePaid(r.subscription, inv()).subscription.status, "canceled");
  assert.equal(billing.applyCancel(sub({ status: "ended" }), { by: "customer" }).changed, false);
});

test("leitura do webhook: invoice, charge com fatura e chargeback", () => {
  const invoiceRefs = billing.subscriptionRefsFromPayload({
    id: "in_1", status: "paid", amount: 4990,
    subscription: { id: "sub_1" },
    charge: { id: "ch_1", status: "paid", last_transaction: { id: "tran_1" } },
    cycle: { cycle: 3, start_at: "2026-11-01", end_at: "2026-11-30" },
  });
  assert.equal(invoiceRefs.invoiceId, "in_1");
  assert.equal(invoiceRefs.subscriptionId, "sub_1");
  assert.equal(invoiceRefs.chargeId, "ch_1");
  assert.equal(invoiceRefs.transactionId, "tran_1");
  assert.equal(invoiceRefs.cycle.number, 3);
  assert.equal(invoiceRefs.amountCents, 4990);

  const chargeRefs = billing.subscriptionRefsFromPayload({ id: "ch_2", status: "failed", invoice: { id: "in_2", subscription_id: "sub_2" } });
  assert.equal(chargeRefs.chargeId, "ch_2");
  assert.equal(chargeRefs.invoiceId, "in_2");

  const cb = billing.subscriptionRefsFromPayload({ id: "cb_1", charge: { id: "ch_3" } });
  assert.equal(cb.chargeId, "ch_3");
  assert.equal(billing.classifySubscriptionEvent("chargeback.received", cb), "chargeback");
  assert.equal(billing.classifySubscriptionEvent("charge.updated", { chargeStatus: "paid" }), "paid");
  assert.equal(billing.classifySubscriptionEvent("order.paid", {}), "ignore");
});

// ─── Webhook ponta a ponta com banco simulado ────────────────────────────────

// Banco em memória com só o que o webhook de assinaturas usa.
const fakeDb = () => {
  const state = {
    events: new Map(),
    subs: [{
      id: 1, status: "pending", paid_cycles: 0, duration_cycles: null,
      pagarme_subscription_id: "sub_1", current_cycle_start: null, current_cycle_end: null,
    }],
    invoices: [],
    providerCancels: 0,
    merchant: [],
    customer: [],
  };
  let nextEventId = 1;
  let nextInvoiceId = 1;
  const applyUpdate = (rows, sql, params) => {
    const row = rows.find((r) => Number(r.id) === Number(params[0]));
    const cols = [...sql.matchAll(/(\w+) = \$(\d+)/g)];
    for (const [, col, n] of cols) row[col] = params[Number(n) - 1];
  };
  const handle = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.includes("to_regclass") || q.includes("information_schema")) return { rowCount: 1, rows: [{ name: "x" }] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [] };
    if (q.startsWith("INSERT INTO payment_webhook_events")) {
      if (state.events.has(params[0])) return { rows: [] };
      const ev = { id: nextEventId++, processed_at: null };
      state.events.set(params[0], ev);
      return { rows: [{ id: ev.id }] };
    }
    if (q.startsWith("SELECT id, processed_at FROM payment_webhook_events")) return { rows: [state.events.get(params[0])] };
    if (q.startsWith("UPDATE payment_webhook_events SET processed_at")) {
      for (const ev of state.events.values()) if (ev.id === params[0]) ev.processed_at = new Date();
      return { rows: [] };
    }
    if (q.startsWith("UPDATE payment_webhook_events")) return { rows: [] };
    if (q.startsWith("SELECT * FROM subscription_invoices WHERE ($1::text")) {
      const found = state.invoices.find((i) => (params[0] && i.pagarme_invoice_id === params[0])
        || (params[1] && i.pagarme_charge_id === params[1]));
      return { rows: found ? [{ ...found }] : [] };
    }
    if (q.startsWith("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE")) {
      return { rows: state.subs.filter((s) => s.id === Number(params[0])).map((s) => ({ ...s })) };
    }
    if (q.startsWith("SELECT * FROM customer_subscriptions WHERE id = $1 AND pagarme_subscription_id IS NULL FOR UPDATE")) {
      return { rows: state.subs.filter((s) => s.id === Number(params[0]) && !s.pagarme_subscription_id).map((s) => ({ ...s })) };
    }
    if (q.startsWith("SELECT * FROM customer_subscriptions WHERE pagarme_subscription_id = $1")) {
      return { rows: state.subs.filter((s) => s.pagarme_subscription_id === params[0]).map((s) => ({ ...s })) };
    }
    if (q.startsWith("INSERT INTO subscription_invoices")) {
      const existing = state.invoices.find((i) => i.pagarme_invoice_id === params[1]);
      if (existing) {
        existing.pagarme_charge_id = existing.pagarme_charge_id || params[2];
      } else {
        state.invoices.push({
          id: nextInvoiceId++, subscription_id: params[0], pagarme_invoice_id: params[1], pagarme_charge_id: params[2],
          cycle: params[3], period_start: params[4], period_end: params[5], amount_cents: params[6],
          status: "pending", failed_attempts: 0, last_failed_transaction_id: null, last_failed_at: null, next_retry_at: null,
        });
      }
      return { rows: [] };
    }
    if (q.startsWith("SELECT COUNT(*)::int AS n FROM subscription_invoices")) {
      const n = state.invoices.filter((i) => i.subscription_id === params[0] && i.id !== params[1] && i.status === "failed").length;
      return { rows: [{ n }] };
    }
    if (q.startsWith("UPDATE customer_subscriptions SET")) { applyUpdate(state.subs, q, params); return { rows: [] }; }
    if (q.startsWith("UPDATE subscription_invoices SET")) { applyUpdate(state.invoices, q, params); return { rows: [] }; }
    throw new Error(`SQL inesperado no teste: ${q.slice(0, 120)}`);
  };
  return { state, handle };
};

const withFakeDb = async (fn) => {
  const { state, handle } = fakeDb();
  const original = {
    query: pool.query, connect: pool.connect, cancel: pagarmeService.cancelSubscription,
    notify: merchantNotifications.notify, customer: orderWebhookService.notifySubscriptionCustomer,
    afterPause: subscriptionBookingService.cancelAfterPause, afterClose: subscriptionBookingService.cancelAfterClose,
  };
  pool.query = handle;
  pool.connect = async () => ({ query: handle, release: () => {} });
  pagarmeService.cancelSubscription = async () => { state.providerCancels += 1; return {}; };
  merchantNotifications.notify = async (n) => { state.merchant.push(n); return true; };
  orderWebhookService.notifySubscriptionCustomer = async (id, kind, details) => {
    state.customer.push({ id, kind, details });
    return true;
  };
  subscriptionBookingService.cancelAfterPause = async () => [];
  subscriptionBookingService.cancelAfterClose = async (id) => { state.closed = (state.closed || []).concat(id); return []; };
  try {
    await fn(state);
  } finally {
    pool.query = original.query;
    pool.connect = original.connect;
    pagarmeService.cancelSubscription = original.cancel;
    merchantNotifications.notify = original.notify;
    orderWebhookService.notifySubscriptionCustomer = original.customer;
    subscriptionBookingService.cancelAfterPause = original.afterPause;
    subscriptionBookingService.cancelAfterClose = original.afterClose;
  }
};

const event = (id, type, data) => ({ id, type, data });

test("webhook: evento repetido não reprocessa e a fatura conta um ciclo só", async () => {
  await withFakeDb(async (state) => {
    const paid = event("hook_1", "invoice.paid", {
      id: "in_1", status: "paid", amount: 4990, subscription: { id: "sub_1" },
      charge: { id: "ch_1", status: "paid" },
    });
    assert.deepEqual(await pagarmeService.handleWebhookEvent(paid), { processed: true, duplicate: false });
    assert.deepEqual(await pagarmeService.handleWebhookEvent(paid), { processed: true, duplicate: true });
    // charge.paid da mesma fatura (evento diferente) também não recontabiliza.
    await pagarmeService.handleWebhookEvent(event("hook_2", "charge.paid", { id: "ch_1", status: "paid" }));
    assert.equal(state.subs[0].status, "active");
    assert.equal(state.subs[0].paid_cycles, 1);
    assert.equal(state.invoices.length, 1);
  });
});

test("webhook: cobrança de fatura recusada 3x pausa, troca de cartão paga e reativa", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].status = "active";
    state.subs[0].paid_cycles = 1;
    const failed = (hook, tx) => pagarmeService.handleWebhookEvent(event(hook, "charge.payment_failed", {
      id: "ch_9", status: "failed", invoice: { id: "in_9", subscription_id: "sub_1" }, last_transaction: { id: tx },
    }));
    await failed("h1", "tran_1");
    // invoice.payment_failed da MESMA tentativa (mesma transação) não soma.
    await pagarmeService.handleWebhookEvent(event("h1b", "invoice.payment_failed", {
      id: "in_9", status: "failed", subscription: { id: "sub_1" }, charge: { id: "ch_9", last_transaction: { id: "tran_1" } },
    }));
    assert.equal(state.invoices[0].failed_attempts, 1);
    assert.ok(state.invoices[0].next_retry_at);
    await failed("h2", "tran_2");
    assert.equal(state.subs[0].status, "active");
    await failed("h3", "tran_3");
    assert.equal(state.subs[0].status, "paused");
    assert.equal(state.invoices[0].next_retry_at, null);

    await pagarmeService.handleWebhookEvent(event("h4", "charge.paid", { id: "ch_9", status: "paid" }));
    assert.equal(state.subs[0].status, "active");
    assert.equal(state.subs[0].paid_cycles, 2);
    assert.equal(state.invoices[0].status, "paid");
  });
});

test("webhook: chargeback de cobrança de assinatura cancela e para na Pagar.me", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].status = "active";
    await pagarmeService.handleWebhookEvent(event("p1", "invoice.paid", {
      id: "in_5", status: "paid", subscription: { id: "sub_1" }, charge: { id: "ch_5", status: "paid" },
    }));
    assert.equal(await subscriptionsService.isSubscriptionEvent("chargeback.received", { id: "cb_1", charge: { id: "ch_5" } }), true);
    await pagarmeService.handleWebhookEvent(event("cb1", "chargeback.received", { id: "cb_1", charge: { id: "ch_5" } }));
    assert.equal(state.subs[0].status, "canceled");
    assert.equal(state.subs[0].cancel_reason, "chargeback");
    assert.equal(state.invoices[0].status, "chargedback");
    assert.equal(state.providerCancels, 1);
  });
});

test("webhook: prazo de 2 cobranças encerra na 2ª fatura paga", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].duration_cycles = 2;
    for (const n of [1, 2]) {
      await pagarmeService.handleWebhookEvent(event(`e${n}`, "invoice.paid", {
        id: `in_${n}`, status: "paid", subscription: { id: "sub_1" }, charge: { id: `ch_${n}`, status: "paid" },
      }));
    }
    assert.equal(state.subs[0].status, "ended");
    assert.equal(state.subs[0].paid_cycles, 2);
    assert.equal(state.providerCancels, 1);
  });
});

test("cobrança de pedido avulso (sem fatura) não é tratada como assinatura", async () => {
  await withFakeDb(async () => {
    assert.equal(await subscriptionsService.isSubscriptionEvent("charge.paid", { id: "ch_order", order: { id: "or_1" } }), false);
    assert.equal(await subscriptionsService.isSubscriptionEvent("order.paid", { id: "or_1" }), false);
  });
});

// ─── Avisos de cada transição ────────────────────────────────────────────────

test("avisos: 1ª cobrança recusada avisa contratação não concluída (não 'evite a pausa')", () => {
  const before = { id: 3, status: "pending", items: [{ name: "Plano" }] };
  const t = billing.applyPaymentFailed(before, { id: 9, status: "pending", failed_attempts: 0 }, { transactionId: "tran_1" });
  const n = billing.transitionNotices({ before, after: t.subscription, outcome: "failed", invoice: t.invoice });
  assert.equal(n.customer.id, "first_payment_failed");
  assert.equal(n.merchant.kind, "CANCELED");
  assert.equal(n.merchant.title, "Contratação não concluída");
});

test("avisos: 3ª recusa (pausa) não manda 'payment_declined' — o aviso de pausa sai à parte", () => {
  const before = { id: 3, status: "active", items: [{ name: "Plano" }] };
  const t = billing.applyPaymentFailed(before, { id: 9, status: "failed", failed_attempts: 2 }, { transactionId: "tran_3" });
  assert.equal(t.subscription.status, "paused");
  const n = billing.transitionNotices({ before, after: t.subscription, outcome: "failed", invoice: t.invoice });
  assert.deepEqual(n, { merchant: null, customer: null });
});

test("avisos: recusa com a assinatura ativa (tentativas 1 e 2) pede para conferir o cartão", () => {
  const before = { id: 3, status: "active" };
  const t = billing.applyPaymentFailed(before, { id: 9, status: "pending", failed_attempts: 0 }, { transactionId: "tran_1" });
  const n = billing.transitionNotices({ before, after: t.subscription, outcome: "failed", invoice: t.invoice });
  assert.equal(n.customer.id, "payment_declined");
  assert.equal(n.customer.details.failedAttempts, 1);
  assert.equal(n.merchant.kind, "PAYMENT_DECLINED");
});

test("avisos: recusa com a assinatura já pausada tem texto próprio (sem 'evite a pausa')", () => {
  const before = { id: 3, status: "paused" };
  const t = billing.applyPaymentFailed(before, { id: 9, status: "failed", failed_attempts: 3 }, { transactionId: "tran_4" });
  const n = billing.transitionNotices({ before, after: t.subscription, outcome: "failed", invoice: t.invoice });
  assert.equal(n.customer.id, "payment_declined_paused");
  assert.match(n.merchant.message, /continua pausada/);
});

test("avisos: chargeback, retomada e fim do prazo", () => {
  const active = { id: 3, status: "active" };
  const cb = billing.applyChargeback(active, { id: 9, status: "paid" });
  const n1 = billing.transitionNotices({ before: active, after: cb.subscription, outcome: "chargeback", invoice: cb.invoice });
  assert.equal(n1.customer.details.canceledBy, "chargeback");
  const n2 = billing.transitionNotices({ before: { id: 3, status: "paused" }, after: { id: 3, status: "active" }, outcome: "paid" });
  assert.equal(n2.customer.id, "resumed");
  const n3 = billing.transitionNotices({ before: active, after: { id: 3, status: "ended" }, outcome: "paid" });
  assert.equal(n3.customer.id, "ended");
});

test("metadata: id local da assinatura vem da assinatura, da fatura ou da cobrança", () => {
  assert.equal(billing.localSubscriptionIdFromPayload({ id: "sub_9", metadata: { arbian_subscription_id: "12" } }), 12);
  assert.equal(billing.localSubscriptionIdFromPayload({ id: "in_1", subscription: { id: "sub_9", metadata: { arbian_subscription_id: "7" } } }), 7);
  assert.equal(billing.localSubscriptionIdFromPayload({ id: "ch_1", invoice: { subscription: { metadata: { arbian_subscription_id: 5 } } } }), 5);
  assert.equal(billing.localSubscriptionIdFromPayload({ id: "sub_9", metadata: { arbian_subscription_id: "x" } }), null);
});

test("webhook: 1ª cobrança recusada avisa o cliente uma vez, com 'contratação não concluída'", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].items = [{ name: "Plano" }];
    await pagarmeService.handleWebhookEvent(event("f1", "charge.payment_failed", {
      id: "ch_1", status: "failed", invoice: { id: "in_1", subscription_id: "sub_1" }, last_transaction: { id: "tran_1" },
    }));
    assert.equal(state.subs[0].status, "canceled");
    assert.deepEqual(state.customer.map((c) => c.kind), ["first_payment_failed"]);
    assert.deepEqual(state.merchant.map((m) => m.title), ["Contratação não concluída"]);
  });
});

test("webhook: 3ª recusa avisa só a pausa (sem 'evite a pausa' depois)", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].status = "active";
    for (const [hook, tx] of [["h1", "tran_1"], ["h2", "tran_2"], ["h3", "tran_3"]]) {
      await pagarmeService.handleWebhookEvent(event(hook, "charge.payment_failed", {
        id: "ch_9", status: "failed", invoice: { id: "in_9", subscription_id: "sub_1" }, last_transaction: { id: tx },
      }));
    }
    assert.equal(state.subs[0].status, "paused");
    assert.deepEqual(state.customer.map((c) => c.kind), ["payment_declined", "payment_declined", "paused"]);
    assert.deepEqual(state.merchant.map((m) => m.title), ["Cobrança recusada", "Cobrança recusada", "Assinatura pausada"]);

    // Recobrança após troca de cartão recusada de novo: aviso próprio de "continua pausada".
    await pagarmeService.handleWebhookEvent(event("h4", "charge.payment_failed", {
      id: "ch_9", status: "failed", invoice: { id: "in_9", subscription_id: "sub_1" }, last_transaction: { id: "tran_4" },
    }));
    assert.equal(state.customer.at(-1).kind, "payment_declined_paused");
  });
});

test("webhook: chargeback e fim do prazo cancelam agendamentos depois do período pago", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].status = "active";
    await pagarmeService.handleWebhookEvent(event("p1", "invoice.paid", {
      id: "in_5", status: "paid", subscription: { id: "sub_1" }, charge: { id: "ch_5", status: "paid" },
    }));
    await pagarmeService.handleWebhookEvent(event("cb1", "chargeback.received", { id: "cb_1", charge: { id: "ch_5" } }));
    assert.deepEqual(state.closed, [1]);
    assert.equal(state.customer.at(-1).kind, "canceled");
    assert.equal(state.customer.at(-1).details.cancelledAppointments, 0);
  });
});

test("webhook: assinatura criada na Pagar.me após timeout é achada pela metadata e cancelada", async () => {
  await withFakeDb(async (state) => {
    Object.assign(state.subs[0], { status: "canceled", cancel_reason: "provider_error", pagarme_subscription_id: null });
    await pagarmeService.handleWebhookEvent(event("o1", "subscription.created", {
      id: "sub_orfa", status: "active", metadata: { arbian_subscription_id: "1" },
    }));
    assert.equal(state.subs[0].pagarme_subscription_id, "sub_orfa");
    assert.equal(state.subs[0].status, "canceled");
    assert.equal(state.providerCancels, 1);
    assert.deepEqual(state.customer, []);
  });
});

test("webhook: evento antes de gravar o id da Pagar.me vincula a linha pendente e segue o fluxo", async () => {
  await withFakeDb(async (state) => {
    state.subs[0].pagarme_subscription_id = null;
    await pagarmeService.handleWebhookEvent(event("e1", "invoice.paid", {
      id: "in_1", status: "paid",
      subscription: { id: "sub_novo", metadata: { arbian_subscription_id: "1" } },
      charge: { id: "ch_1", status: "paid" },
    }));
    assert.equal(state.subs[0].pagarme_subscription_id, "sub_novo");
    assert.equal(state.subs[0].status, "active");
    assert.equal(state.providerCancels, 0);
  });
});
