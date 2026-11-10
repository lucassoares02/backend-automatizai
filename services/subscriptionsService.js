const pool = require("../db");
const pagarmeService = require("./pagarmeService");
const productOptionsService = require("./productOptionsService");
const { tableExists } = require("../helpers/schema");
const billing = require("../helpers/subscriptionBilling");
const { INTERVALS, subscriptionsReleasedFor } = require("../helpers/subscriptionItem");
const subscriptionBookingService = require("./subscriptionBookingService");
const merchantNotifications = require("./merchantNotificationsService");
const orderWebhookService = require("./orderWebhookService");

// ─── Assinaturas (Fase 2): domínio da cobrança recorrente ─────────────────────
// Tabelas customer_subscriptions / subscription_invoices — migração "Assinaturas
// (Fase 2)" em DB_CHANGES_NEEDED.md. Até ela rodar: contratar responde 503, as
// listagens voltam vazias e os eventos da Pagar.me são ignorados.
//
// Estados: pending (aguardando a 1ª cobrança) → active ⇄ paused → canceled | ended.
// A fatura paga NÃO gera pedido no painel: a loja controla as entregas por fora.

const _httpError = (message, status = 400) => Object.assign(new Error(message), { status });

const _ready = async () =>
  (await tableExists("customer_subscriptions")) && (await tableExists("subscription_invoices"));

const _requireReady = async () => {
  if (await _ready()) return;
  throw _httpError("Assinaturas indisponíveis no momento (atualização pendente).", 503);
};

const _positiveId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const _normalizeRequestId = (value) => {
  const v = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(v)) throw _httpError("Identificador da contratação inválido.");
  return v;
};

// ─── Persistência ─────────────────────────────────────────────────────────────

const _SUB_MUTABLE = [
  "status", "paid_cycles", "current_cycle_start", "current_cycle_end", "paused_at",
  "canceled_at", "canceled_by", "cancel_reason", "ended_at",
];
const _INVOICE_MUTABLE = [
  "status", "failed_attempts", "last_failed_transaction_id", "last_failed_at", "next_retry_at", "paid_at",
];

const _update = async (db, table, row, columns) => {
  const sets = columns.map((c, i) => `${c} = $${i + 2}`);
  await db.query(
    `UPDATE ${table} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    [row.id, ...columns.map((c) => (row[c] === undefined ? null : row[c]))],
  );
};

const _saveSubscription = (db, sub) => _update(db, "customer_subscriptions", sub, _SUB_MUTABLE);
const _saveInvoice = (db, invoice) => _update(db, "subscription_invoices", invoice, _INVOICE_MUTABLE);

const _findInvoice = async (db, { invoiceId, chargeId }, lock = false) => {
  if (!invoiceId && !chargeId) return null;
  const r = await db.query(
    `SELECT * FROM subscription_invoices
     WHERE ($1::text IS NOT NULL AND pagarme_invoice_id = $1)
        OR ($2::text IS NOT NULL AND pagarme_charge_id = $2)
     ORDER BY id LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [invoiceId || null, chargeId || null],
  );
  return r.rows[0] || null;
};

// Cria/atualiza a fatura local a partir das referências do evento. Os dados da
// Pagar.me só preenchem o que ainda está vazio (eventos chegam fora de ordem).
const _upsertInvoice = async (db, subscriptionId, refs) => {
  await db.query(
    `INSERT INTO subscription_invoices
       (subscription_id, pagarme_invoice_id, pagarme_charge_id, cycle, period_start, period_end, amount_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (pagarme_invoice_id) DO UPDATE SET
       pagarme_charge_id = COALESCE(subscription_invoices.pagarme_charge_id, EXCLUDED.pagarme_charge_id),
       cycle = COALESCE(subscription_invoices.cycle, EXCLUDED.cycle),
       period_start = COALESCE(subscription_invoices.period_start, EXCLUDED.period_start),
       period_end = COALESCE(subscription_invoices.period_end, EXCLUDED.period_end),
       amount_cents = COALESCE(subscription_invoices.amount_cents, EXCLUDED.amount_cents),
       updated_at = now()`,
    [
      subscriptionId,
      refs.invoiceId,
      refs.chargeId || null,
      refs.cycle?.number ?? null,
      refs.cycle?.start || null,
      refs.cycle?.end || null,
      refs.amountCents ?? null,
    ],
  );
  return _findInvoice(db, { invoiceId: refs.invoiceId }, true);
};

// ─── Webhook / conciliação ────────────────────────────────────────────────────

/**
 * O evento é de assinatura? Eventos subscription.* e invoice.* sempre; charge.*
 * quando a cobrança aponta para uma fatura/assinatura ou já é conhecida aqui.
 */
const isSubscriptionEvent = async (type, data) => {
  const t = String(type || "");
  if (t.startsWith("subscription.") || t.startsWith("subscription_item.") || t.startsWith("invoice.")) return true;
  if (!t.startsWith("charge.") && t !== "chargeback.received") return false;
  const refs = billing.subscriptionRefsFromPayload(data);
  if (refs.invoiceId || refs.subscriptionId) return true;
  if (!refs.chargeId || !(await _ready())) return false;
  return Boolean(await _findInvoice(pool, { chargeId: refs.chargeId }));
};

