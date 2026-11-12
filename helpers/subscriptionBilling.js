// Assinaturas (Fase 2): regras puras da cobrança recorrente na Pagar.me — split
// percentual, itens da assinatura, leitura dos webhooks e máquina de estados.
// Sem banco e sem HTTP, para ficar testável (api/tests/subscriptionBilling.test.js).
//
// Decisões do negócio:
// - só cartão de crédito, à vista; split 98% loja / 2% Arbian, sem taxa fixa;
// - recusa: 1 tentativa + 2 retentativas; esgotadas, a assinatura fica PAUSADA
//   (estado nosso: a Pagar.me só tem active/canceled/future);
// - prazo (N cobranças) e pausa são controlados do nosso lado: a doc pública não
//   confirma fim automático por ciclos nem cancelamento após retentativas;
// - chargeback cancela a assinatura;
// - fatura paga NÃO gera pedido no painel (a loja controla as entregas por fora).

const MAX_RETRIES = 2;
const MAX_ATTEMPTS = 1 + MAX_RETRIES;
// Dois eventos da mesma recusa (charge.payment_failed + invoice.payment_failed)
// sem id de transação contam uma vez só dentro desta janela.
const FAILURE_DEDUP_WINDOW_MS = 10 * 60 * 1000;

const OPEN_STATUSES = ["pending", "active", "paused"];
const FINAL_STATUSES = ["canceled", "ended"];

const _int = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
};

const platformFeePercent = () => {
  const n = _int(process.env.SUBSCRIPTION_PLATFORM_FEE_PERCENT, 2);
  return n >= 1 && n <= 99 ? n : 2;
};

const retryIntervalHours = () => {
  const n = Number(process.env.SUBSCRIPTION_RETRY_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
};

/**
 * Split da recorrência: objeto `{enabled, rules}`, só `percentage` e inteiro.
 * A loja responde por chargeback, taxas e resto (como no pedido avulso).
 */
const buildSubscriptionSplit = ({ merchantRecipientId, platformRecipientId, platformPercent = platformFeePercent() }) => {
  if (!merchantRecipientId) {
    throw Object.assign(new Error("Este estabelecimento ainda não habilitou pagamentos online."), { status: 409 });
  }
  if (!platformRecipientId) {
    throw Object.assign(new Error("Pagamentos de assinatura indisponíveis (recebedor da plataforma não configurado)."), { status: 503 });
  }
  const platform = _int(platformPercent, NaN);
  if (!Number.isInteger(platform) || platform < 1 || platform > 99) {
    throw Object.assign(new Error("Percentual da plataforma inválido."), { status: 500 });
  }
  const merchant = 100 - platform;
  return {
    merchantPercent: merchant,
    platformPercent: platform,
    split: {
      enabled: true,
      rules: [
        {
          amount: merchant,
          recipient_id: merchantRecipientId,
          type: "percentage",
          options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true },
        },
        {
          amount: platform,
          recipient_id: platformRecipientId,
          type: "percentage",
          options: { charge_processing_fee: false, charge_remainder_fee: false, liable: false },
        },
      ],
    },
  };
};

/** Parte da Arbian numa cobrança de assinatura (centavos). */
const subscriptionPlatformSplitCents = (amountCents, platformPercent = platformFeePercent()) => {
  const total = Math.max(0, Math.round(Number(amountCents) || 0));
  const pct = _int(platformPercent, 0);
  return Math.min(total, Math.max(0, Math.round(total * (pct / 100))));
};

const _toCents = (value) => Math.round((Number(value) || 0) * 100);

const _text = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Itens da assinatura espelhando o produto e as opções escolhidas. A entrega não
 * é item (fica embutida no preço). Opções sem custo entram só na descrição.
 * Retorna { items, amountCents }.
 */
const buildSubscriptionItems = ({ item, options = [] }) => {
  const baseCents = _toCents(item?.price);
  if (!Number.isFinite(baseCents) || baseCents <= 0) {
    throw Object.assign(new Error("A assinatura precisa de um preço maior que zero."), { status: 400 });
  }
  const name = _text(item.name, 64) || "Assinatura";
  const freeOptions = options
    .filter((o) => _toCents(o.additional_price) <= 0)
    .map((o) => (o.quantity > 1 ? `${o.quantity}x ${o.option_name}` : o.option_name));
  const description = _text(
    [item.description, freeOptions.length ? `Opções: ${freeOptions.join(", ")}` : ""].filter(Boolean).join(" — "),
    256,
  ) || name;

  const items = [{
    name,
    description,
    quantity: 1,
    pricing_scheme: { scheme_type: "unit", price: baseCents },
  }];
  for (const option of options) {
    const unitCents = _toCents(option.additional_price);
    if (unitCents <= 0) continue;
    const qty = Math.max(1, _int(option.quantity, 1));
    const label = _text(`${option.group_name ? `${option.group_name}: ` : ""}${option.option_name}`, 64);
    items.push({
      name: label,
      description: label,
      quantity: qty,
      pricing_scheme: { scheme_type: "unit", price: unitCents },
    });
  }
  const amountCents = items.reduce((sum, it) => sum + it.quantity * it.pricing_scheme.price, 0);
  return { items, amountCents };
};

