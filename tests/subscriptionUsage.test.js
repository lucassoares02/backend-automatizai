const test = require("node:test");
const assert = require("node:assert/strict");
const usage = require("../helpers/subscriptionUsage");

// Assinatura mensal com ciclo atual de 10/11 a 10/12 (meia-noite em São Paulo).
const START = "2026-11-10T03:00:00.000Z";
const sub = (over = {}) => ({
  id: 1,
  status: "active",
  interval: "month",
  usage_limit: 3,
  duration_cycles: null,
  paid_cycles: 1,
  current_cycle_start: START,
  current_cycle_end: "2026-12-10T03:00:00.000Z",
  created_at: START,
  ...over,
});
const NOW = new Date("2026-11-12T12:00:00.000Z");
const appt = (id, startsAt, status = "done") => ({ id, status, starts_at: startsAt, order_id: 100 + id });

test("ciclo mensal: limites [início, fim) e virada sem acumular arredondamento", () => {
  const c = usage.cycleFor(START, "month", "2026-12-10T02:59:59.000Z");
  assert.equal(c.start.toISOString(), START);
  assert.equal(c.end.toISOString(), "2026-12-10T03:00:00.000Z");
  const next = usage.cycleFor(START, "month", "2026-12-10T03:00:00.000Z");
  assert.equal(next.index, 1);
  assert.equal(next.start.toISOString(), "2026-12-10T03:00:00.000Z");
  // Âncora no dia 31: fevereiro encosta no dia 28 e março volta ao 31.
  const anchor = "2027-01-31T03:00:00.000Z";
  assert.equal(usage.addCycles(anchor, "month", 1).toISOString(), "2027-02-28T03:00:00.000Z");
  assert.equal(usage.addCycles(anchor, "month", 2).toISOString(), "2027-03-31T03:00:00.000Z");
  // Datas antes da âncora caem em ciclos anteriores.
  assert.equal(usage.cycleFor(START, "week", "2026-11-09T03:00:00.000Z").index, -1);
});

test("limite por ciclo conta pela DATA DO ATENDIMENTO, não pelo dia em que marcou", () => {
  const appointments = [
    appt(1, "2026-11-11T13:00:00.000Z"),
    appt(2, "2026-11-11T15:00:00.000Z", "no_show"),
    appt(3, "2026-11-12T10:00:00.000Z"),
  ];
  // 3 de 3 usados no ciclo de novembro: bloqueia outra data do mesmo ciclo…
  const blocked = usage.evaluateBooking({ sub: sub(), startsAt: "2026-12-09T13:00:00.000Z", appointments, now: NOW });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "SUBSCRIPTION_LIMIT_REACHED");
  assert.equal(blocked.used, 3);
  assert.match(blocked.message, /3 de 3/);
  assert.match(blocked.message, /a partir de 10\/12/);
  // …mas marcar hoje para uma data do próximo ciclo conta no próximo ciclo.
  const nextCycle = usage.evaluateBooking({ sub: sub(), startsAt: "2026-12-10T13:00:00.000Z", appointments, now: NOW });
  assert.equal(nextCycle.ok, true);
  assert.equal(nextCycle.used, 0);
  assert.equal(nextCycle.cycle.start.toISOString(), "2026-12-10T03:00:00.000Z");
});

test("virada de ciclo: uso do ciclo anterior não conta no novo", () => {
  const appointments = [
    appt(1, "2026-11-20T13:00:00.000Z"),
    appt(2, "2026-11-25T13:00:00.000Z"),
    appt(3, "2026-12-01T13:00:00.000Z"),
  ];
  const later = new Date("2026-12-11T12:00:00.000Z");
  const r = usage.evaluateBooking({ sub: sub(), startsAt: "2026-12-15T13:00:00.000Z", appointments, now: later });
  assert.equal(r.ok, true);
  assert.equal(r.used, 0);
});

