// Status aberto/fechado da loja: horários cadastrados + exceção manual.
// Regra única usada pelo sino do header, dashboard, cardápio público, vitrine e
// pela rotina storeScheduleService.
//
// O horário de funcionamento é a regra principal. O override manual
// (companies.manual_open) é só uma exceção temporária — "fechar de última hora"
// com a loja aberta pelo horário, ou "abrir agora" com ela fechada — e vale até
// o próximo ponto do ciclo em que o horário leva ao mesmo estado escolhido:
//   • fechou às 21h (horário 18–23h): vale até as 23h; reabre às 18h do dia seguinte;
//   • abriu às 15h: vale até as 18h (o horário abre); fecha às 23h pelo horário;
//   • abriu às 23h30: vale até as 18h do dia seguinte; fecha às 23h desse dia.
// A partir desse ponto a exceção deixa de existir (a rotina limpa o campo).
//
// Fuso: os horários cadastrados são horário de parede da EMPRESA
// (companies.timezone, padrão America/Sao_Paulo). Nada aqui depende do fuso do
// processo Node (produção roda em UTC).
const {
  DEFAULT_TIMEZONE,
  resolveTimezone,
  zonedParts,
  formatDate,
  addDays,
  weekdayOf,
  zonedTimeToUtc,
} = require("./bookingSlots");

const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * 60000;
// Janela de turnos considerada: ontem (turno da madrugada) até daqui a 8 dias.
const FROM_DAY = -1;
const TO_DAY = 8;
// Além disso não há "próxima virada" real (ex.: loja aberta 24h todos os dias).
const MAX_LOOKAHEAD_MS = 8 * DAY_MS;

// company_opening_hours.weekday usa a convenção do portal (1=segunda … 7=domingo),
// enquanto Date.getDay() usa 0=domingo … 6=sábado. Segunda–sábado coincidem (1–6);
// só o domingo diverge (getDay()=0 vs weekday=7).
const isTodayWeekday = (rowWeekday, jsDay) => {
  const wd = Number(rowWeekday);
  if (jsDay === 0) return wd === 0 || wd === 7; // domingo
  return wd === jsDay; // segunda(1) … sábado(6)
};

// "HH:MM" / "HH:MM:SS" → minutos desde 00:00 (null se inválido).
const toMinutes = (value) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? "").trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes <= DAY_MINUTES ? minutes : null;
};

const _ms = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * Turnos [start, end) em ms (instantes UTC), ordenados e unidos quando se
 * encostam/sobrepõem. Um dia pode ter vários turnos (pausa = intervalo entre
 * eles). Fechamento <= abertura vira a madrugada: termina no dia seguinte
 * (00:00–00:00 = 24h).
 */
