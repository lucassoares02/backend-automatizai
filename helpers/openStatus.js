// Status aberto/fechado da loja: horários cadastrados + override manual.
// Mesma regra usada pelo dashboard (dashboardService) e pelo sino do header.

// company_opening_hours.weekday usa a convenção do portal (1=segunda … 7=domingo),
// enquanto Date.getDay() usa 0=domingo … 6=sábado. Segunda–sábado coincidem (1–6);
// só o domingo diverge (getDay()=0 vs weekday=7).
const isTodayWeekday = (rowWeekday, jsDay) => {
  const wd = Number(rowWeekday);
  if (jsDay === 0) return wd === 0 || wd === 7; // domingo
  return wd === jsDay; // segunda(1) … sábado(6)
};

// `hours`: linhas de company_opening_hours (weekday, opens_at, closes_at, is_closed).
// `manualOpen`: companies.manual_open — TRUE/FALSE forçam; NULL segue horário.
const resolveOpenStatus = (hours, manualOpen, now = new Date()) => {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const currentTime = `${hh}:${mm}:${ss}`;
  const todayHours = (hours || []).find((h) => isTodayWeekday(h.weekday, now.getDay()));
  let scheduleOpen = false;
  if (todayHours && !todayHours.is_closed && todayHours.opens_at && todayHours.closes_at) {
    scheduleOpen = currentTime >= todayHours.opens_at && currentTime <= todayHours.closes_at;
  }
  const manual = manualOpen === true || manualOpen === false ? manualOpen : null;
  return {
    is_open: manual ?? scheduleOpen,
    schedule_open: scheduleOpen,
    manual_open: manual,
  };
};

module.exports = { isTodayWeekday, resolveOpenStatus };
