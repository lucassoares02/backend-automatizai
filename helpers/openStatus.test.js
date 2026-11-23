const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveOpenStatus,
  nextScheduleChange,
  scheduleOpenAt,
  manualUntil,
  todayHours,
  utcOffsetMinutes,
} = require("./openStatus");

const SP = "America/Sao_Paulo";
// Horário de parede de São Paulo → instante absoluto (independe do TZ do processo).
const sp = (local) => new Date(`${local}-03:00`);
const iso = (local) => sp(local).toISOString();
const every = (opens, closes) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens_at: opens, closes_at: closes, is_closed: false }));

// 2026-11-23 é uma segunda-feira.
const H18_23 = every("18:00:00", "23:00:00");

test("cenário A: fechar às 21h vale até as 23h e reabre às 18h do dia seguinte", () => {
  const at = sp("2026-11-23T21:00:00");
  assert.equal(scheduleOpenAt(H18_23, at, SP), true);
  const s = resolveOpenStatus(H18_23, false, at, SP);
  assert.equal(s.is_open, false);
  assert.equal(s.manual_open, false);
  assert.equal(s.manual_until, iso("2026-11-23T23:00:00"));
  assert.equal(s.next_change_at, iso("2026-11-24T18:00:00"));
  // 23h: o horário também diz fechado → a exceção termina.
  const after = resolveOpenStatus(H18_23, false, sp("2026-11-23T23:00:00"), SP);
  assert.equal(after.manual_expired, true);
  assert.equal(after.is_open, false);
  // 18h do dia seguinte: abre pelo horário.
  assert.equal(resolveOpenStatus(H18_23, null, sp("2026-11-24T18:00:00"), SP).is_open, true);
});

test("cenário B: abrir às 15h fica aberta e fecha às 23h do mesmo dia", () => {
  const s = resolveOpenStatus(H18_23, true, sp("2026-11-23T15:00:00"), SP);
  assert.equal(s.is_open, true);
  assert.equal(s.manual_until, iso("2026-11-23T18:00:00"));
  assert.equal(s.next_change_at, iso("2026-11-23T23:00:00"));
  const at18 = resolveOpenStatus(H18_23, true, sp("2026-11-23T18:00:00"), SP);
  assert.equal(at18.manual_expired, true);
  assert.equal(at18.is_open, true);
  assert.equal(resolveOpenStatus(H18_23, null, sp("2026-11-23T23:00:00"), SP).is_open, false);
});

test("cenário C: abrir às 23h30 vale até as 23h do dia seguinte", () => {
  const s = resolveOpenStatus(H18_23, true, sp("2026-11-23T23:30:00"), SP);
  assert.equal(s.is_open, true);
  assert.equal(s.manual_until, iso("2026-11-24T18:00:00"));
  assert.equal(s.next_change_at, iso("2026-11-24T23:00:00"));
  // Madrugada e tarde do dia seguinte: continua aberta pela exceção.
  assert.equal(resolveOpenStatus(H18_23, true, sp("2026-11-24T10:00:00"), SP).is_open, true);
  // 23h do dia seguinte: fecha pelo horário.
  assert.equal(resolveOpenStatus(H18_23, null, sp("2026-11-24T23:00:00"), SP).is_open, false);
});

test("exceção gravada com manual_open_until expira mesmo sem a rotina rodar na virada", () => {
  const until = manualUntil(H18_23, true, sp("2026-11-23T23:30:00"), SP);
  // Rotina parada entre 18h e 23h do dia seguinte: às 23h30 já venceu.
  const s = resolveOpenStatus(H18_23, true, sp("2026-11-24T23:30:00"), SP, until);
  assert.equal(s.manual_expired, true);
  assert.equal(s.is_open, false);
});

test("pedir o mesmo que o horário não é exceção", () => {
  assert.equal(manualUntil(H18_23, true, sp("2026-11-23T19:00:00"), SP), null);
  const s = resolveOpenStatus(H18_23, true, sp("2026-11-23T19:00:00"), SP);
  assert.equal(s.manual_open, null);
  assert.equal(s.manual_expired, true);
  assert.equal(s.next_change_at, iso("2026-11-23T23:00:00"));
});