const _id = (value, prefix) => {
  if (typeof value === "string" && value.startsWith(prefix)) return value;
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.startsWith(prefix)) return value.id;
  return null;
};

/**
 * Lê as referências de um evento de assinatura/fatura/cobrança. A doc pública
 * não traz exemplos de payload, então aceitamos as formas conhecidas da API v5
 * (objeto aninhado ou `*_id`).
 */
const subscriptionRefsFromPayload = (data = {}) => {
  const d = data && typeof data === "object" ? data : {};
  const invoice = _id(d.id, "in_") ? d : (d.invoice && typeof d.invoice === "object" ? d.invoice : null);
  const charge = _id(d.id, "ch_") ? d : (d.charge && typeof d.charge === "object" ? d.charge : (invoice?.charge || null));
  const subscription = _id(d.id, "sub_") ? d : (d.subscription || invoice?.subscription || charge?.subscription || null);

  const invoiceId = _id(invoice, "in_") || _id(d.invoice_id, "in_") || _id(charge?.invoice, "in_") || _id(charge?.invoice_id, "in_");
  const chargeId = _id(charge, "ch_") || _id(d.charge_id, "ch_") || _id(invoice?.charge_id, "ch_");
  const subscriptionId = _id(subscription, "sub_") || _id(d.subscription_id, "sub_")
    || _id(invoice?.subscription_id, "sub_") || _id(charge?.invoice?.subscription_id, "sub_");

  const lastTx = charge?.last_transaction || null;
  const cycle = invoice?.cycle || d.current_cycle || null;
  const period = invoice?.period || null;
  const amount = invoice?.amount ?? charge?.amount ?? null;

  return {
    subscriptionId,
    invoiceId,
    chargeId,
    transactionId: lastTx?.id || null,
    invoiceStatus: invoice?.status ? String(invoice.status).toLowerCase() : null,
    chargeStatus: charge?.status ? String(charge.status).toLowerCase() : null,
    subscriptionStatus: subscription && typeof subscription === "object" && subscription.status
      ? String(subscription.status).toLowerCase()
      : null,
    cycle: {
      number: _int(cycle?.cycle, null),
      start: cycle?.start_at || period?.start_at || null,
      end: cycle?.end_at || period?.end_at || null,
    },
    amountCents: Number.isFinite(Number(amount)) && amount !== null ? Math.round(Number(amount)) : null,
  };
};

/**
 * Classifica o evento no que importa para a assinatura:
 * paid | failed | chargeback | refunded | invoice_canceled | provider_canceled | sync | ignore.
 */
const classifySubscriptionEvent = (type, refs = {}) => {
  const t = String(type || "").toLowerCase();
  if (t === "subscription.canceled") return "provider_canceled";
  if (t.startsWith("subscription.")) return "sync";
  if (t === "charge.chargedback" || t === "chargeback.received") return "chargeback";
  if (t === "charge.refunded") return "refunded";
  if (t === "invoice.paid" || t === "charge.paid") return "paid";
  if (t === "invoice.payment_failed" || t === "charge.payment_failed") return "failed";
  if (t === "invoice.canceled") return "invoice_canceled";
  if (t === "invoice.created" || t.endsWith(".updated") || t === "charge.pending" || t === "charge.processing") {
    const status = t.startsWith("invoice.") ? (refs.invoiceStatus || refs.chargeStatus) : (refs.chargeStatus || refs.invoiceStatus);
    return statusOutcome(status) || "sync";
  }
  return "ignore";
};

/** Status de cobrança/fatura da Pagar.me → desfecho (usado também na conciliação). */
const statusOutcome = (status) => {
  const s = String(status || "").toLowerCase();
  if (s === "paid") return "paid";
  if (["failed", "payment_failed", "not_authorized", "refused"].includes(s)) return "failed";
  if (["chargedback", "chargeback"].includes(s)) return "chargeback";
  if (s === "refunded") return "refunded";
  if (s === "canceled") return "invoice_canceled";
  return null;
};

