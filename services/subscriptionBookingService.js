// Assinaturas (Fase 4): agendamento de serviços usando a assinatura.
//
// O pedido do agendamento tem valor 0 (a receita vem das faturas) e aponta para
// a assinatura em orders.subscription_id — migração "Assinaturas (Fase 4)" em
// DB_CHANGES_NEEDED.md. As regras (limite por ciclo, 1 futuro por vez, pausa)
// ficam em helpers/subscriptionUsage.js; aqui só o acesso ao banco e as travas.

const pool = require("../db");
const { columnExists, tableExists } = require("../helpers/schema");
const usage = require("../helpers/subscriptionUsage");

const _error = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const _positiveId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Schema completo: tabelas da Fase 2 + orders.subscription_id. */
const ready = async () => {
  const checks = await Promise.all([
    tableExists("customer_subscriptions"),
    tableExists("subscription_invoices"),
    tableExists("appointments"),
    columnExists("orders", "subscription_id"),
  ]);
  return checks.every(Boolean);
};

const _requireReady = async () => {
  if (await ready()) return;
  throw _error(503, "O agendamento pela assinatura ainda não está disponível.", "SUBSCRIPTION_BOOKING_UNAVAILABLE");
};

const _invoices = async (db, subscriptionId) =>
  (await db.query(
    "SELECT status, period_start, period_end FROM subscription_invoices WHERE subscription_id = $1",
    [subscriptionId],
  )).rows;

// Agendamentos da assinatura que importam para as regras: os do último ano e
// meio (cobre um ciclo anual) e qualquer um ainda por acontecer.
const _appointments = async (db, subscriptionId, { excludeAppointmentId = null } = {}) =>
  (await db.query(
    `SELECT a.id, a.status, a.starts_at, a.order_id, o.uuid AS order_uuid
       FROM appointments a
       JOIN orders o ON o.id = a.order_id
      WHERE o.subscription_id = $1
        AND ($2::int IS NULL OR a.id <> $2)
        AND a.starts_at > NOW() - INTERVAL '550 days'
      ORDER BY a.starts_at`,
    [subscriptionId, excludeAppointmentId],
  )).rows;

const _timezone = async (db, companyId) => {
  if (!(await columnExists("companies", "timezone"))) return null;
  const r = await db.query("SELECT timezone FROM companies WHERE id = $1", [companyId]);
  return r.rows[0]?.timezone || null;
};

/**
 * Trava a assinatura (FOR UPDATE) e valida o agendamento em `startsAt`. Roda
 * DENTRO da transação do agendamento: dois pedidos simultâneos da mesma
 * assinatura passam um de cada vez pelas regras.
 *
 * `owner`: { userId } (cliente logado) ou { clientId } (IA/loja, já confiável).
 * Retorna { subscription, evaluation }; lança 4xx com `code` quando bloqueia.
 */
const lockAndValidate = async (db, {
  subscriptionId, owner = {}, companyId, serviceId, startsAt, excludeAppointmentId = null, now = new Date(),
}) => {
  await _requireReady();
  const id = _positiveId(subscriptionId);
  if (!id) throw _error(404, "Assinatura não encontrada.", "SUBSCRIPTION_NOT_FOUND");
  const sub = (await db.query("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE", [id])).rows[0];
  const ownerOk = sub && (
    (owner.userId && String(sub.user_id) === String(owner.userId))
    || (owner.clientId && Number(sub.client_id) === Number(owner.clientId))
    || owner.trusted === true
  );
  if (!sub || !ownerOk || Number(sub.company_id) !== Number(companyId)) {
    throw _error(404, "Assinatura não encontrada.", "SUBSCRIPTION_NOT_FOUND");
  }
  if (serviceId != null && Number(sub.menu_item_id) !== Number(serviceId)) {
    throw _error(400, "Esta assinatura é de outro serviço.", "SUBSCRIPTION_OTHER_SERVICE");
  }
  const [appointments, invoices, timezone] = await Promise.all([
    _appointments(db, sub.id, { excludeAppointmentId }),
    _invoices(db, sub.id),
    _timezone(db, sub.company_id),
  ]);
  const evaluation = usage.evaluateBooking({ sub, startsAt, appointments, invoices, now, timezone });
  if (!evaluation.ok) throw Object.assign(_error(409, evaluation.message, evaluation.code), { evaluation });
  return { subscription: sub, evaluation };
};

