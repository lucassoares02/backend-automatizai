const test = require("node:test");
const assert = require("node:assert/strict");
const { dueReminder, availableMinutes, rate } = require("./appointmentMetrics");

const H = 3600000;
const start = new Date("2026-10-20T15:00:00Z");
const at = (hoursBefore) => new Date(start.getTime() - hoursBefore * H);

test("lembrete de 24h sai dentro da janela quando o agendamento é antigo", () => {
  const due = dueReminder({ startsAt: start, createdAt: at(72) }, at(23));
  assert.equal(due.kind, "24h");
  assert.deepEqual(due.skip, []);
});

test("nada sai antes da janela de 24h", () => {
  assert.equal(dueReminder({ startsAt: start, createdAt: at(72) }, at(30)), null);
});

test("agendamento criado dentro da janela não recebe o lembrete de 24h", () => {
  assert.equal(dueReminder({ startsAt: start, createdAt: at(10) }, at(9)), null);
  assert.equal(dueReminder({ startsAt: start, createdAt: at(10) }, at(1.5)).kind, "2h");
});

test("com o cron parado, só o lembrete mais próximo sai e o outro é pulado", () => {
  const due = dueReminder({ startsAt: start, createdAt: at(72) }, at(1));
  assert.equal(due.kind, "2h");
  assert.deepEqual(due.skip, ["24h"]);
});

test("lembrete já enviado não repete e nada sai depois do início", () => {
  assert.equal(dueReminder({ startsAt: start, createdAt: at(72), sent: { "24h": true } }, at(20)), null);
  assert.equal(dueReminder({ startsAt: start, createdAt: at(72) }, at(-0.5)), null);
});

test("minutos disponíveis = jornada ∩ loja − folgas no fuso da empresa", () => {
  // 2026-10-19 é segunda (1) e 2026-10-20 terça (2).
  const workingHours = [
    { weekday: 1, start_time: "09:00", end_time: "12:00" },
    { weekday: 1, start_time: "13:00", end_time: "18:00" },
    { weekday: 2, start_time: "09:00", end_time: "18:00" },
  ];
  const openingHours = [
    { weekday: 1, opens_at: "10:00", closes_at: "18:00", is_closed: false },
    { weekday: 2, opens_at: "08:00", closes_at: "20:00", is_closed: false },
  ];
  // Folga terça 14:00–16:00 em São Paulo (UTC-3).
  const timeOff = [{ starts_at: "2026-10-20T17:00:00Z", ends_at: "2026-10-20T19:00:00Z" }];
  const minutes = availableMinutes({
    fromDate: "2026-10-19",
    toDate: "2026-10-20",
    timezone: "America/Sao_Paulo",
    workingHours,
    openingHours,
    timeOff,
  });
  // segunda: 10–12 (120) + 13–18 (300); terça: 9–18 (540) − 120 de folga.
  assert.equal(minutes, 120 + 300 + 540 - 120);
});

test("sem jornada no período não há minutos disponíveis", () => {
  assert.equal(
    availableMinutes({ fromDate: "2026-10-19", toDate: "2026-10-19", timezone: "America/Sao_Paulo", workingHours: [] }),
    0,
  );
});

test("rate arredonda em 1 casa e trata divisor zero", () => {
  assert.equal(rate(1, 3), 33.3);
  assert.equal(rate(5, 0), 0);
});
