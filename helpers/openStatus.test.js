const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveOpenStatus, nextScheduleChange, scheduleOpenAt } = require("./openStatus");

// 2026-10-12 é uma segunda-feira (getDay() = 1).
const monday = (h, m = 0) => new Date(2026, 9, 12, h, m, 0);
const hours = [{ weekday: 1, opens_at: "09:00:00", closes_at: "18:00:00", is_closed: false }];

test("segue o horário quando não há override manual", () => {
  assert.deepEqual(resolveOpenStatus(hours, null, monday(10)), {
    is_open: true,
    schedule_open: true,
    manual_open: null,
    manual_expired: false,
    next_change_at: monday(18).toISOString(),
  });
  assert.equal(resolveOpenStatus(hours, null, monday(20)).is_open, false);
});

test("exceção manual prevalece sobre o horário enquanto ele não vira", () => {
  assert.equal(resolveOpenStatus(hours, false, monday(10)).is_open, false);
  assert.equal(resolveOpenStatus(hours, true, monday(20)).is_open, true);
  assert.equal(resolveOpenStatus(hours, true, monday(20)).schedule_open, false);
});

test("domingo casa weekday 7 (convenção do portal)", () => {
  const sunday = new Date(2026, 9, 11, 12, 0, 0);
  const sundayHours = [{ weekday: 7, opens_at: "10:00:00", closes_at: "14:00:00", is_closed: false }];
  assert.equal(resolveOpenStatus(sundayHours, null, sunday).is_open, true);
});

test("dia fechado ou sem horário cadastrado fica fechado", () => {
  assert.equal(resolveOpenStatus([{ ...hours[0], is_closed: true }], null, monday(10)).is_open, false);
  assert.equal(resolveOpenStatus([], undefined, monday(10)).manual_open, null);
});

test("exceção manual igual ao horário já terminou (vira null)", () => {
  // Fechada manualmente às 10h; às 20h o horário também diz fechado.
  const after = resolveOpenStatus(hours, false, monday(20));
  assert.equal(after.manual_open, null);
  assert.equal(after.manual_expired, true);
  assert.equal(after.is_open, false);
  // Aberta manualmente às 7h; às 10h o horário também diz aberto.
  const opened = resolveOpenStatus(hours, true, monday(10));
  assert.equal(opened.manual_open, null);
  assert.equal(opened.manual_expired, true);
});

test("próxima virada do horário", () => {
  // Antes de abrir: abre às 9h do mesmo dia.
  assert.equal(nextScheduleChange(hours, monday(7)).getTime(), monday(9).getTime());
  // Depois de fechar: só abre na próxima segunda.
  const nextMonday = new Date(2026, 9, 19, 9, 0, 0);
  assert.equal(nextScheduleChange(hours, monday(20)).getTime(), nextMonday.getTime());
  assert.equal(nextScheduleChange([], monday(10)), null);
  assert.equal(scheduleOpenAt([{ ...hours[0], opens_at: "09:00" }], monday(9, 30)), true);
});
