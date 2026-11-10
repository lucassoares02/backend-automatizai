// Assinaturas (Fase 4): regras puras do agendamento de serviços pela assinatura.
// Sem banco e sem HTTP, para ficar testável (api/tests/subscriptionUsage.test.js).
//
// Regras do negócio (decididas, não há modelo de créditos):
// - o plano limita o uso por CICLO DE COBRANÇA (ilimitado ou N vezes);
// - o agendamento conta no ciclo da DATA DO ATENDIMENTO, não do dia em que foi
//   marcado (não dá para "acumular" marcando vários no último dia do ciclo);
// - conta ao marcar; cancelar dentro da janela de cancelamento (ou a loja
//   cancelar/recusar) libera o uso; falta (no-show) conta;
// - todos os planos: só 1 agendamento futuro por vez;
// - assinatura pausada: o ciclo já pago continua agendável, nada depois do
//   vencimento; ao pausar, os agendamentos do ciclo não pago são cancelados;
// - assinatura cancelada, encerrada ou com chargeback: os agendamentos futuros
//   que caem depois do fim do último ciclo pago são cancelados (ciclo estornado
//   ou contestado não conta como pago).

const DAY_MS = 24 * 3600 * 1000;

// Status de agendamento que ocupam um uso do ciclo. 'cancelled' libera.
const USAGE_STATUSES = ["hold", "pending", "confirmed", "in_progress", "done", "no_show"];
// Agendamento ainda por acontecer (trava "1 futuro por vez").
const UPCOMING_STATUSES = ["hold", "pending", "confirmed"];
const BOOKABLE_SUBSCRIPTION_STATUSES = ["active", "paused"];
const PAUSE_CANCEL_REASON = "subscription_paused";
const CLOSE_CANCEL_REASON = "subscription_closed";

