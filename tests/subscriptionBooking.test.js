const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const ordersService = require("../services/ordersService");
const orderWebhookService = require("../services/orderWebhookService");
const bookingService = require("../services/bookingService");
const subscriptionBookingService = require("../services/subscriptionBookingService");
const usage = require("../helpers/subscriptionUsage");

// Banco falso: schema completo; o estado de cada teste fica em `state`.
const HOUR = 3600 * 1000;
const state = { sub: null, appointments: [], invoices: [], updates: [], appointmentRow: null };
const schemaQuery = (sql) => {
  if (sql.includes("to_regclass")) return { rows: [{ name: "x" }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };
  return null;
};
const subscriptionQuery = (sql, params) => {
  if (sql.includes("FROM customer_subscriptions WHERE id = $1")) {
    return { rows: state.sub ? [state.sub] : [], rowCount: state.sub ? 1 : 0 };
  }
  if (sql.includes("FROM subscription_invoices WHERE subscription_id")) return { rows: state.invoices, rowCount: state.invoices.length };
  if (sql.includes("WHERE o.subscription_id = $1")) {
    const rows = state.appointments.filter((a) => params[1] == null || a.id !== params[1]);
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("SELECT timezone FROM companies")) return { rows: [{ timezone: "America/Sao_Paulo" }], rowCount: 1 };
  return null;
};
pool.query = async (sql, params) => {
  const hit = schemaQuery(sql) || subscriptionQuery(sql, params);
  if (hit) return hit;
  if (sql.startsWith("UPDATE appointments SET cancel_reason")) {
    state.updates.push(params);
    return { rows: [], rowCount: 1 };
  }
  // getForOrder (acompanhamento público): agendamento + empresa + endereço.
  if (sql.includes("FROM appointments a") && sql.includes("WHERE a.order_id = $1")) {
    return { rows: state.appointmentRow ? [state.appointmentRow] : [], rowCount: 1 };
  }
  if (sql.includes("FROM companies WHERE id = $1")) {
    return {
      rows: [{ id: 5, name: "Salão", timezone: "America/Sao_Paulo", booking_slot_step_minutes: 15,
        booking_min_notice_minutes: 60, booking_max_days_ahead: 30, cancel_window_hours: 24,
        booking_requires_approval: false }],
      rowCount: 1,
    };
  }
  if (sql.includes("SELECT subscription_id FROM orders")) return { rows: [{ subscription_id: 1 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
const fakeDb = { query: (sql, params) => pool.query(sql, params) };

const baseSub = (over = {}) => ({
  id: 1, company_id: 5, menu_item_id: 9, user_id: "user-1", client_id: 77,
  status: "active", interval: "month", usage_limit: 2, duration_cycles: null, paid_cycles: 1,
  current_cycle_start: "2026-11-10T03:00:00.000Z", current_cycle_end: "2026-12-10T03:00:00.000Z",
  created_at: "2026-11-10T03:00:00.000Z",
  ...over,
});
const NOW = new Date("2026-11-12T12:00:00.000Z");

test.beforeEach(() => {
  state.sub = baseSub();
  state.appointments = [];
  state.invoices = [];
  state.updates = [];
  state.appointmentRow = null;
});

test("trava a assinatura e bloqueia o limite do ciclo da data do atendimento", async () => {
  state.appointments = [
    { id: 1, status: "done", starts_at: "2026-11-11T13:00:00.000Z" },
    { id: 2, status: "no_show", starts_at: "2026-11-11T16:00:00.000Z" },
  ];
  await assert.rejects(
    subscriptionBookingService.lockAndValidate(fakeDb, {
      subscriptionId: 1, owner: { userId: "user-1" }, companyId: 5, serviceId: 9,
      startsAt: new Date("2026-11-20T13:00:00.000Z"), now: NOW,
    }),
    (err) => err.status === 409 && err.code === "SUBSCRIPTION_LIMIT_REACHED",
  );
  const ok = await subscriptionBookingService.lockAndValidate(fakeDb, {
    subscriptionId: 1, owner: { userId: "user-1" }, companyId: 5, serviceId: 9,
    startsAt: new Date("2026-12-11T13:00:00.000Z"), now: NOW,
  });
  assert.equal(ok.evaluation.ok, true);
});

test("assinatura de outra pessoa, loja ou serviço não é usada", async () => {
  const args = { subscriptionId: 1, companyId: 5, serviceId: 9, startsAt: new Date("2026-11-20T13:00:00.000Z"), now: NOW };
  await assert.rejects(
    subscriptionBookingService.lockAndValidate(fakeDb, { ...args, owner: { userId: "outra" } }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    subscriptionBookingService.lockAndValidate(fakeDb, { ...args, owner: { userId: "user-1" }, companyId: 6 }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    subscriptionBookingService.lockAndValidate(fakeDb, { ...args, owner: { userId: "user-1" }, serviceId: 10 }),
    (err) => err.code === "SUBSCRIPTION_OTHER_SERVICE",
  );
});

test("remarcar ignora o próprio agendamento: pode mudar de data, mas 1 futuro por vez vale", async () => {
  state.appointments = [{ id: 7, status: "confirmed", starts_at: "2026-11-20T13:00:00.000Z" }];
  const moved = await subscriptionBookingService.lockAndValidate(fakeDb, {
    subscriptionId: 1, owner: { trusted: true }, companyId: 5, serviceId: null,
    startsAt: new Date("2026-11-25T13:00:00.000Z"), excludeAppointmentId: 7, now: NOW,
  });
  assert.equal(moved.evaluation.ok, true);
  await assert.rejects(
    subscriptionBookingService.lockAndValidate(fakeDb, {
      subscriptionId: 1, owner: { trusted: true }, companyId: 5, serviceId: null,
      startsAt: new Date("2026-11-25T13:00:00.000Z"), now: NOW,
    }),
    (err) => err.code === "SUBSCRIPTION_FUTURE_EXISTS",
  );
});

test("pedido pela assinatura exige conta (sem dono vindo do servidor)", async () => {
  await assert.rejects(
    bookingService.createBookingOrder({
      company_id: 5, client_id: 77, subscription_id: 1,
      booking: { menu_item_id: 9, starts_at: "2026-11-20T13:00:00.000Z" },
    }),
    (err) => err.status === 401 && err.code === "SUBSCRIPTION_LOGIN_REQUIRED",
  );
  await assert.rejects(
    bookingService.createBookingOrder(
      { company_id: 5, subscription_id: 1, products: [{ menu_item_id: 3 }], booking: { menu_item_id: 9, starts_at: "2026-11-20T13:00:00.000Z" } },
      { subscriptionOwner: { userId: "user-1" } },
    ),
    (err) => err.status === 400,
  );
});

test("cancelamento fora da janela fica bloqueado para o cliente (o uso continua contando)", async () => {
  const startsAt = new Date(Date.now() + 2 * HOUR);
  state.appointmentRow = {
    id: 7, order_id: 70, company_id: 5, status: "confirmed", starts_at: startsAt, ends_at: new Date(startsAt.getTime() + HOUR),
    menu_item_id: 9, professional_id: 1, rescheduled_count: 0,
  };
  const block = await bookingService.customerCancelBlock(70, 2);
  assert.match(block, /24h antes/);
  // Dentro da janela (2 dias antes) o cliente cancela e o uso é liberado.
  state.appointmentRow.starts_at = new Date(Date.now() + 48 * HOUR);
  assert.equal(await bookingService.customerCancelBlock(70, 2), null);
  assert.equal(usage.countsAsUsage({ status: "cancelled" }), false);
});

test("pausa cancela os agendamentos do ciclo não pago e avisa cliente e loja", async () => {
  const future = (days) => new Date(Date.now() + days * 24 * HOUR).toISOString();
  const due = new Date(Date.now() + 5 * 24 * HOUR);
  state.sub = baseSub({ status: "paused", current_cycle_start: due.toISOString() });
  state.invoices = [
    { status: "paid", period_start: future(-25), period_end: due.toISOString() },
    { status: "failed", period_start: due.toISOString(), period_end: future(35) },
  ];
  state.appointments = [
    { id: 1, order_id: 11, status: "confirmed", starts_at: future(2) },
    { id: 2, order_id: 12, status: "confirmed", starts_at: future(8) },
  ];
  const statusCalls = [];
  const notices = [];
  const originalUpdate = ordersService.updateStatus;
  const originalNotify = orderWebhookService.notifySubscriptionAppointmentsCancelled;
  ordersService.updateStatus = async (...args) => {
    statusCalls.push(args);
    return { id: args[0] };
  };
  orderWebhookService.notifySubscriptionAppointmentsCancelled = (sub, list) => notices.push({ sub, list });
  try {
    const cancelled = await subscriptionBookingService.cancelAfterPause(1);
    assert.deepEqual(cancelled.map((a) => a.id), [2]);
    // Etapa 6 do pedido = WhatsApp de "agendamento cancelado" para o cliente.
    assert.deepEqual(statusCalls, [[12, 6, subscriptionBookingService.PAUSE_CANCEL_NOTE]]);
    assert.equal(state.updates[0][1], usage.PAUSE_CANCEL_REASON);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].list[0].id, 2);
  } finally {
    ordersService.updateStatus = originalUpdate;
    orderWebhookService.notifySubscriptionAppointmentsCancelled = originalNotify;
  }
});

test("assinatura ativa não cancela nada (só a pausa dispara)", async () => {
  state.appointments = [{ id: 2, order_id: 12, status: "confirmed", starts_at: new Date(Date.now() + 40 * 24 * HOUR).toISOString() }];
  assert.deepEqual(await subscriptionBookingService.cancelAfterPause(1), []);
});

test("cancelamento/fim do prazo cancela os agendamentos depois do último ciclo pago", async () => {
  const future = (days) => new Date(Date.now() + days * 24 * HOUR).toISOString();
  const paidEnd = future(5);
  state.sub = baseSub({ status: "canceled" });
  state.invoices = [{ status: "paid", period_start: future(-25), period_end: paidEnd }];
  state.appointments = [
    { id: 1, order_id: 11, status: "confirmed", starts_at: future(2) },
    { id: 2, order_id: 12, status: "pending", starts_at: future(8) },
  ];
  state.updates = [];
  const statusCalls = [];
  const notices = [];
  const originalUpdate = ordersService.updateStatus;
  const originalNotify = orderWebhookService.notifySubscriptionAppointmentsCancelled;
  ordersService.updateStatus = async (...args) => {
    statusCalls.push(args);
    return { id: args[0] };
  };
  orderWebhookService.notifySubscriptionAppointmentsCancelled = (sub, list, opts) => notices.push({ sub, list, opts });
  try {
    const cancelled = await subscriptionBookingService.cancelAfterClose(1);
    assert.deepEqual(cancelled.map((a) => a.id), [2]);
    assert.deepEqual(statusCalls, [[12, 6, subscriptionBookingService.CLOSE_CANCEL_NOTE]]);
    assert.equal(state.updates[0][1], usage.CLOSE_CANCEL_REASON);
    assert.deepEqual(notices[0].opts, { reason: "closed" });
    // Assinatura ainda aberta: nada a cancelar por encerramento.
    state.sub = baseSub({ status: "active" });
    assert.deepEqual(await subscriptionBookingService.cancelAfterClose(1), []);
  } finally {
    ordersService.updateStatus = originalUpdate;
    orderWebhookService.notifySubscriptionAppointmentsCancelled = originalNotify;
  }
});