const _cancelOnProvider = async (sub) => {
  if (!sub?.pagarme_subscription_id) return;
  try {
    await pagarmeService.cancelSubscription(sub.pagarme_subscription_id);
  } catch (error) {
    console.error("assinaturas: falha ao cancelar na Pagar.me", { subscription_id: sub.id, message: error.message });
  }
};

const _notifyAppointmentsCanceled = async (companyId, subscriptionId, cancelled, why) => {
  if (!cancelled?.length) return;
  const n = cancelled.length;
  await merchantNotifications.notify({
    companyId,
    type: merchantNotifications.TYPES.APPOINTMENTS_CANCELED,
    title: "Agendamentos cancelados",
    message: `${n} agendamento${n === 1 ? " foi" : "s foram"} cancelado${n === 1 ? "" : "s"} automaticamente ${why}.`,
    subscriptionId,
    eventKey: `subscription:${subscriptionId}:appointments-canceled:${cancelled.map((a) => a.id).sort().join(",")}`,
  });
};

/**
 * Aplica um evento da Pagar.me na assinatura. Idempotente: fatura paga conta
 * uma vez, recusa conta uma vez por transação. `fromReconciliation` evita
 * recontar recusa sem id de transação vista de novo pela conciliação.
 */
const handleProviderEvent = async (type, data, { fromReconciliation = false } = {}) => {
  if (!(await _ready())) return { skipped: true };
  const refs = billing.subscriptionRefsFromPayload(data);
  const outcome = billing.classifySubscriptionEvent(type, refs);
  if (outcome === "ignore") return { skipped: true };

  const db = await pool.connect();
  let cancelProvider = null;
  let pausedNow = null;
  let pausedSubscription = null;
  let changedSubscriptionId = null;
  let closedNow = null;
  let closedCompanyId = null;
  let notification = null;
  let customerNotification = null;
  let result = { applied: false };
  try {
    await db.query("BEGIN");
    const known = await _findInvoice(db, refs);
    let sub = null;
    if (known) {
      sub = (await db.query("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE", [known.subscription_id])).rows[0];
    } else if (refs.subscriptionId) {
      sub = (await db.query(
        "SELECT * FROM customer_subscriptions WHERE pagarme_subscription_id = $1 FOR UPDATE",
        [refs.subscriptionId],
      )).rows[0];
    }
    let orphan = false;
    if (!sub && refs.subscriptionId) {
      // Contratação com erro/timeout (ou webhook antes de gravar o id): acha a
      // linha local pela metadata e vincula o id da Pagar.me.
      const localId = billing.localSubscriptionIdFromPayload(data);
      const row = localId
        ? (await db.query(
          "SELECT * FROM customer_subscriptions WHERE id = $1 AND pagarme_subscription_id IS NULL FOR UPDATE",
          [localId],
        )).rows[0]
        : null;
      if (row) {
        await db.query(
          "UPDATE customer_subscriptions SET pagarme_subscription_id = $2, updated_at = now() WHERE id = $1",
          [row.id, refs.subscriptionId],
        );
        sub = { ...row, pagarme_subscription_id: refs.subscriptionId };
        // Já fechada localmente: o cliente viu erro na contratação. Para de cobrar.
        orphan = billing.FINAL_STATUSES.includes(row.status);
        console.warn("assinaturas: assinatura da Pagar.me vinculada pela metadata", {
          subscription_id: row.id, pagarme_subscription_id: refs.subscriptionId, status: row.status,
        });
      }
    }
    if (!sub) {
      await db.query("COMMIT");
      if (refs.subscriptionId || refs.invoiceId) {
        console.warn("assinaturas: evento sem assinatura local", { type, subscription: refs.subscriptionId, invoice: refs.invoiceId });
      }
      return { skipped: true };
    }

    let invoice = refs.invoiceId ? await _upsertInvoice(db, sub.id, refs) : (known ? await _findInvoice(db, refs, true) : null);

    let transition = null;
    switch (outcome) {
    case "paid": {
      if (!invoice) break;
      const others = await db.query(
        "SELECT COUNT(*)::int AS n FROM subscription_invoices WHERE subscription_id = $1 AND id <> $2 AND status = 'failed'",
        [sub.id, invoice.id],
      );
      transition = billing.applyInvoicePaid(sub, invoice, { otherFailedInvoices: others.rows[0].n });
      break;
    }
    case "failed": {
      if (!invoice) break;
      if (fromReconciliation && !refs.transactionId && Number(invoice.failed_attempts) > 0) break;
      transition = billing.applyPaymentFailed(sub, invoice, { transactionId: refs.transactionId });
      break;
    }
    case "chargeback":
      transition = billing.applyChargeback(sub, invoice);
      break;
    case "refunded":
      if (invoice && invoice.status !== "refunded") {
        transition = { changed: true, subscription: sub, invoice: { ...invoice, status: "refunded", next_retry_at: null } };
      }
      break;
    case "invoice_canceled":
      if (invoice && !["paid", "refunded", "chargedback", "canceled"].includes(invoice.status)) {
        transition = { changed: true, subscription: sub, invoice: { ...invoice, status: "canceled", next_retry_at: null } };
      }
      break;
    case "provider_canceled":
      transition = billing.applyCancel(sub, { by: "provider", reason: "provider_canceled" });
      break;
    case "sync":
      if (type.startsWith("subscription.") && (refs.cycle.start || refs.cycle.end) && !billing.FINAL_STATUSES.includes(sub.status)) {
        transition = {
          changed: true,
          subscription: {
            ...sub,
            current_cycle_start: refs.cycle.start || sub.current_cycle_start,
            current_cycle_end: refs.cycle.end || sub.current_cycle_end,
          },
        };
      }
      break;
    default:
      break;
    }

    if (transition?.changed) {
      changedSubscriptionId = sub.id;
      await _saveSubscription(db, transition.subscription);
      if (transition.invoice && invoice) await _saveInvoice(db, transition.invoice);
      if (transition.cancelProvider) cancelProvider = transition.subscription;
      if (sub.status !== "paused" && transition.subscription.status === "paused") {
        pausedNow = sub.id;
        pausedSubscription = transition.subscription;
      }
      if (billing.OPEN_STATUSES.includes(sub.status) && billing.FINAL_STATUSES.includes(transition.subscription.status)) {
        closedNow = sub.id;
        closedCompanyId = sub.company_id;
      }
      const notices = billing.transitionNotices({
        before: sub, after: transition.subscription, outcome, invoice: transition.invoice || invoice,
      });
      if (notices.merchant) {
        const { kind, ...rest } = notices.merchant;
        notification = { ...rest, companyId: sub.company_id, subscriptionId: sub.id, type: merchantNotifications.TYPES[kind] };
      }
      customerNotification = notices.customer;
      result = { applied: true, outcome, status: transition.subscription.status };
    }
    if (orphan) {
      cancelProvider = sub;
      if (outcome === "paid") {
        console.error("assinaturas: cobrança paga de assinatura fechada na contratação — conferir estorno", {
          subscription_id: sub.id, invoice: refs.invoiceId, charge: refs.chargeId,
        });
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
  // Fim do prazo, recusa da 1ª cobrança, chargeback ou assinatura órfã: para de cobrar na Pagar.me.
  if (cancelProvider) await _cancelOnProvider(cancelProvider);
  if (notification) await merchantNotifications.notify(notification);
  // Pausou agora: agendamentos do ciclo não pago são cancelados (Fase 4).
  if (pausedNow) {
    const cancelled = await subscriptionBookingService.cancelAfterPause(pausedNow);
    if (pausedSubscription) {
      const itemName = pausedSubscription.items?.[0]?.name;
      await merchantNotifications.notify({
        companyId: pausedSubscription.company_id,
        type: merchantNotifications.TYPES.PAUSED,
        title: "Assinatura pausada",
        message: `A assinatura${itemName ? ` de ${itemName}` : ""} foi pausada após cobranças recusadas.`,
        subscriptionId: pausedNow,
        eventKey: `subscription:${pausedNow}:paused`,
      });
      await orderWebhookService.notifySubscriptionCustomer(pausedNow, "paused", {
        cancelledAppointments: cancelled.length,
      });
      await _notifyAppointmentsCanceled(pausedSubscription.company_id, pausedNow, cancelled, "pela pausa da assinatura");
    }
  }
  // Cancelou/encerrou agora: agendamentos depois do último ciclo pago caem.
  let closedCancelled = [];
  if (closedNow) {
    closedCancelled = await subscriptionBookingService.cancelAfterClose(closedNow);
    await _notifyAppointmentsCanceled(closedCompanyId, closedNow, closedCancelled, "pelo encerramento da assinatura");
  }
  if (customerNotification) {
    await orderWebhookService.notifySubscriptionCustomer(
      changedSubscriptionId,
      customerNotification.id,
      { ...customerNotification.details, cancelledAppointments: closedCancelled.length },
    );
  }
  return result;
};

// Evento sintético a partir de uma fatura/cobrança lida na API (conciliação).
const _eventTypeForStatus = (status, prefix) => {
  const outcome = billing.statusOutcome(status);
  if (outcome === "paid") return `${prefix}.paid`;
  if (outcome === "failed") return `${prefix}.payment_failed`;
  if (outcome === "chargeback") return "charge.chargedback";
  if (outcome === "refunded") return "charge.refunded";
  if (outcome === "invoice_canceled") return prefix === "invoice" ? "invoice.canceled" : null;
  return prefix === "invoice" ? "invoice.created" : null;
};

// Resultado síncrono de uma recobrança: aplica sem esperar o webhook.
const _applyChargeResult = async (invoiceRow, charge) => {
  const type = _eventTypeForStatus(charge?.status, "charge");
  if (!type) return null;
  return handleProviderEvent(type, {
    ...charge,
    id: charge?.id || invoiceRow.pagarme_charge_id,
    invoice: { id: invoiceRow.pagarme_invoice_id },
  });
};

/** Confere uma assinatura na Pagar.me (faturas + status) e corrige o local. */
const reconcileSubscription = async (sub) => {
  if (!sub?.pagarme_subscription_id) return { checked: false };
  const invoices = await pagarmeService.listSubscriptionInvoices(sub.pagarme_subscription_id);
  const ordered = [...invoices].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  for (const inv of ordered) {
    const payload = { ...inv, subscription: inv.subscription || { id: sub.pagarme_subscription_id } };
    const status = inv.charge?.status && inv.status === "pending" ? inv.charge.status : inv.status;
    const type = _eventTypeForStatus(status, "invoice");
    if (type) await handleProviderEvent(type, payload, { fromReconciliation: true });
  }
  const provider = await pagarmeService.getSubscription(sub.pagarme_subscription_id);
  if (String(provider?.status || "").toLowerCase() === "canceled") {
    await handleProviderEvent("subscription.canceled", provider, { fromReconciliation: true });
  } else if (provider?.id) {
    await handleProviderEvent("subscription.updated", provider, { fromReconciliation: true });
  }
  await pool.query("UPDATE customer_subscriptions SET last_reconciled_at = now() WHERE id = $1", [sub.id]);
  return { checked: true };
};

const reconcileOpenSubscriptions = async ({ limit = 30 } = {}) => {
  if (!(await _ready()) || !process.env.PAGARME_SECRET_KEY) return { checked: 0, skipped: true };
  const r = await pool.query(
    `SELECT * FROM customer_subscriptions
     WHERE status IN ('pending', 'active', 'paused') AND pagarme_subscription_id IS NOT NULL
       AND (last_reconciled_at IS NULL OR last_reconciled_at < now() - INTERVAL '15 minutes')
     ORDER BY last_reconciled_at NULLS FIRST
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 30, 1), 200)],
  );
  let checked = 0;
  for (const sub of r.rows) {
    try {
      await reconcileSubscription(sub);
      checked += 1;
    } catch (error) {
      console.error("assinaturas: falha na conciliação", { subscription_id: sub.id, message: error.message });
    }
  }
  return { checked, skipped: false };
};

/** Retentativas agendadas (1ª recusa e 2ª recusa) de assinaturas ativas. */
const processDueRetries = async ({ limit = 30 } = {}) => {
  if (!(await _ready()) || !process.env.PAGARME_SECRET_KEY) return { retried: 0, skipped: true };
  const due = await pool.query(
    `SELECT si.* FROM subscription_invoices si
     JOIN customer_subscriptions cs ON cs.id = si.subscription_id
     WHERE si.next_retry_at <= now() AND si.status = 'failed'
       AND si.pagarme_charge_id IS NOT NULL AND cs.status = 'active'
     ORDER BY si.next_retry_at
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 30, 1), 200)],
  );
  let retried = 0;
  for (const invoice of due.rows) {
    // Reserva a retentativa (outra instância pode ter pego a mesma fatura).
    const claimed = await pool.query(
      "UPDATE subscription_invoices SET next_retry_at = NULL, updated_at = now() WHERE id = $1 AND next_retry_at = $2 RETURNING id",
      [invoice.id, invoice.next_retry_at],
    );
    if (!claimed.rows[0]) continue;
    try {
      const charge = await pagarmeService.retryCharge(invoice.pagarme_charge_id);
      await _applyChargeResult(invoice, charge);
      retried += 1;
    } catch (error) {
      // Falha de comunicação não conta como tentativa: tenta de novo em 1h.
      await pool.query(
        "UPDATE subscription_invoices SET next_retry_at = now() + INTERVAL '1 hour' WHERE id = $1 AND next_retry_at IS NULL AND status = 'failed'",
        [invoice.id],
      );
      console.error("assinaturas: falha na retentativa", { invoice_id: invoice.id, message: error.message });
    }
  }
  return { retried, skipped: false };
};

