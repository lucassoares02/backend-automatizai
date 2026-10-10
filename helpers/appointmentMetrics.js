// Regras puras da Fase 3 do agendamento (sem banco, testáveis):
// - janela dos lembretes (24h e 2h antes);
// - minutos disponíveis de um profissional num período (taxa de ocupação).

const slots = require("./bookingSlots");

const HOUR_MS = 3600000;

// Lembretes: [antecedência, rótulo]. O lembrete só sai se o agendamento foi
// criado ANTES da janela (quem marca para daqui a 3h não recebe o de 24h, que
// chegaria colado na confirmação) e enquanto o horário ainda não começou.
const REMINDERS = Object.freeze([
  { kind: "24h", hours: 24, column: "reminder_24h_sent_at" },
  { kind: "2h", hours: 2, column: "reminder_2h_sent_at" },
]);

/**
 * Qual lembrete (se algum) cabe agora para o agendamento. Retorna o mais
 * próximo do horário ainda não enviado — se o cron ficou parado e o de 24h e o
 * de 2h venceram juntos, só o de 2h sai (o de 24h é marcado como pulado).
 */
const dueReminder = ({ startsAt, createdAt, sent = {} }, now = new Date()) => {
  const start = new Date(startsAt).getTime();
  const created = createdAt ? new Date(createdAt).getTime() : -Infinity;
  const nowMs = now.getTime();
  if (!Number.isFinite(start) || nowMs >= start) return null;
  const due = REMINDERS.filter((r) => {
    const opensAt = start - r.hours * HOUR_MS;
    return !sent[r.kind] && nowMs >= opensAt && created < opensAt;
  });
  if (!due.length) return null;
  const chosen = due[due.length - 1];
  return { ...chosen, skip: due.slice(0, -1).map((r) => r.kind) };
};

const _mergeIntervals = (ranges) => {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
};

const _subtract = (ranges, cuts) => {
  let current = ranges;
  for (const cut of cuts) {
    const next = [];
    for (const r of current) {
      if (cut.end <= r.start || cut.start >= r.end) {
        next.push(r);
        continue;
      }
      if (cut.start > r.start) next.push({ start: r.start, end: cut.start });
      if (cut.end < r.end) next.push({ start: cut.end, end: r.end });
    }
    current = next;
  }
  return current;
};

/**
 * Minutos de agenda aberta de um profissional entre as datas locais
 * [fromDate, toDate] (inclusivas): jornada ∩ abertura da loja − folgas.
 * É o denominador da taxa de ocupação.
 */
const availableMinutes = ({ fromDate, toDate, timezone, workingHours, openingHours = [], timeOff = [] }) => {
  const tz = slots.resolveTimezone(timezone);
  if (!slots.parseDate(fromDate) || !slots.parseDate(toDate) || fromDate > toDate) return 0;
  const offMs = (Array.isArray(timeOff) ? timeOff : []).map((t) => ({
    start: new Date(t.starts_at ?? t.start).getTime(),
    end: new Date(t.ends_at ?? t.end).getTime(),
  }));
  let total = 0;
  for (let date = fromDate, guard = 0; date <= toDate && guard < 400; date = slots.addDays(date, 1), guard++) {
    const weekday = slots.weekdayOf(date);
    let windows = slots.professionalDayIntervals(workingHours, weekday);
    const company = slots.companyDayIntervals(openingHours, weekday);
    if (company) windows = slots.intersectIntervals(windows, company);
    const absolute = _mergeIntervals(
      windows.map((w) => ({
        start: slots.zonedTimeToUtc(date, w.start, tz).getTime(),
        end: slots.zonedTimeToUtc(date, w.end, tz).getTime(),
      })),
    );
    for (const r of _subtract(absolute, offMs)) total += (r.end - r.start) / 60000;
  }
  return Math.round(total);
};

/** Percentual com 1 casa (0 quando o denominador é 0). */
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

module.exports = { REMINDERS, dueReminder, availableMinutes, rate };
