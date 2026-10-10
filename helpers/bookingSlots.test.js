const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveTimezone,
  addDays,
  weekdayOf,
  localDate,
  zonedTimeToUtc,
  companyDayIntervals,
  intersectIntervals,
  buildDaySlots,
} = require("./bookingSlots");

const SP = "America/Sao_Paulo";
// 2026-10-12 é uma segunda-feira (weekday 1).
const DATE = "2026-10-12";
const workMonday = [{ weekday: 1, start_time: "09:00", end_time: "12:00" }];

test("fuso: horário de parede da empresa vira o instante UTC certo", () => {
  assert.equal(zonedTimeToUtc(DATE, 9 * 60, SP).toISOString(), "2026-10-12T12:00:00.000Z");
  assert.equal(localDate(new Date("2026-10-13T02:30:00Z"), SP), DATE);
  assert.equal(resolveTimezone("Nada/Existe"), SP);
  assert.equal(resolveTimezone("Europe/Lisbon"), "Europe/Lisbon");
});

test("calendário: soma dias e dia da semana", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(weekdayOf(DATE), 1);
  assert.equal(weekdayOf("2026-10-11"), 0);
});

test("abertura da loja: domingo 0/7, fechado e virada da madrugada", () => {
  const hours = [
    { weekday: 7, opens_at: "10:00:00", closes_at: "14:00:00", is_closed: false },
    { weekday: 1, opens_at: "18:00:00", closes_at: "02:00:00", is_closed: false },
    { weekday: 2, opens_at: "08:00:00", closes_at: "18:00:00", is_closed: true },
  ];
  assert.deepEqual(companyDayIntervals(hours, 0), [{ start: 600, end: 840 }]);
  assert.deepEqual(companyDayIntervals(hours, 1), [{ start: 1080, end: 1440 }]);
  assert.deepEqual(companyDayIntervals(hours, 2), []);
  assert.equal(companyDayIntervals([], 1), null);
  assert.deepEqual(intersectIntervals([{ start: 0, end: 100 }], [{ start: 50, end: 200 }]), [{ start: 50, end: 100 }]);
});

test("slots respeitam passo, duração e fim do turno", () => {
  const slots = buildDaySlots({
    date: DATE,
    timezone: SP,
    openingHours: [],
    workingHours: workMonday,
    durationMinutes: 60,
    stepMinutes: 30,
  });
  assert.deepEqual(slots.map((s) => s.time), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
  assert.equal(slots[0].endsAt.toISOString(), "2026-10-12T13:00:00.000Z");
});

test("slots: interseção com a loja, agendamentos (com intervalo), folgas e antecedência", () => {
  const busy = [{ start: zonedTimeToUtc(DATE, 10 * 60, SP), end: zonedTimeToUtc(DATE, 10 * 60 + 45, SP) }];
  const timeOff = [{ start: zonedTimeToUtc(DATE, 11 * 60 + 30, SP), end: zonedTimeToUtc(DATE, 12 * 60, SP) }];
  const slots = buildDaySlots({
    date: DATE,
    timezone: SP,
    openingHours: [{ weekday: 1, opens_at: "09:30", closes_at: "20:00", is_closed: false }],
    workingHours: workMonday,
    durationMinutes: 30,
    bufferMinutes: 15,
    stepMinutes: 15,
    busy,
    timeOff,
    earliest: zonedTimeToUtc(DATE, 9 * 60 + 40, SP),
  });
  // 09:30 cai antes da antecedência; 09:45 + 30 + 15 encosta em 10:30 > 10:00 (ocupado);
  // 10:45 em diante livre até a folga das 11:30.
  assert.deepEqual(slots.map((s) => s.time), ["10:45", "11:00"]);
});

test("slots: sem jornada no dia ou duração inválida não gera horário", () => {
  assert.deepEqual(
    buildDaySlots({ date: "2026-10-13", timezone: SP, workingHours: workMonday, durationMinutes: 30 }),
    [],
  );
  assert.deepEqual(buildDaySlots({ date: DATE, timezone: SP, workingHours: workMonday, durationMinutes: 0 }), []);
  assert.deepEqual(buildDaySlots({ date: "2026-02-30", timezone: SP, workingHours: workMonday, durationMinutes: 30 }), []);
});