/**
 * Fatura paga. Idempotente: a mesma fatura não conta duas vezes.
 * `otherFailedInvoices`: faturas da mesma assinatura ainda recusadas.
 */
const applyInvoicePaid = (sub, invoice, { otherFailedInvoices = 0, now = new Date() } = {}) => {
  if (invoice?.status === "paid") return { changed: false, subscription: sub, invoice, cancelProvider: false };
  const nextInvoice = { ...invoice, status: "paid", paid_at: now, next_retry_at: null };
  const next = { ...sub };
  next.paid_cycles = (Number(sub.paid_cycles) || 0) + 1;
  if (invoice?.period_start) next.current_cycle_start = invoice.period_start;
  if (invoice?.period_end) next.current_cycle_end = invoice.period_end;

  let cancelProvider = false;
  if (!FINAL_STATUSES.includes(sub.status)) {
    if (sub.status === "pending" || (sub.status === "paused" && otherFailedInvoices === 0)) {
      next.status = "active";
      next.paused_at = null;
    }
    const limit = Number(sub.duration_cycles) || 0;
    if (limit > 0 && next.paid_cycles >= limit) {
      next.status = "ended";
      next.ended_at = now;
      cancelProvider = true;
    }
  }
  return { changed: true, subscription: next, invoice: nextInvoice, cancelProvider };
};

/**
 * Recusa de cobrança. Conta 1 tentativa por transação; a 3ª recusa (1 + 2
 * retentativas) pausa. Recusa da primeira cobrança encerra a contratação.
 */
const applyPaymentFailed = (sub, invoice, { transactionId = null, now = new Date(), retryHours = retryIntervalHours() } = {}) => {
  const unchanged = { changed: false, subscription: sub, invoice, cancelProvider: false };
  if (!invoice || ["paid", "refunded", "chargedback", "canceled"].includes(invoice.status)) return unchanged;
  if (transactionId && invoice.last_failed_transaction_id === transactionId) return unchanged;
  if (!transactionId && invoice.last_failed_at
    && now.getTime() - new Date(invoice.last_failed_at).getTime() < FAILURE_DEDUP_WINDOW_MS) {
    return unchanged;
  }

  const attempts = (Number(invoice.failed_attempts) || 0) + 1;
  const nextInvoice = {
    ...invoice,
    status: "failed",
    failed_attempts: attempts,
    last_failed_transaction_id: transactionId || invoice.last_failed_transaction_id || null,
    last_failed_at: now,
    next_retry_at: null,
  };
  const next = { ...sub };
  let cancelProvider = false;

  if (sub.status === "pending") {
    next.status = "canceled";
    next.canceled_at = now;
    next.canceled_by = "system";
    next.cancel_reason = "first_payment_failed";
    cancelProvider = true;
  } else if (sub.status === "active") {
    if (attempts >= MAX_ATTEMPTS) {
      next.status = "paused";
      next.paused_at = now;
    } else {
      nextInvoice.next_retry_at = new Date(now.getTime() + retryHours * 3600 * 1000);
    }
  }
  return { changed: true, subscription: next, invoice: nextInvoice, cancelProvider };
};

/** Chargeback numa fatura cancela a assinatura. */
const applyChargeback = (sub, invoice, { now = new Date() } = {}) => {
  const nextInvoice = invoice ? { ...invoice, status: "chargedback", next_retry_at: null } : invoice;
  if (FINAL_STATUSES.includes(sub.status)) {
    return { changed: invoice?.status !== "chargedback", subscription: sub, invoice: nextInvoice, cancelProvider: false };
  }
  return {
    changed: true,
    subscription: { ...sub, status: "canceled", canceled_at: now, canceled_by: "system", cancel_reason: "chargeback" },
    invoice: nextInvoice,
    cancelProvider: true,
  };
};

/** Cancelamento (cliente, comerciante ou a própria Pagar.me). */
const applyCancel = (sub, { by, reason, now = new Date() }) => {
  if (FINAL_STATUSES.includes(sub.status)) return { changed: false, subscription: sub };
  return {
    changed: true,
    subscription: { ...sub, status: "canceled", canceled_at: now, canceled_by: by, cancel_reason: reason || null },
  };
};