// ─── Leitura ──────────────────────────────────────────────────────────────────

const _SELECT_SUBSCRIPTION = `
  SELECT cs.id, cs.company_id, cs.menu_item_id, cs.user_id, cs.client_id, cs.status, cs.interval,
         cs.duration_cycles, cs.usage_limit, cs.amount_cents, cs.items, cs.options,
         cs.platform_split_percent, cs.current_cycle_start, cs.current_cycle_end, cs.paid_cycles,
         cs.paused_at, cs.canceled_at, cs.canceled_by, cs.cancel_reason, cs.ended_at, cs.created_at,
         mi.name AS item_name, mi.item_type, co.name AS company_name,
         pu.name AS customer_name,
         CASE WHEN latest_invoice.status = 'failed' THEN COALESCE(latest_invoice.failed_attempts, 0) ELSE 0 END
           AS latest_failed_attempts,
         upt.id AS payment_method_id, upt.brand AS card_brand, upt.last4 AS card_last4
    FROM customer_subscriptions cs
    LEFT JOIN menu_items mi ON mi.id = cs.menu_item_id
    LEFT JOIN companies co ON co.id = cs.company_id
    LEFT JOIN platform_users pu ON pu.id = cs.user_id
    LEFT JOIN LATERAL (
      SELECT failed_attempts, status FROM subscription_invoices
       WHERE subscription_id = cs.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) latest_invoice ON true
    LEFT JOIN user_payment_tokens upt ON upt.id = cs.payment_token_id`;

