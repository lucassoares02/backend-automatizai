// Cálculo puro dos horários livres de um serviço (Fase 2 do agendamento).
// Todo horário de parede (jornada, abertura da loja, data escolhida) é
// interpretado no fuso da EMPRESA; as datas absolutas (agendamentos, folgas,
// "agora") chegam como Date/ms. Sem acesso ao banco para poder ser testado.

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DAY_MINUTES = 24 * 60;
const _DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const _TIME_RE = /^(\d{1,2}):(\d{2})/;

const _formatters = new Map();
const _formatter = (tz) => {
  if (!_formatters.has(tz)) {
    _formatters.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  }
  return _formatters.get(tz);
};

/** Fuso IANA válido ou o padrão (America/Sao_Paulo). */
const resolveTimezone = (tz) => {
  const value = typeof tz === "string" ? tz.trim() : "";
  if (!value) return DEFAULT_TIMEZONE;
  try {
    _formatter(value);
    return value;
  } catch (_) {
    return DEFAULT_TIMEZONE;
  }
};

/** Partes do relógio local (no fuso `tz`) de um instante. */
const zonedParts = (date, tz) => {
  const parts = _formatter(tz).formatToParts(new Date(date));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};

const _offsetMinutes = (utcMs, tz) => {
  const p = zonedParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
};

const parseDate = (value) => {
  const m = _DATE_RE.exec(String(value || "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { year: y, month: mo, day: d };
};

const _pad = (n) => String(n).padStart(2, "0");
const formatDate = ({ year, month, day }) => `${year}-${_pad(month)}-${_pad(day)}`;
const formatTime = (minutes) => `${_pad(Math.floor(minutes / 60))}:${_pad(minutes % 60)}`;

/** "YYYY-MM-DD" + n dias (calendário puro, sem fuso). */
const addDays = (dateStr, n) => {
  const p = parseDate(dateStr);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
};

/** 0=domingo … 6=sábado da data de calendário. */
const weekdayOf = (dateStr) => {
  const p = parseDate(dateStr);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
};

/** Data local ("YYYY-MM-DD") de um instante no fuso `tz`. */
const localDate = (date, tz) => formatDate(zonedParts(date, tz));

/** Instante UTC do horário de parede `minutes` (desde 00:00) na data local. */
const zonedTimeToUtc = (dateStr, minutes, tz) => {
  const p = parseDate(dateStr);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, minutes);
  const first = _offsetMinutes(guess, tz);
  let utc = guess - first * 60000;
  const second = _offsetMinutes(utc, tz);
  if (second !== first) utc = guess - second * 60000;
  return new Date(utc);
};

const _toMinutes = (value) => {
  const m = _TIME_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes <= DAY_MINUTES ? minutes : null;
};

// company_opening_hours aceita domingo como 0 OU 7 (ver _isTodayWeekday).
const _sameWeekday = (rowWeekday, weekday) => {
  const wd = Number(rowWeekday);
  return weekday === 0 ? wd === 0 || wd === 7 : wd === weekday;
};

/**
 * Faixas de abertura da loja no dia (minutos). `null` quando a empresa não
 * cadastrou horário nenhum (a jornada do profissional manda sozinha).
 * Fechamento <= abertura (vira a madrugada) é tratado como até 24:00.
 */
const companyDayIntervals = (openingHours, weekday) => {
  if (!Array.isArray(openingHours) || openingHours.length === 0) return null;
  const out = [];
  for (const row of openingHours) {
    if (!_sameWeekday(row.weekday, weekday) || row.is_closed === true) continue;
    const start = _toMinutes(row.opens_at);
    let end = _toMinutes(row.closes_at);
    if (start === null || end === null) continue;
    if (end <= start) end = DAY_MINUTES;
    out.push({ start, end });
  }
  return out;
};

/** Turnos do profissional no dia (weekday 0=domingo … 6=sábado). */
const professionalDayIntervals = (workingHours, weekday) =>
  (Array.isArray(workingHours) ? workingHours : [])
    .filter((row) => Number(row.weekday) === weekday)
    .map((row) => ({ start: _toMinutes(row.start_time), end: _toMinutes(row.end_time) }))
    .filter((r) => r.start !== null && r.end !== null && r.end > r.start)
    .sort((a, b) => a.start - b.start);

const intersectIntervals = (a, b) => {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
};

const _ms = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());
const _overlaps = (start, end, ranges) => ranges.some((r) => start < _ms(r.end) && end > _ms(r.start));

/**
 * Horários livres de UM profissional em UMA data local.
 *
 * - janela = jornada do profissional ∩ abertura da loja;
 * - o serviço (duração) precisa caber inteiro na janela; o intervalo pós-serviço
 *   (buffer) pode passar do fim do turno, mas não pode colidir com outro agendamento;
 * - `busy` são intervalos [starts_at, blocked_until) de agendamentos ativos;
 * - `timeOff` são folgas/bloqueios [starts_at, ends_at);
 * - `earliest` = agora + antecedência mínima.
 */
const buildDaySlots = ({
  date,
  timezone,
  openingHours,
  workingHours,
  durationMinutes,
  bufferMinutes = 0,
  stepMinutes = 15,
  busy = [],
  timeOff = [],
  earliest = null,
}) => {
  const tz = resolveTimezone(timezone);
  const duration = Number(durationMinutes);
  const buffer = Math.max(0, Number(bufferMinutes) || 0);
  const step = Math.max(5, Number(stepMinutes) || 15);
  if (!parseDate(date) || !Number.isInteger(duration) || duration <= 0) return [];

  const weekday = weekdayOf(date);
  let windows = professionalDayIntervals(workingHours, weekday);
  const company = companyDayIntervals(openingHours, weekday);
  if (company) windows = intersectIntervals(windows, company);

  const earliestMs = earliest == null ? -Infinity : _ms(earliest);
  const seen = new Set();
  const slots = [];
  for (const window of windows) {
    for (let t = window.start; t + duration <= window.end; t += step) {
      if (seen.has(t)) continue;
      const startsAt = zonedTimeToUtc(date, t, tz);
      const start = startsAt.getTime();
      const end = start + duration * 60000;
      const blockedUntil = end + buffer * 60000;
      if (start < earliestMs) continue;
      if (_overlaps(start, blockedUntil, busy)) continue;
      if (_overlaps(start, end, timeOff)) continue;
      seen.add(t);
      slots.push({ time: formatTime(t), startsAt, endsAt: new Date(end), blockedUntil: new Date(blockedUntil) });
    }
  }
  return slots.sort((a, b) => a.startsAt - b.startsAt);
};

module.exports = {
  DEFAULT_TIMEZONE,
  resolveTimezone,
  zonedParts,
  parseDate,
  formatDate,
  addDays,
  weekdayOf,
  localDate,
  zonedTimeToUtc,
  companyDayIntervals,
  professionalDayIntervals,
  intersectIntervals,
  buildDaySlots,
};