const _date = (value) => {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const _daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Soma `k` ciclos (semana, mês ou ano) a partir da âncora, sem acumular arredondamento de mês. */
const addCycles = (anchor, interval, k) => {
  const base = _date(anchor);
  if (!base) return null;
  if (interval === "week") return new Date(base.getTime() + k * 7 * DAY_MS);
  const months = interval === "year" ? 12 * k : k;
  const total = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(base.getUTCDate(), _daysInMonth(year, month));
  return new Date(Date.UTC(
    year, month, day,
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds(),
  ));
};

/** Âncora dos ciclos: início do ciclo atual na Pagar.me ou, sem ele, a contratação. */
const cycleAnchor = (sub) => _date(sub?.current_cycle_start) || _date(sub?.created_at);

/** Ciclo [start, end) que contém `at`. `index` é relativo à âncora (pode ser negativo). */
const cycleFor = (anchor, interval, at) => {
  const a = _date(anchor);
  const t = _date(at);
  if (!a || !t) return null;
  let k;
  if (interval === "week") {
    k = Math.floor((t.getTime() - a.getTime()) / (7 * DAY_MS));
  } else {
    const months = (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth());
    k = interval === "year" ? Math.floor(months / 12) : months;
  }
  while (addCycles(a, interval, k) > t) k -= 1;
  while (addCycles(a, interval, k + 1) <= t) k += 1;
  return { index: k, start: addCycles(a, interval, k), end: addCycles(a, interval, k + 1) };
};

const countsAsUsage = (appointment) => USAGE_STATUSES.includes(appointment?.status);

const isUpcoming = (appointment, now = new Date()) =>
  UPCOMING_STATUSES.includes(appointment?.status) && _date(appointment?.starts_at) > now;

/**
 * Até quando a assinatura deixa agendar (exclusivo; null = sem limite além do
 * horizonte da loja).
 * - pausada: até o vencimento da 1ª fatura não paga (início do ciclo em aberto);
 * - plano com prazo: até o fim do último ciclo contratado.
 * `invoices`: [{ status, period_start, period_end }].
 */
const bookableUntil = (sub, invoices = []) => {
  const list = Array.isArray(invoices) ? invoices : [];
  const paid = list.filter((i) => i.status === "paid");
  const starts = (rows) => rows.map((i) => _date(i.period_start)).filter(Boolean).sort((x, y) => x - y);
  const ends = (rows) => rows.map((i) => _date(i.period_end)).filter(Boolean).sort((x, y) => x - y);

  let limit = null;
  if (sub?.status === "paused") {
    const unpaidStart = starts(list.filter((i) => i.status === "failed"))[0];
    const paidEnd = ends(paid).pop();
    limit = unpaidStart || paidEnd || _date(sub.current_cycle_start) || _date(sub.paused_at);
  }

  const duration = Number(sub?.duration_cycles) || 0;
  if (duration > 0) {
    const first = starts(paid)[0]
      || (cycleAnchor(sub) && addCycles(cycleAnchor(sub), sub.interval, -Math.max(0, (Number(sub.paid_cycles) || 1) - 1)));
    const planEnd = first ? addCycles(first, sub.interval, duration) : null;
    if (planEnd && (!limit || planEnd < limit)) limit = planEnd;
  }
  return limit;
};

const _fmt = (date, timezone, options) => {
  try {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone || "America/Sao_Paulo", ...options }).format(date);
  } catch (_) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", ...options }).format(date);
  }
};
const formatDay = (date, timezone) => _fmt(date, timezone, { day: "2-digit", month: "2-digit" });
const formatDayTime = (date, timezone) =>
  `${formatDay(date, timezone)} às ${_fmt(date, timezone, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
// Último dia do ciclo [start, end): o instante anterior ao fim.
const _lastDay = (end, timezone) => formatDay(new Date(end.getTime() - 1), timezone);

/**
 * Uso no ciclo que contém `at`. `appointments`: agendamentos da assinatura
 * ({ id, status, starts_at }), sem o que está sendo remarcado.
 */
const usageInCycle = (sub, appointments, at) => {
  const cycle = cycleFor(cycleAnchor(sub), sub?.interval, at);
  if (!cycle) return { cycle: null, used: 0 };
  const used = (appointments || []).filter((a) => {
    const s = _date(a.starts_at);
    return countsAsUsage(a) && s && s >= cycle.start && s < cycle.end;
  }).length;
  return { cycle, used };
};

const _usageLimit = (sub) => {
  const n = Number(sub?.usage_limit);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Pode agendar pela assinatura em `startsAt`? Retorna
 * { ok, code?, message?, cycle, used, limit, bookable_until }.
 * Ordem das travas: status → vencimento/prazo → 1 futuro por vez → limite.
 */
const evaluateBooking = ({ sub, startsAt, appointments = [], invoices = [], now = new Date(), timezone = null }) => {
  const at = _date(startsAt);
  const limit = _usageLimit(sub);
  const base = { cycle: null, used: 0, limit, bookable_until: null };
  const fail = (code, message, extra = {}) => ({ ...base, ...extra, ok: false, code, message });

  if (!sub || !at) return fail("SUBSCRIPTION_NOT_FOUND", "Assinatura não encontrada.");
  if (!BOOKABLE_SUBSCRIPTION_STATUSES.includes(sub.status)) {
    if (sub.status === "pending") {
      return fail("SUBSCRIPTION_PENDING", "A primeira cobrança da assinatura ainda não foi confirmada. Tente de novo em instantes.");
    }
    return fail("SUBSCRIPTION_INACTIVE", "Esta assinatura não está mais ativa.");
  }

  const until = bookableUntil(sub, invoices);
  const { cycle, used } = usageInCycle(sub, appointments, at);
  const info = { cycle, used, bookable_until: until };

  if (until && at >= until) {
    if (sub.status === "paused") {
      return fail(
        "SUBSCRIPTION_PAUSED",
        until > now
          ? `Sua assinatura está pausada porque o pagamento foi recusado. Dá para agendar até ${_lastDay(until, timezone)}; atualize o cartão para liberar novas datas.`
          : "Sua assinatura está pausada porque o pagamento foi recusado. Atualize o cartão para voltar a agendar.",
        info,
      );
    }
    return fail(
      "SUBSCRIPTION_PLAN_ENDS",
      `Seu plano termina em ${_lastDay(until, timezone)}. Escolha uma data até esse dia.`,
      info,
    );
  }

  const upcoming = (appointments || [])
    .filter((a) => isUpcoming(a, now))
    .sort((x, y) => _date(x.starts_at) - _date(y.starts_at))[0];
  if (upcoming) {
    return fail(
      "SUBSCRIPTION_FUTURE_EXISTS",
      `Você já tem um agendamento pela assinatura em ${formatDayTime(_date(upcoming.starts_at), timezone)}. Marque o próximo depois dele.`,
      { ...info, upcoming_appointment_id: upcoming.id },
    );
  }

  if (limit != null && cycle && used >= limit) {
    return fail(
      "SUBSCRIPTION_LIMIT_REACHED",
      `Você já usou ${used} de ${limit} neste ciclo (${formatDay(cycle.start, timezone)} a ${_lastDay(cycle.end, timezone)}). Escolha uma data a partir de ${formatDay(cycle.end, timezone)}.`,
      info,
    );
  }
  return { ...base, ...info, ok: true };
};

/**
 * Agendamentos a cancelar quando a assinatura pausa: os ainda por acontecer com
 * data a partir do vencimento (ciclo não pago).
 */
const appointmentsToCancelOnPause = (sub, appointments, invoices, now = new Date()) => {
  const until = bookableUntil({ ...sub, status: "paused" }, invoices);
  if (!until) return [];
  return (appointments || []).filter((a) => isUpcoming(a, now) && _date(a.starts_at) >= until);
};

/**
 * Fim do último ciclo pago (exclusivo). null = nenhum ciclo pago. Sem faturas
 * com período conhecido, usa o ciclo atual da assinatura se ela já pagou algo.
 */
const paidUntil = (sub, invoices = []) => {
  const list = Array.isArray(invoices) ? invoices : [];
  const ends = list
    .filter((i) => i.status === "paid")
    .map((i) => _date(i.period_end))
    .filter(Boolean)
    .sort((x, y) => x - y);
  if (ends.length) return ends.pop();
  const settled = list.some((i) => ["paid", "refunded", "chargedback"].includes(i.status));
  return !settled && Number(sub?.paid_cycles) > 0 ? _date(sub?.current_cycle_end) : null;
};

/**
 * Agendamentos a cancelar quando a assinatura é cancelada/encerrada: os ainda
 * por acontecer com data a partir do fim do último ciclo pago.
 */
const appointmentsToCancelOnClose = (sub, appointments, invoices, now = new Date()) => {
  const until = paidUntil(sub, invoices);
  return (appointments || []).filter((a) => isUpcoming(a, now) && (!until || _date(a.starts_at) >= until));
};

/** Resumo para "Minhas assinaturas": uso no ciclo atual e próximo agendamento. */
const bookingSummary = ({ sub, appointments = [], invoices = [], now = new Date(), timezone = null }) => {
  const limit = _usageLimit(sub);
  const { cycle, used } = usageInCycle(sub, appointments, now);
  const upcoming = (appointments || [])
    .filter((a) => isUpcoming(a, now))
    .sort((x, y) => _date(x.starts_at) - _date(y.starts_at))[0] || null;
  const check = evaluateBooking({ sub, startsAt: new Date(now.getTime() + 60 * 1000), appointments, invoices, now, timezone });
  return {
    usage_limit: limit,
    used_in_cycle: used,
    cycle_start: cycle?.start || null,
    cycle_end: cycle?.end || null,
    bookable_until: bookableUntil(sub, invoices),
    upcoming: upcoming
      ? { appointment_id: upcoming.id, order_id: upcoming.order_id ?? null, order_uuid: upcoming.order_uuid ?? null, starts_at: _date(upcoming.starts_at) }
      : null,
    // O limite do ciclo atual não impede marcar no próximo: só as travas gerais.
    can_book: check.ok || check.code === "SUBSCRIPTION_LIMIT_REACHED",
    blocked_code: check.ok || check.code === "SUBSCRIPTION_LIMIT_REACHED" ? null : check.code,
    blocked_message: check.ok || check.code === "SUBSCRIPTION_LIMIT_REACHED" ? null : check.message,
  };
};

module.exports = {
  USAGE_STATUSES,
  UPCOMING_STATUSES,
  BOOKABLE_SUBSCRIPTION_STATUSES,
  PAUSE_CANCEL_REASON,
  CLOSE_CANCEL_REASON,
  addCycles,
  cycleAnchor,
  cycleFor,
  countsAsUsage,
  isUpcoming,
  bookableUntil,
  usageInCycle,
  evaluateBooking,
  appointmentsToCancelOnPause,
  paidUntil,
  appointmentsToCancelOnClose,
  bookingSummary,
  formatDay,
};