test("ilimitado não tem teto, mas só 1 agendamento futuro por vez (todos os planos)", () => {
  const unlimited = sub({ usage_limit: null });
  const many = Array.from({ length: 8 }, (_, i) => appt(i + 1, `2026-11-1${i % 2}T1${i}:00:00.000Z`));
  assert.equal(usage.evaluateBooking({ sub: unlimited, startsAt: "2026-11-20T13:00:00.000Z", appointments: many, now: NOW }).ok, true);

  const withFuture = [...many, appt(50, "2026-11-18T13:00:00.000Z", "confirmed")];
  const r = usage.evaluateBooking({ sub: unlimited, startsAt: "2026-11-25T13:00:00.000Z", appointments: withFuture, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SUBSCRIPTION_FUTURE_EXISTS");
  assert.equal(r.upcoming_appointment_id, 50);

  // Plano limitado: mesma trava, mesmo com uso livre no ciclo.
  const limited = usage.evaluateBooking({
    sub: sub(), startsAt: "2026-11-25T13:00:00.000Z", appointments: [appt(9, "2026-11-20T13:00:00.000Z", "pending")], now: NOW,
  });
  assert.equal(limited.code, "SUBSCRIPTION_FUTURE_EXISTS");
});

test("cancelado (dentro da janela, ou pela loja) libera o uso; no-show conta", () => {
  const appointments = [
    appt(1, "2026-11-11T13:00:00.000Z"),
    appt(2, "2026-11-11T15:00:00.000Z", "no_show"),
    { ...appt(3, "2026-11-20T10:00:00.000Z", "cancelled"), cancel_reason: "order_cancelled" },
  ];
  const r = usage.evaluateBooking({ sub: sub(), startsAt: "2026-11-21T13:00:00.000Z", appointments, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.used, 2);
  assert.equal(usage.countsAsUsage({ status: "no_show" }), true);
  assert.equal(usage.countsAsUsage({ status: "cancelled" }), false);
});

test("pausada: ciclo pago continua agendável, nada depois do vencimento", () => {
  const paused = sub({ status: "paused", current_cycle_start: "2026-12-10T03:00:00.000Z", current_cycle_end: "2027-01-10T03:00:00.000Z" });
  const invoices = [
    { status: "paid", period_start: START, period_end: "2026-12-10T03:00:00.000Z" },
    { status: "failed", period_start: "2026-12-10T03:00:00.000Z", period_end: "2027-01-10T03:00:00.000Z" },
  ];
  const now = new Date("2026-12-05T12:00:00.000Z");
  const inside = usage.evaluateBooking({ sub: paused, startsAt: "2026-12-08T13:00:00.000Z", invoices, now });
  assert.equal(inside.ok, true);
  const after = usage.evaluateBooking({ sub: paused, startsAt: "2026-12-12T13:00:00.000Z", invoices, now });
  assert.equal(after.ok, false);
  assert.equal(after.code, "SUBSCRIPTION_PAUSED");
  assert.match(after.message, /até 09\/12/);
});

test("pausa cancela só os agendamentos futuros a partir do vencimento", () => {
  const invoices = [
    { status: "paid", period_start: START, period_end: "2026-12-10T03:00:00.000Z" },
    { status: "failed", period_start: "2026-12-10T03:00:00.000Z", period_end: "2027-01-10T03:00:00.000Z" },
  ];
  const now = new Date("2026-12-05T12:00:00.000Z");
  const appointments = [
    appt(1, "2026-11-20T13:00:00.000Z", "done"),
    appt(2, "2026-12-08T13:00:00.000Z", "confirmed"), // ciclo pago: fica
    appt(3, "2026-12-15T13:00:00.000Z", "confirmed"), // ciclo não pago: cancela
    appt(4, "2026-12-16T13:00:00.000Z", "cancelled"),
  ];
  const targets = usage.appointmentsToCancelOnPause(sub({ status: "paused" }), appointments, invoices, now);
  assert.deepEqual(targets.map((a) => a.id), [3]);
});

test("pendente e cancelada não agendam; plano com prazo para no último ciclo", () => {
  assert.equal(usage.evaluateBooking({ sub: sub({ status: "pending" }), startsAt: "2026-11-20T13:00:00.000Z", now: NOW }).code, "SUBSCRIPTION_PENDING");
  assert.equal(usage.evaluateBooking({ sub: sub({ status: "canceled" }), startsAt: "2026-11-20T13:00:00.000Z", now: NOW }).code, "SUBSCRIPTION_INACTIVE");
  const twoCycles = sub({ duration_cycles: 2 });
  const invoices = [{ status: "paid", period_start: START, period_end: "2026-12-10T03:00:00.000Z" }];
  assert.equal(usage.evaluateBooking({ sub: twoCycles, startsAt: "2027-01-05T13:00:00.000Z", invoices, now: NOW }).ok, true);
  assert.equal(usage.evaluateBooking({ sub: twoCycles, startsAt: "2027-01-12T13:00:00.000Z", invoices, now: NOW }).code, "SUBSCRIPTION_PLAN_ENDS");
});

test("resumo de 'Minhas assinaturas': uso do ciclo atual e próximo agendamento", () => {
  const appointments = [appt(1, "2026-11-11T13:00:00.000Z"), appt(2, "2026-11-20T13:00:00.000Z", "confirmed")];
  const s = usage.bookingSummary({ sub: sub(), appointments, now: NOW });
  assert.equal(s.used_in_cycle, 2);
  assert.equal(s.usage_limit, 3);
  assert.equal(s.upcoming.appointment_id, 2);
  assert.equal(s.can_book, false);
  assert.equal(s.blocked_code, "SUBSCRIPTION_FUTURE_EXISTS");
  // Limite do ciclo atual atingido ainda deixa marcar no próximo ciclo.
  const full = usage.bookingSummary({
    sub: sub({ usage_limit: 1 }), appointments: [appt(1, "2026-11-11T13:00:00.000Z")], now: NOW,
  });
  assert.equal(full.can_book, true);
});

test("encerramento: cancela só os agendamentos depois do último ciclo pago", () => {
  const paidEnd = "2026-12-10T03:00:00.000Z";
  const invoices = [{ status: "paid", period_start: START, period_end: paidEnd }];
  const appointments = [
    appt(1, "2026-11-20T13:00:00.000Z", "confirmed"),
    appt(2, "2026-12-12T13:00:00.000Z", "confirmed"),
    appt(3, "2026-12-15T13:00:00.000Z", "cancelled"),
  ];
  const closed = sub({ status: "canceled" });
  assert.equal(usage.paidUntil(closed, invoices).toISOString(), paidEnd);
  assert.deepEqual(usage.appointmentsToCancelOnClose(closed, appointments, invoices, NOW).map((a) => a.id), [2]);
});

test("encerramento: ciclo contestado (chargeback) não conta como pago e cancela tudo que vem", () => {
  const invoices = [{ status: "chargedback", period_start: START, period_end: "2026-12-10T03:00:00.000Z" }];
  const appointments = [appt(1, "2026-11-20T13:00:00.000Z", "confirmed")];
  const closed = sub({ status: "canceled", paid_cycles: 1 });
  assert.equal(usage.paidUntil(closed, invoices), null);
  assert.deepEqual(usage.appointmentsToCancelOnClose(closed, appointments, invoices, NOW).map((a) => a.id), [1]);
  // Sem faturas com período: usa o ciclo atual se já pagou algo.
  assert.equal(usage.paidUntil(sub({ paid_cycles: 1, current_cycle_end: "2026-12-10T03:00:00.000Z" }), []).toISOString(), "2026-12-10T03:00:00.000Z");
});