const scheduleIntervals = (hours, now = new Date(), timezone = DEFAULT_TIMEZONE) => {
  const tz = resolveTimezone(timezone);
  const today = formatDate(zonedParts(now, tz));
  const raw = [];
  for (let d = FROM_DAY; d <= TO_DAY; d++) {
    const date = addDays(today, d);
    const jsDay = weekdayOf(date);
    for (const row of hours || []) {
      if (row.is_closed === true || !isTodayWeekday(row.weekday, jsDay)) continue;
      const opens = toMinutes(row.opens_at);
      const closes = toMinutes(row.closes_at);
      if (opens === null || closes === null) continue;
      const start = zonedTimeToUtc(date, opens, tz).getTime();
      const end = zonedTimeToUtc(closes <= opens ? addDays(date, 1) : date, closes, tz).getTime();
      if (end > start) raw.push({ start, end });
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const it of raw) {
    const last = merged[merged.length - 1];
    if (last && it.start <= last.end) last.end = Math.max(last.end, it.end);
    else merged.push({ ...it });
  }
  return merged;
};

// O que os horários dizem no instante `now` (sem override).
const scheduleOpenAt = (hours, now = new Date(), timezone = DEFAULT_TIMEZONE) => {
  const t = _ms(now);
  return scheduleIntervals(hours, now, timezone).some((i) => t >= i.start && t < i.end);
};

// Próximo instante em que o horário muda de estado (abre ou fecha), ou null
// quando nenhum horário cadastrado muda o estado.
const nextScheduleChange = (hours, now = new Date(), timezone = DEFAULT_TIMEZONE) => {
  const t = _ms(now);
  const intervals = scheduleIntervals(hours, now, timezone);
  const current = intervals.find((i) => t >= i.start && t < i.end);
  const at = current ? current.end : intervals.find((i) => i.start > t)?.start;
  if (at == null || at - t > MAX_LOOKAHEAD_MS) return null;
  return new Date(at);
};

/**
 * Até quando vale uma exceção manual feita em `now`: o próximo ponto em que o
 * horário leva ao mesmo estado escolhido. null quando a escolha já é o que o
 * horário diz (não é exceção) ou quando o horário nunca chega a esse estado.
 */
const manualUntil = (hours, manualOpen, now = new Date(), timezone = DEFAULT_TIMEZONE) => {
  if (manualOpen !== true && manualOpen !== false) return null;
  if (manualOpen === scheduleOpenAt(hours, now, timezone)) return null;
  return nextScheduleChange(hours, now, timezone);
};

// `hours`: linhas de company_opening_hours (weekday, opens_at, closes_at, is_closed).
// `manualOpen`: companies.manual_open — TRUE/FALSE são a exceção; NULL segue horário.
// `manualOpenUntil`: companies.manual_open_until (quando existir) — fim gravado da
// exceção; garante a expiração mesmo que a rotina não rode no momento da virada.
// Um override igual ao horário atual (ou vencido) não é exceção nenhuma: vira
// null (e `manual_expired` sinaliza que o campo pode ser limpo no banco).
const resolveOpenStatus = (
  hours,
  manualOpen,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
  manualOpenUntil = null,
) => {
  const tz = resolveTimezone(timezone);
  const scheduleOpen = scheduleOpenAt(hours, now, tz);
  const raw = manualOpen === true || manualOpen === false ? manualOpen : null;
  const storedUntil = manualOpenUntil ? _ms(manualOpenUntil) : NaN;
  const pastUntil = Number.isFinite(storedUntil) && _ms(now) >= storedUntil;
  const manual = raw === null || raw === scheduleOpen || pastUntil ? null : raw;

  const next = nextScheduleChange(hours, now, tz);
  // Com exceção ativa, ela termina quando o horário chega ao mesmo estado
  // (`next`); o status efetivo só muda na virada seguinte do horário.
  const until = manual === null ? null : next;
  const nextChange = manual === null ? next : until && nextScheduleChange(hours, until, tz);

  return {
    is_open: manual ?? scheduleOpen,
    schedule_open: scheduleOpen,
    manual_open: manual,
    manual_expired: raw !== null && manual === null,
    // Quando a exceção manual termina e a loja volta a seguir o horário.
    manual_until: until ? until.toISOString() : null,
    // Próxima vez em que a loja (status efetivo) abre ou fecha sozinha.
    next_change_at: nextChange ? nextChange.toISOString() : null,
    // Turnos de hoje (horário de parede da empresa) para exibir no header.
    today_hours: todayHours(hours, now, tz),
    timezone: tz,
    // Offset atual do fuso da empresa (min) — o portal exibe horários nele.
    utc_offset_minutes: utcOffsetMinutes(tz, now),
  };
};

// Turnos cadastrados para o dia local de `now` ("HH:MM"), na ordem do dia.
const todayHours = (hours, now = new Date(), timezone = DEFAULT_TIMEZONE) => {
  const tz = resolveTimezone(timezone);
  const jsDay = weekdayOf(formatDate(zonedParts(now, tz)));
  const hm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return (hours || [])
    .filter((row) => row.is_closed !== true && isTodayWeekday(row.weekday, jsDay))
    .map((row) => ({ opens: toMinutes(row.opens_at), closes: toMinutes(row.closes_at) }))
    .filter((r) => r.opens !== null && r.closes !== null)
    .sort((a, b) => a.opens - b.opens)
    .map((r) => ({ opens_at: hm(r.opens), closes_at: hm(r.closes), overnight: r.closes <= r.opens }));
};

// Offset (minutos) do fuso `timezone` no instante `at` (ex.: -180 em São Paulo).
const utcOffsetMinutes = (timezone = DEFAULT_TIMEZONE, at = new Date()) => {
  const tz = resolveTimezone(timezone);
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(_ms(at) / 1000) * 1000) / 60000);
};

module.exports = {
  isTodayWeekday,
  toMinutes,
  scheduleIntervals,
  scheduleOpenAt,
  nextScheduleChange,
  manualUntil,
  todayHours,
  resolveOpenStatus,
  utcOffsetMinutes,
};