const _publicSubscription = (row, invoices = null) => {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    company_id: row.company_id,
    company_name: row.company_name || null,
    menu_item_id: row.menu_item_id,
    item_name: row.item_name || null,
    item_type: row.item_type || null,
    status: row.status,
    interval: row.interval,
    duration_cycles: row.duration_cycles,
    usage_limit: row.usage_limit,
    amount: Number(row.amount_cents) / 100,
    options: row.options || [],
    paid_cycles: row.paid_cycles,
    current_cycle_start: row.current_cycle_start,
    current_cycle_end: row.current_cycle_end,
    paused_at: row.paused_at,
    canceled_at: row.canceled_at,
    canceled_by: row.canceled_by,
    cancel_reason: row.cancel_reason,
    ended_at: row.ended_at,
    created_at: row.created_at,
    failed_attempts: Number(row.latest_failed_attempts) || 0,
    card: row.payment_method_id
      ? { payment_method_id: Number(row.payment_method_id), brand: row.card_brand, last4: row.card_last4 }
      : null,
  };
  if (invoices) out.invoices = invoices;
  return out;
};

const _invoicesFor = async (subscriptionId) => {
  const r = await pool.query(
    `SELECT id, cycle, period_start, period_end, amount_cents, status, failed_attempts, next_retry_at, paid_at, created_at
       FROM subscription_invoices WHERE subscription_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 60`,
    [subscriptionId],
  );
  return r.rows.map((i) => ({
    id: Number(i.id),
    cycle: i.cycle,
    period_start: i.period_start,
    period_end: i.period_end,
    amount: i.amount_cents == null ? null : Number(i.amount_cents) / 100,
    status: i.status,
    failed_attempts: i.failed_attempts,
    next_retry_at: i.next_retry_at,
    paid_at: i.paid_at,
    created_at: i.created_at,
  }));
};