/**
 * Cliente do agendamento pela assinatura: o informado (se for da loja e da
 * mesma pessoa), o vinculado à assinatura ou o cadastro da pessoa na loja.
 */
const resolveClientId = async (db, { subscriptionId, userId, companyId, clientId = null }) => {
  const sub = (await db.query(
    "SELECT client_id, user_id FROM customer_subscriptions WHERE id = $1 AND company_id = $2",
    [_positiveId(subscriptionId), companyId],
  )).rows[0];
  if (!sub || String(sub.user_id) !== String(userId)) return null;
  const candidates = [_positiveId(clientId), _positiveId(sub.client_id)].filter(Boolean);
  for (const candidate of candidates) {
    const ok = await db.query(
      "SELECT id FROM clients WHERE id = $1 AND company_id = $2 AND user_id = $3 AND deactivated_at IS NULL LIMIT 1",
      [candidate, companyId, userId],
    );
    if (ok.rows[0]) return Number(ok.rows[0].id);
  }
  const fallback = await db.query(
    "SELECT id FROM clients WHERE company_id = $1 AND user_id = $2 AND deactivated_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, userId],
  );
  return fallback.rows[0] ? Number(fallback.rows[0].id) : null;
};

/**
 * IA: assinatura ativa/pausada do serviço para o cliente (pelo cadastro ou pela
 * conta vinculada ao cadastro). null se não houver.
 */
const findForClient = async ({ companyId, serviceId, clientId }) => {
  if (!(await ready())) return null;
  const r = await pool.query(
    `SELECT cs.* FROM customer_subscriptions cs
      WHERE cs.company_id = $1 AND cs.menu_item_id = $2
        AND cs.status = ANY($4::text[])
        AND (cs.client_id = $3 OR cs.user_id IN (
              SELECT c.user_id FROM clients c WHERE c.id = $3 AND c.user_id IS NOT NULL))
      ORDER BY cs.id DESC LIMIT 1`,
    [companyId, serviceId, clientId, usage.BOOKABLE_SUBSCRIPTION_STATUSES],
  );
  return r.rows[0] || null;
};

/** IA: assinaturas de serviço abertas dos cadastros informados (por menu_item_id). */
const listForClients = async (companyId, clientIds) => {
  if (!clientIds.length || !(await ready())) return [];
  const r = await pool.query(
    `SELECT cs.* FROM customer_subscriptions cs
      WHERE cs.company_id = $1 AND cs.status = ANY($3::text[])
        AND (cs.client_id = ANY($2::int[]) OR cs.user_id IN (
              SELECT c.user_id FROM clients c WHERE c.id = ANY($2::int[]) AND c.user_id IS NOT NULL))
      ORDER BY cs.id DESC`,
    [companyId, clientIds, usage.BOOKABLE_SUBSCRIPTION_STATUSES],
  );
  return r.rows;
};

/** Resumo de uso de uma assinatura de serviço (ciclo atual, próximo agendamento). */
const summaryFor = async (sub, { now = new Date() } = {}) => {
  if (!sub || !(await ready())) return null;
  const [appointments, invoices, timezone] = await Promise.all([
    _appointments(pool, sub.id),
    _invoices(pool, sub.id),
    _timezone(pool, sub.company_id),
  ]);
  return usage.bookingSummary({ sub, appointments, invoices, now, timezone });
};

/** Prévia para o checkout: o uso no ciclo da data escolhida e se pode marcar. */
const previewForUser = async (userId, subscriptionId, startsAt) => {
  await _requireReady();
  const id = _positiveId(subscriptionId);
  const sub = id
    ? (await pool.query("SELECT * FROM customer_subscriptions WHERE id = $1 AND user_id = $2", [id, userId])).rows[0]
    : null;
  if (!sub) throw _error(404, "Assinatura não encontrada.", "SUBSCRIPTION_NOT_FOUND");
  const at = new Date(startsAt);
  if (!startsAt || Number.isNaN(at.getTime())) throw _error(400, "Escolha um horário válido.");
  const [appointments, invoices, timezone] = await Promise.all([
    _appointments(pool, sub.id),
    _invoices(pool, sub.id),
    _timezone(pool, sub.company_id),
  ]);
  const e = usage.evaluateBooking({ sub, startsAt: at, appointments, invoices, timezone });
  return {
    allowed: e.ok,
    code: e.code || null,
    message: e.message || null,
    usage_limit: e.limit,
    used_in_cycle: e.used,
    cycle_start: e.cycle?.start || null,
    cycle_end: e.cycle?.end || null,
    bookable_until: e.bookable_until || null,
  };
};

