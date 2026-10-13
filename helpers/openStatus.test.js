const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveOpenStatus } = require("./openStatus");

// 2026-10-12 é uma segunda-feira (getDay() = 1).
const monday = (h, m = 0) => new Date(2026, 9, 12, h, m, 0);
const hours = [{ weekday: 1, opens_at: "09:00:00", closes_at: "18:00:00", is_closed: false }];

test("segue o horário quando não há override manual", () => {
  assert.deepEqual(resolveOpenStatus(hours, null, monday(10)), {
    is_open: true,
    schedule_open: true,
    manual_open: null,
  });
  assert.equal(resolveOpenStatus(hours, null, monday(20)).is_open, false);
});

test("override manual prevalece sobre o horário", () => {
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