const _ownedSubscription = async (userId, subscriptionId) => {
  const id = _positiveId(subscriptionId);
  if (!id) throw _httpError("Assinatura não encontrada.", 404);
  const r = await pool.query("SELECT * FROM customer_subscriptions WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!r.rows[0]) throw _httpError("Assinatura não encontrada.", 404);
  return r.rows[0];
};

// Serviço por assinatura: uso no ciclo atual e próximo agendamento (Fase 4).
const _withBooking = async (row, out) => {
  if (!out || row.item_type !== "service" || !["active", "paused"].includes(row.status)) return out;
  try {
    const booking = await subscriptionBookingService.summaryFor(row);
    if (booking) out.booking = booking;
  } catch (error) {
    console.error("assinaturas: falha ao calcular o uso do ciclo", { subscription_id: row.id, message: error.message });
  }
  return out;
};

const listForUser = async (userId) => {
  if (!(await _ready())) return [];
  const r = await pool.query(`${_SELECT_SUBSCRIPTION} WHERE cs.user_id = $1 ORDER BY cs.created_at DESC LIMIT 100`, [userId]);
  return Promise.all(r.rows.map((row) => _withBooking(row, _publicSubscription(row))));
};

/**
 * "Minhas assinaturas": lista + o necessário para cadastrar cartão fora de uma
 * loja (troca de cartão). A chave pública (pk_...) não é segredo.
 */
const listForUserWithContext = async (userId) => {
  const savingAvailable = pagarmeService.savedCardsAvailable();
  return {
    subscriptions: await listForUser(userId),
    saving_available: savingAvailable,
    public_key: savingAvailable ? (process.env.PAGARME_PUBLIC_KEY || null) : null,
  };
};

const getForUser = async (userId, subscriptionId) => {
  await _requireReady();
  const owned = await _ownedSubscription(userId, subscriptionId);
  const r = await pool.query(`${_SELECT_SUBSCRIPTION} WHERE cs.id = $1`, [owned.id]);
  return _withBooking(r.rows[0], _publicSubscription(r.rows[0], await _invoicesFor(owned.id)));
};

const listForCompany = async (companyId, { status } = {}) => {
  if (!(await _ready())) return [];
  const statuses = String(status || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => [...billing.OPEN_STATUSES, ...billing.FINAL_STATUSES].includes(s));
  const r = await pool.query(
    `${_SELECT_SUBSCRIPTION}
     WHERE cs.company_id = $1 AND (cardinality($2::text[]) = 0 OR cs.status = ANY($2::text[]))
     ORDER BY cs.created_at DESC LIMIT 500`,
    [Number(companyId), statuses],
  );
  return r.rows.map((row) => _publicSubscription(row));
};

// ─── Ações ────────────────────────────────────────────────────────────────────

// Cartão da assinatura: um salvo (payment_method_id) ou um novo (card_token),
// que é cadastrado no cofre antes. O card_id nunca sai da API.
const _resolveCard = async (userId, input) => {
  const savedId = _positiveId(input?.paymentMethodId);
  if (savedId) return pagarmeService.resolveSavedCardForUser(userId, savedId);
  const cardToken = String(input?.cardToken || "").trim();
  if (!cardToken) throw _httpError("Escolha ou cadastre um cartão de crédito.");
  const saved = await pagarmeService.saveCardForUser(userId, cardToken, {
    document: input.document,
    email: input.email,
    billingAddress: input.billingAddress,
  });
  return pagarmeService.resolveSavedCardForUser(userId, saved.id);
};

const OPEN_ITEM_UNIQUE_INDEX = "customer_subscriptions_open_item_uidx";

// Recusa definitiva da Pagar.me (4xx): não adianta repetir. Sem status (rede,
// timeout) ou 5xx (_wrap vira 502): a assinatura pode ter sido criada.
const _isDefinitiveProviderError = (error) => {
  const status = Number(error?.status);
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
};

// `onlyUnlinked`: só fecha se o webhook ainda não vinculou o id da Pagar.me.
const _closeLocally = async (subId, { by, reason, onlyUnlinked = false }) => {
  const r = await pool.query(
    `UPDATE customer_subscriptions
     SET status = 'canceled', canceled_at = now(), canceled_by = $2, cancel_reason = $3, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'active', 'paused')
       AND ($4::boolean = false OR pagarme_subscription_id IS NULL)`,
    [subId, by, reason, onlyUnlinked],
  );
  return r.rowCount > 0;
};

/**
 * Contrata a assinatura de um item (cliente logado e verificado). Idempotente
 * por `clientRequestId`. Bloqueia se o recebedor da loja não estiver ativo.
 */
const subscribe = async (userId, input = {}) => {
  await _requireReady();
  if (!userId) throw _httpError("Entre na sua conta para assinar.", 401);
  const clientRequestId = _normalizeRequestId(input.clientRequestId);
  const menuItemId = _positiveId(input.menuItemId);
  if (!menuItemId) throw _httpError("Assinatura não encontrada.", 404);

  const previous = await pool.query(
    "SELECT id FROM customer_subscriptions WHERE user_id = $1 AND client_request_id = $2",
    [userId, clientRequestId],
  );
  if (previous.rows[0]) return getForUser(userId, previous.rows[0].id);

  const itemResult = await pool.query(
    `SELECT id, company_id, name, description, price, item_type, subscription_interval,
            subscription_duration_cycles, subscription_usage_limit
       FROM menu_items
      WHERE id = $1 AND available = true AND deleted_at IS NULL AND subscription_enabled = true`,
    [menuItemId],
  );
  const item = itemResult.rows[0];
  if (!item || !INTERVALS.includes(item.subscription_interval)) throw _httpError("Assinatura não encontrada.", 404);
  // Mesma regra da vitrine: sem liberação (geral ou da loja), não contrata.
  if (!subscriptionsReleasedFor(item.company_id)) throw _httpError("Assinatura não encontrada.", 404);

  const company = await pagarmeService.assertCompanyRecipientActive(item.company_id);
  const split = billing.buildSubscriptionSplit({
    merchantRecipientId: company.pagarme_recipient_id,
    platformRecipientId: pagarmeService.platformRecipientId(),
  });

  let snapshot;
  try {
    ({ snapshot } = await productOptionsService.validateSelections(item.id, input.options));
  } catch (error) {
    throw _httpError(error.message || "Opções inválidas.", 400);
  }
  const { items, amountCents } = billing.buildSubscriptionItems({ item, options: snapshot });

  const duplicate = await pool.query(
    `SELECT 1 FROM customer_subscriptions
     WHERE user_id = $1 AND menu_item_id = $2 AND status IN ('pending', 'active', 'paused') LIMIT 1`,
    [userId, item.id],
  );
  if (duplicate.rows[0]) throw _httpError("Você já tem esta assinatura.", 409);

  const card = await _resolveCard(userId, input);
  const customerId = await pagarmeService.getUserPagarmeCustomerId(userId);
  if (!customerId) throw _httpError("Cadastre o cartão novamente para assinar.", 409);

  const client = await pool.query(
    `SELECT id FROM clients WHERE user_id = $1 AND company_id = $2 AND deactivated_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [userId, item.company_id],
  ).catch(() => ({ rows: [] }));

  const inserted = await pool.query(
    `INSERT INTO customer_subscriptions (
       company_id, menu_item_id, user_id, client_id, payment_token_id, client_request_id,
       pagarme_customer_id, pagarme_card_id, status, interval, duration_cycles, usage_limit,
       amount_cents, items, options, merchant_split_percent, platform_split_percent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16)
     ON CONFLICT (user_id, client_request_id) DO NOTHING
     RETURNING *`,
    [
      item.company_id, item.id, userId, client.rows[0]?.id || null, card.id, clientRequestId,
      customerId, card.card_id, item.subscription_interval, item.subscription_duration_cycles,
      item.item_type === "service" ? item.subscription_usage_limit : null,
      amountCents, JSON.stringify(items), JSON.stringify(snapshot),
      split.merchantPercent, split.platformPercent,
    ],
  ).catch((error) => {
    // Índice único de assinatura aberta por pessoa + item (corrida entre duas contratações).
    if (error?.code === "23505" && error.constraint === OPEN_ITEM_UNIQUE_INDEX) {
      throw _httpError("Você já tem esta assinatura.", 409);
    }
    throw error;
  });
  const row = inserted.rows[0];
  if (!row) {
    const again = await pool.query(
      "SELECT id FROM customer_subscriptions WHERE user_id = $1 AND client_request_id = $2",
      [userId, clientRequestId],
    );
    return getForUser(userId, again.rows[0].id);
  }

  const providerBody = {
    customer_id: customerId,
    card_id: card.card_id,
    payment_method: "credit_card",
    currency: "BRL",
    interval: item.subscription_interval,
    interval_count: 1,
    billing_type: "prepaid",
    installments: 1,
    statement_descriptor: company.statementDescriptor,
    items,
    split: split.split,
    metadata: {
      arbian_subscription_id: String(row.id),
      company_id: String(item.company_id),
      menu_item_id: String(item.id),
    },
  };
  const idempotencyKey = `automatizai:subscription:${row.id}`;
  let provider;
  try {
    provider = await pagarmeService.createSubscription(providerBody, idempotencyKey);
  } catch (error) {
    // Timeout/erro do servidor: a Pagar.me pode ter criado a assinatura. A mesma
    // chave de idempotência devolve a já criada (ou cria agora, uma vez só).
    let retryError = error;
    if (!_isDefinitiveProviderError(error)) {
      try {
        provider = await pagarmeService.createSubscription(providerBody, idempotencyKey);
        retryError = null;
      } catch (again) {
        retryError = again;
      }
    }
    if (retryError) {
      // Se mesmo assim ela existir lá, o webhook acha a linha pela metadata e
      // cancela. Se o webhook já chegou e vinculou, a assinatura existe: segue.
      const closed = await _closeLocally(row.id, { by: "system", reason: "provider_error", onlyUnlinked: true });
      if (!closed) {
        const linked = await pool.query("SELECT pagarme_subscription_id FROM customer_subscriptions WHERE id = $1", [row.id]);
        if (linked.rows[0]?.pagarme_subscription_id) return getForUser(userId, row.id);
      }
      throw retryError;
    }
  }

  await pool.query(
    `UPDATE customer_subscriptions
     SET pagarme_subscription_id = $2, current_cycle_start = $3, current_cycle_end = $4, updated_at = now()
     WHERE id = $1`,
    [row.id, provider.id || null, provider.current_cycle?.start_at || null, provider.current_cycle?.end_at || null],
  );

  if (String(provider.status || "").toLowerCase() === "canceled") {
    await _closeLocally(row.id, { by: "system", reason: "first_payment_failed" });
  } else if (provider.id) {
    // A 1ª fatura costuma sair na hora: já traz o status sem esperar o webhook.
    try {
      await reconcileSubscription({ ...row, pagarme_subscription_id: provider.id });
    } catch (error) {
      console.error("assinaturas: conciliação após contratar falhou", { subscription_id: row.id, message: error.message });
    }
  }
  return getForUser(userId, row.id);
};

/**
 * Troca o cartão da assinatura e, se houver fatura recusada, cobra na hora. A
 * assinatura pausada volta a ativa quando a cobrança é confirmada.
 */
const changeCard = async (userId, subscriptionId, input = {}) => {
  await _requireReady();
  const sub = await _ownedSubscription(userId, subscriptionId);
  if (!["active", "paused"].includes(sub.status) || !sub.pagarme_subscription_id) {
    throw _httpError("Esta assinatura não aceita troca de cartão.", 409);
  }
  const card = await _resolveCard(userId, input);
  await pagarmeService.updateSubscriptionCard(sub.pagarme_subscription_id, card.card_id);
  await pool.query(
    "UPDATE customer_subscriptions SET payment_token_id = $2, pagarme_card_id = $3, updated_at = now() WHERE id = $1",
    [sub.id, card.id, card.card_id],
  );

  const pending = await pool.query(
    `SELECT * FROM subscription_invoices
     WHERE subscription_id = $1 AND status = 'failed' AND pagarme_charge_id IS NOT NULL
     ORDER BY created_at, id`,
    [sub.id],
  );
  let retryError = null;
  for (const invoice of pending.rows) {
    // Reserva a fatura (a rotina de retentativas pode estar cobrando a mesma).
    const claimed = await pool.query(
      `UPDATE subscription_invoices SET next_retry_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'failed' AND next_retry_at IS NOT DISTINCT FROM $2 RETURNING id`,
      [invoice.id, invoice.next_retry_at],
    );
    if (!claimed.rows[0]) continue;
    let charge;
    try {
      charge = await pagarmeService.retryCharge(invoice.pagarme_charge_id);
    } catch (error) {
      retryError = error;
      // Falha de comunicação não conta como tentativa: devolve a fatura para a
      // fila (o horário que tinha ou daqui a 1h), senão a assinatura ativa nunca
      // mais recobra nem pausa.
      await pool.query(
        `UPDATE subscription_invoices
         SET next_retry_at = COALESCE($2::timestamptz, CASE WHEN $3 THEN now() + INTERVAL '1 hour' END), updated_at = now()
         WHERE id = $1 AND next_retry_at IS NULL AND status = 'failed'`,
        [invoice.id, invoice.next_retry_at, sub.status === "active"],
      ).catch((restoreError) => {
        console.error("assinaturas: falha ao devolver fatura à fila", { invoice_id: invoice.id, message: restoreError.message });
      });
      console.error("assinaturas: falha ao cobrar fatura pendente", { invoice_id: invoice.id, message: error.message });
      continue;
    }
    try {
      await _applyChargeResult(invoice, charge);
    } catch (error) {
      // A cobrança foi feita: o webhook/conciliação aplicam o resultado depois.
      retryError = error;
      console.error("assinaturas: falha ao aplicar a recobrança", { invoice_id: invoice.id, message: error.message });
    }
  }
  const result = await getForUser(userId, sub.id);
  if (retryError) result.retry_error = retryError.message;
  return result;
};

/**
 * Cancela com a linha travada (FOR UPDATE) durante a chamada à Pagar.me: o
 * webhook subscription.canceled que ela dispara espera o commit, vê a
 * assinatura já cancelada e não regrava canceled_by nem avisa de novo. Se a
 * Pagar.me falhar, nada muda aqui (o cliente pode tentar de novo).
 */
const _cancel = async (subscriptionId, { by, reason }) => {
  const db = await pool.connect();
  let sub;
  try {
    await db.query("BEGIN");
    sub = (await db.query("SELECT * FROM customer_subscriptions WHERE id = $1 FOR UPDATE", [subscriptionId])).rows[0];
    if (!sub || !billing.OPEN_STATUSES.includes(sub.status)) throw _httpError("Esta assinatura já foi encerrada.", 409);
    if (sub.pagarme_subscription_id) await pagarmeService.cancelSubscription(sub.pagarme_subscription_id);
    await db.query(
      `UPDATE customer_subscriptions
       SET status = 'canceled', canceled_at = now(), canceled_by = $2, cancel_reason = $3, updated_at = now()
       WHERE id = $1`,
      [sub.id, by, reason],
    );
    await db.query(
      `UPDATE subscription_invoices SET next_retry_at = NULL, updated_at = now()
       WHERE subscription_id = $1 AND next_retry_at IS NOT NULL`,
      [sub.id],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
  // Agendamentos depois do último ciclo pago caem junto.
  const cancelled = await subscriptionBookingService.cancelAfterClose(sub.id);
  await _notifyAppointmentsCanceled(sub.company_id, sub.id, cancelled, "pelo cancelamento da assinatura");
  return { sub, cancelled };
};

const cancelByCustomer = async (userId, subscriptionId, { reason } = {}) => {
  await _requireReady();
  const owned = await _ownedSubscription(userId, subscriptionId);
  const { sub, cancelled } = await _cancel(owned.id, {
    by: "customer", reason: String(reason || "customer_request").slice(0, 40),
  });
  await merchantNotifications.notify({
    companyId: sub.company_id,
    type: merchantNotifications.TYPES.CANCELED,
    title: "Assinatura cancelada",
    message: `Uma assinatura foi cancelada pelo cliente.`,
    subscriptionId: sub.id,
    eventKey: `subscription:${sub.id}:canceled`,
  });
  await orderWebhookService.notifySubscriptionCustomer(sub.id, "canceled", {
    canceledBy: "customer", cancelledAppointments: cancelled.length,
  });
  return getForUser(userId, sub.id);
};

const cancelByMerchant = async (companyId, subscriptionId, { reason } = {}) => {
  await _requireReady();
  const id = _positiveId(subscriptionId);
  const r = await pool.query("SELECT id FROM customer_subscriptions WHERE id = $1 AND company_id = $2", [id, Number(companyId)]);
  if (!r.rows[0]) throw _httpError("Assinatura não encontrada.", 404);
  const { sub, cancelled } = await _cancel(r.rows[0].id, {
    by: "merchant", reason: String(reason || "merchant_request").slice(0, 40),
  });
  await merchantNotifications.notify({
    companyId: sub.company_id,
    type: merchantNotifications.TYPES.CANCELED,
    title: "Assinatura cancelada",
    message: `A assinatura do cliente foi cancelada pela loja.`,
    subscriptionId: sub.id,
    eventKey: `subscription:${sub.id}:canceled`,
  });
  await orderWebhookService.notifySubscriptionCustomer(sub.id, "canceled", {
    canceledBy: "merchant", cancelledAppointments: cancelled.length,
  });
  const out = await pool.query(`${_SELECT_SUBSCRIPTION} WHERE cs.id = $1`, [sub.id]);
  return _publicSubscription(out.rows[0], await _invoicesFor(sub.id));
};

const getForCompany = async (companyId, subscriptionId) => {
  await _requireReady();
  const id = _positiveId(subscriptionId);
  const r = await pool.query(`${_SELECT_SUBSCRIPTION} WHERE cs.id = $1 AND cs.company_id = $2`, [id, Number(companyId)]);
  if (!r.rows[0]) throw _httpError("Assinatura não encontrada.", 404);
  return _publicSubscription(r.rows[0], await _invoicesFor(id));
};

module.exports = {
  isSubscriptionEvent,
  handleProviderEvent,
  reconcileSubscription,
  reconcileOpenSubscriptions,
  processDueRetries,
  listForUser,
  listForUserWithContext,
  getForUser,
  subscribe,
  changeCard,
  cancelByCustomer,
  listForCompany,
  getForCompany,
  cancelByMerchant,
};