/** Id local da assinatura gravado na metadata da Pagar.me (contratação com erro/timeout). */
const localSubscriptionIdFromPayload = (data = {}) => {
  const d = data && typeof data === "object" ? data : {};
  const candidates = [
    _id(d.id, "sub_") ? d.metadata : null,
    d.subscription?.metadata,
    d.invoice?.subscription?.metadata,
    d.charge?.invoice?.subscription?.metadata,
    d.invoice?.metadata,
    _id(d.id, "in_") ? d.metadata : null,
  ];
  for (const metadata of candidates) {
    const n = Number(metadata?.arbian_subscription_id);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
};

/**
 * Avisos de uma transição aplicada: { merchant, customer } (null = sem aviso).
 * `merchant.kind` é a chave de merchantNotifications.TYPES.
 *
 * A mudança de status vem antes da recusa:
 * - 1ª cobrança recusada (pending → canceled): contratação não concluída;
 * - 3ª recusa (active → paused): nada aqui — o aviso de pausa sai depois de
 *   cancelar os agendamentos (com a contagem);
 * - recusa com a assinatura já pausada (recobrança após troca de cartão): texto próprio.
 */
const transitionNotices = ({ before, after, outcome, invoice }) => {
  const none = { merchant: null, customer: null };
  if (!before || !after) return none;
  const id = before.id;
  const itemName = before.items?.[0]?.name || `assinatura #${id}`;

  if (before.status !== after.status) {
    if (after.status === "paused") return none;
    if (before.status === "paused" && after.status === "active") {
      return {
        merchant: {
          kind: "RESUMED",
          title: "Assinatura retomada",
          message: `A assinatura de ${itemName} voltou a ficar ativa após a atualização do cartão.`,
          eventKey: `subscription:${id}:resumed:${invoice?.id || Date.now()}`,
        },
        customer: { id: "resumed" },
      };
    }
    if (after.status === "ended") {
      return {
        merchant: {
          kind: "ENDED",
          title: "Assinatura encerrada",
          message: `A assinatura de ${itemName} chegou ao fim do prazo contratado.`,
          eventKey: `subscription:${id}:ended`,
        },
        customer: { id: "ended" },
      };
    }
    if (after.status === "canceled") {
      if (before.status === "pending" && after.cancel_reason === "first_payment_failed") {
        return {
          merchant: {
            kind: "CANCELED",
            title: "Contratação não concluída",
            message: `A 1ª cobrança de ${itemName} foi recusada e a assinatura foi cancelada.`,
            eventKey: `subscription:${id}:canceled`,
          },
          customer: { id: "first_payment_failed" },
        };
      }
      const chargeback = outcome === "chargeback";
      return {
        merchant: {
          kind: "CANCELED",
          title: "Assinatura cancelada",
          message: `A assinatura de ${itemName} foi cancelada${chargeback ? " após um chargeback" : ""}.`,
          eventKey: `subscription:${id}:canceled`,
        },
        customer: { id: "canceled", details: { canceledBy: chargeback ? "chargeback" : "provider" } },
      };
    }
    return none;
  }

  if (outcome === "failed" && invoice) {
    const attempts = invoice.failed_attempts;
    const eventKey = `subscription:${id}:invoice:${invoice.id}:declined:${attempts}`;
    if (after.status === "active") {
      return {
        merchant: {
          kind: "PAYMENT_DECLINED",
          title: "Cobrança recusada",
          message: `A cobrança de ${itemName} foi recusada (tentativa ${attempts}).`,
          eventKey,
        },
        customer: { id: "payment_declined", details: { failedAttempts: attempts } },
      };
    }
    if (after.status === "paused") {
      return {
        merchant: {
          kind: "PAYMENT_DECLINED",
          title: "Cobrança recusada",
          message: `A cobrança pendente de ${itemName} foi recusada de novo; a assinatura continua pausada.`,
          eventKey,
        },
        customer: { id: "payment_declined_paused", details: { failedAttempts: attempts } },
      };
    }
  }
  return none;
};

module.exports = {
  MAX_RETRIES,
  MAX_ATTEMPTS,
  OPEN_STATUSES,
  FINAL_STATUSES,
  platformFeePercent,
  retryIntervalHours,
  buildSubscriptionSplit,
  subscriptionPlatformSplitCents,
  buildSubscriptionItems,
  subscriptionRefsFromPayload,
  classifySubscriptionEvent,
  statusOutcome,
  applyInvoicePaid,
  applyPaymentFailed,
  applyChargeback,
  applyCancel,
  localSubscriptionIdFromPayload,
  transitionNotices,
};