const PAUSE_CANCEL_NOTE = "Assinatura pausada: o pagamento foi recusado e o agendamento foi cancelado.";
const CLOSE_CANCEL_NOTE = "Assinatura encerrada: o agendamento ficou depois do período pago e foi cancelado.";

// Cancela os agendamentos escolhidos por `pick` (etapa 6 do pedido = WhatsApp
// de "agendamento cancelado" ao cliente) e avisa a loja. Best-effort: não lança.
const _cancelUpcoming = async (subscriptionId, { statuses, pick, reason, note, kind, now }) => {
  try {
    if (!(await ready())) return [];
    const sub = (await pool.query("SELECT * FROM customer_subscriptions WHERE id = $1", [subscriptionId])).rows[0];
    if (!sub || !statuses.includes(sub.status)) return [];
    const [appointments, invoices] = await Promise.all([_appointments(pool, sub.id), _invoices(pool, sub.id)]);
    const targets = pick(sub, appointments, invoices, now);
    if (!targets.length) return [];

    const ordersService = require("./ordersService");
    const orderWebhookService = require("./orderWebhookService");
    const cancelled = [];
    for (const appointment of targets) {
      try {
        // O motivo fica no agendamento (syncOrderStatus preserva o já gravado).
        await pool.query(
          `UPDATE appointments SET cancel_reason = $2, updated_at = NOW()
            WHERE id = $1 AND status = ANY($3::text[])`,
          [appointment.id, reason, usage.UPCOMING_STATUSES],
        );
        const order = await ordersService.updateStatus(appointment.order_id, 6, note);
        if (order) cancelled.push(appointment);
      } catch (error) {
        console.error("assinaturas: falha ao cancelar agendamento da assinatura", {
          subscription_id: sub.id, appointment_id: appointment.id, kind, message: error.message,
        });
      }
    }
    if (cancelled.length) {
      orderWebhookService.notifySubscriptionAppointmentsCancelled(sub, cancelled, { reason: kind });
    }
    return cancelled;
  } catch (error) {
    console.error("assinaturas: falha ao cancelar agendamentos da assinatura", { subscription_id: subscriptionId, kind, message: error.message });
    return [];
  }
};

/**
 * Assinatura acabou de PAUSAR: cancela os agendamentos marcados para depois do
 * vencimento (ciclo não pago).
 */
const cancelAfterPause = (subscriptionId, { now = new Date() } = {}) => _cancelUpcoming(subscriptionId, {
  statuses: ["paused"],
  pick: usage.appointmentsToCancelOnPause,
  reason: usage.PAUSE_CANCEL_REASON,
  note: PAUSE_CANCEL_NOTE,
  kind: "paused",
  now,
});

/**
 * Assinatura acabou de ser CANCELADA (cliente, loja, Pagar.me, chargeback) ou
 * ENCERRADA (fim do prazo): cancela os agendamentos depois do último ciclo pago.
 */
const cancelAfterClose = (subscriptionId, { now = new Date() } = {}) => _cancelUpcoming(subscriptionId, {
  statuses: ["canceled", "ended"],
  pick: usage.appointmentsToCancelOnClose,
  reason: usage.CLOSE_CANCEL_REASON,
  note: CLOSE_CANCEL_NOTE,
  kind: "closed",
  now,
});

module.exports = {
  ready,
  lockAndValidate,
  resolveClientId,
  findForClient,
  listForClients,
  summaryFor,
  previewForUser,
  cancelAfterPause,
  cancelAfterClose,
  PAUSE_CANCEL_NOTE,
  CLOSE_CANCEL_NOTE,
};
