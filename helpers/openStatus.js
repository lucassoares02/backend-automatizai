// Status aberto/fechado da loja: horários cadastrados + exceção manual.
// Mesma regra usada pelo dashboard (dashboardService) e pelo sino do header.
//
// O horário de funcionamento é a regra principal. O override manual
// (companies.manual_open) é só uma exceção temporária — "fechar de última hora"
// com a loja aberta pelo horário, ou "abrir agora" com ela fechada — e vale até
// a próxima virada do horário: quando o horário passa a dizer o mesmo que o
// override, ele deixa de existir (a rotina storeScheduleService limpa o campo).

// company_opening_hours.weekday usa a convenção do portal (1=segunda … 7=domingo),
// enquanto Date.getDay() usa 0=domingo … 6=sábado. Segunda–sábado coincidem (1–6);
// só o domingo diverge (getDay()=0 vs weekday=7).
const isTodayWeekday = (rowWeekday, jsDay) => {
  const wd = Number(rowWeekday);
  if (jsDay === 0) return wd === 0 || wd === 7; // domingo
  return wd === jsDay; // segunda(1) … sábado(6)
};

const pad = (n) => String(n).padStart(2, "0");
const timeOf = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

// Normaliza "HH:MM" / "HH:MM:SS" para "HH:MM:SS".
const normalizeTime = (value) => {
  const [h = "0", m = "0", s = "0"] = String(value).split(":");
  return `${pad(Number(h))}:${pad(Number(m))}:${pad(Number(s))}`;
};

const hoursFor = (hours, date) => {
  const row = (hours || []).find((h) => isTodayWeekday(h.weekday, date.getDay()));
  if (!row || row.is_closed || !row.opens_at || !row.closes_at) return null;
  return { opens: normalizeTime(row.opens_at), closes: normalizeTime(row.closes_at) };
};

const atTime = (day, time) => {
  const [h, m, s] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s);
};

// O que os horários dizem agora (sem override).
const scheduleOpenAt = (hours, now = new Date()) => {
  const today = hoursFor(hours, now);
  if (!today) return false;
  const current = timeOf(now);
  return current >= today.opens && current <= today.closes;
};

// Próximo momento em que o horário muda de estado (abre ou fecha), em até 7 dias.
// null quando não há horário cadastrado que mude o estado.
const nextScheduleChange = (hours, now = new Date()) => {
  const open = scheduleOpenAt(hours, now);
  for (let d = 0; d <= 7; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const slot = hoursFor(hours, day);
    if (!slot) continue;
    const at = atTime(day, open ? slot.closes : slot.opens);
    if (at > now) return at;
  }
  return null;
};

// `hours`: linhas de company_opening_hours (weekday, opens_at, closes_at, is_closed).
// `manualOpen`: companies.manual_open — TRUE/FALSE são a exceção; NULL segue horário.
// Um override igual ao horário atual não é exceção nenhuma: vira null (e
// `manual_expired` sinaliza que o campo pode ser limpo no banco).
const resolveOpenStatus = (hours, manualOpen, now = new Date()) => {
  const scheduleOpen = scheduleOpenAt(hours, now);
  const raw = manualOpen === true || manualOpen === false ? manualOpen : null;
  const manual = raw === scheduleOpen ? null : raw;
  const next = nextScheduleChange(hours, now);
  return {
    is_open: manual ?? scheduleOpen,
    schedule_open: scheduleOpen,
    manual_open: manual,
    manual_expired: raw !== null && manual === null,
    // Próxima virada do horário: é também quando a exceção manual termina.
    next_change_at: next ? next.toISOString() : null,
  };
};

module.exports = { isTodayWeekday, scheduleOpenAt, nextScheduleChange, resolveOpenStatus };