test("horário é interpretado no fuso da empresa (Mon Chou 08–12h às 10h54 de Brasília)", () => {
  const monChou = [1, 2, 3, 4, 5, 6]
    .map((weekday) => ({ weekday, opens_at: "08:00:00", closes_at: "12:00:00", is_closed: false }))
    .concat([{ weekday: 7, opens_at: "00:00:00", closes_at: "00:00:00", is_closed: true }]);
  const now = new Date("2026-11-23T13:54:00Z");
  const s = resolveOpenStatus(monChou, true, now, SP);
  assert.equal(s.schedule_open, true);
  assert.equal(s.manual_expired, true);
  assert.equal(s.next_change_at, iso("2026-11-23T12:00:00"));
  assert.deepEqual(s.today_hours, [{ opens_at: "08:00", closes_at: "12:00", overnight: false }]);
  assert.equal(s.utc_offset_minutes, -180);
  // Sábado às 12h → só abre segunda às 8h (domingo fechado).
  assert.equal(nextScheduleChange(monChou, sp("2026-11-28T12:00:00"), SP).toISOString(), iso("2026-11-30T08:00:00"));
});

test("virada de dia usa a data local: 22h de domingo em Brasília ainda é domingo", () => {
  const hours = [{ weekday: 7, opens_at: "18:00:00", closes_at: "23:00:00", is_closed: false }];
  // 2026-11-22 é domingo; 22h BRT = 01h UTC de segunda.
  assert.equal(scheduleOpenAt(hours, sp("2026-11-22T22:00:00"), SP), true);
  assert.equal(scheduleOpenAt(hours, sp("2026-11-23T22:00:00"), SP), false);
});

test("turno que passa da meia-noite continua aberto na madrugada", () => {
  // Sexta 17h–01h30; sábado fechado.
  const hours = [{ weekday: 5, opens_at: "17:00:00", closes_at: "01:30:00", is_closed: false }];
  assert.equal(scheduleOpenAt(hours, sp("2026-11-27T23:00:00"), SP), true);
  assert.equal(scheduleOpenAt(hours, sp("2026-11-28T01:00:00"), SP), true);
  assert.equal(scheduleOpenAt(hours, sp("2026-11-28T01:30:00"), SP), false);
  assert.equal(nextScheduleChange(hours, sp("2026-11-27T23:00:00"), SP).toISOString(), iso("2026-11-28T01:30:00"));
  assert.deepEqual(todayHours(hours, sp("2026-11-27T20:00:00"), SP), [
    { opens_at: "17:00", closes_at: "01:30", overnight: true },
  ]);
});

test("vários turnos no dia: pausa fica fechada", () => {
  const hours = [
    { weekday: 1, opens_at: "11:00", closes_at: "14:00", is_closed: false },
    { weekday: 1, opens_at: "18:00", closes_at: "23:00", is_closed: false },
  ];
  assert.equal(scheduleOpenAt(hours, sp("2026-11-23T12:00:00"), SP), true);
  assert.equal(scheduleOpenAt(hours, sp("2026-11-23T15:00:00"), SP), false);
  assert.equal(nextScheduleChange(hours, sp("2026-11-23T15:00:00"), SP).toISOString(), iso("2026-11-23T18:00:00"));
  // Fechada manualmente às 12h: vale até 14h; reabre às 18h.
  const s = resolveOpenStatus(hours, false, sp("2026-11-23T12:00:00"), SP);
  assert.equal(s.manual_until, iso("2026-11-23T14:00:00"));
  assert.equal(s.next_change_at, iso("2026-11-23T18:00:00"));
});

test("sem horário ou aberta 24h: sem próxima virada; exceção vale até mudar", () => {
  assert.equal(nextScheduleChange([], sp("2026-11-23T10:00:00"), SP), null);
  const s = resolveOpenStatus([], true, sp("2026-11-23T10:00:00"), SP);
  assert.equal(s.is_open, true);
  assert.equal(s.manual_until, null);
  assert.equal(s.next_change_at, null);
  const allDay = every("00:00", "00:00");
  assert.equal(scheduleOpenAt(allDay, sp("2026-11-23T03:00:00"), SP), true);
  assert.equal(nextScheduleChange(allDay, sp("2026-11-23T03:00:00"), SP), null);
});

test("dia fechado ou domingo cadastrado como 7", () => {
  const sunday = [{ weekday: 7, opens_at: "10:00:00", closes_at: "14:00:00", is_closed: false }];
  assert.equal(scheduleOpenAt(sunday, sp("2026-11-22T12:00:00"), SP), true);
  assert.equal(scheduleOpenAt([{ ...sunday[0], is_closed: true }], sp("2026-11-22T12:00:00"), SP), false);
  assert.equal(resolveOpenStatus([], undefined, sp("2026-11-22T12:00:00"), SP).manual_open, null);
});

test("fuso inválido cai no padrão de São Paulo", () => {
  assert.equal(utcOffsetMinutes("Nada/Existe", new Date("2026-11-23T12:00:00Z")), -180);
  assert.equal(resolveOpenStatus(H18_23, null, sp("2026-11-23T19:00:00"), "Nada/Existe").is_open, true);
});
