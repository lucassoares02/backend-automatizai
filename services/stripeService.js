const pool = require("../db");

// ─── Cliente Stripe (lazy) ─────────────────────────────────────────────────────
// Inicializa sob demanda para não derrubar o boot quando a chave não está setada
// (ambientes sem Stripe continuam funcionando; só as rotas Stripe é que falham).
let _stripe = null;
const getStripe = () => {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw Object.assign(new Error("Stripe não configurado (STRIPE_SECRET_KEY ausente)."), { status: 503 });
  }
  _stripe = require("stripe")(key);
  return _stripe;
};

const PLATFORM_FEE_PERCENT = Number(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? 10);
const CURRENCY = (process.env.STRIPE_CURRENCY || "brl").toLowerCase();

// URL base do app público (para success/cancel do checkout) e do portal do
// comerciante (para retorno do onboarding Connect).
const APP_URL = (process.env.PUBLIC_APP_URL || process.env.ORIGIN || "").replace(/\/$/, "");
const PORTAL_URL = (process.env.PORTAL_APP_URL || process.env.ORIGIN || APP_URL || "").replace(/\/$/, "");

// ─── Persistência (companies / orders) ─────────────────────────────────────────
const _getCompanyStripe = async (companyId) => {
  const r = await pool.query(
    `SELECT id, name, uuid, stripe_account_id, stripe_charges_enabled, stripe_onboarding_completed
     FROM companies WHERE id = $1`,
    [companyId],
  );
  return r.rows[0] || null;
};

const _saveAccountId = async (companyId, accountId) => {
  await pool.query("UPDATE companies SET stripe_account_id = $2 WHERE id = $1", [companyId, accountId]);
};

const _saveAccountStatus = async (accountId, chargesEnabled, onboardingCompleted) => {
  await pool.query(
    `UPDATE companies
     SET stripe_charges_enabled = $2, stripe_onboarding_completed = $3
     WHERE stripe_account_id = $1`,
    [accountId, !!chargesEnabled, !!onboardingCompleted],
  );
};

// ─── Connect: onboarding do comerciante ────────────────────────────────────────

/**
 * Garante uma conta conectada (Express) para a empresa e devolve o account id.
 * Cria a conta na Stripe na primeira vez e persiste o id em companies.
 */
const createOrGetConnectedAccount = async (companyId) => {
  const company = await _getCompanyStripe(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (company.stripe_account_id) return company.stripe_account_id;

  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: "express",
    country: process.env.STRIPE_ACCOUNT_COUNTRY || "BR",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: { name: company.name || undefined },
    metadata: { company_id: String(companyId) },
  });

  await _saveAccountId(companyId, account.id);
  return account.id;
};

/**
 * Cria um Account Link de onboarding (URL para o comerciante concluir o cadastro
 * na Stripe). refresh_url/return_url voltam para o portal do comerciante.
 */
const createOnboardingLink = async (companyId) => {
  const accountId = await createOrGetConnectedAccount(companyId);
  const stripe = getStripe();

  const refreshUrl =
    process.env.STRIPE_CONNECT_REFRESH_URL || `${PORTAL_URL}/payment-methods?stripe=refresh`;
  const returnUrl =
    process.env.STRIPE_CONNECT_RETURN_URL || `${PORTAL_URL}/payment-methods?stripe=return`;

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });

  return { url: link.url, account_id: accountId };
};

/**
 * Consulta a conta na Stripe e sincroniza charges_enabled / onboarding em companies.
 */
const refreshAccountStatus = async (companyId) => {
  const company = await _getCompanyStripe(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.stripe_account_id) {
    return { connected: false, charges_enabled: false, onboarding_completed: false };
  }

  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(company.stripe_account_id);
  const chargesEnabled = !!account.charges_enabled;
  const onboardingCompleted = !!account.details_submitted;
  await _saveAccountStatus(company.stripe_account_id, chargesEnabled, onboardingCompleted);

  return {
    connected: true,
    charges_enabled: chargesEnabled,
    onboarding_completed: onboardingCompleted,
  };
};

// ─── Checkout do cliente (destination charge + application fee) ─────────────────

/**
 * Cria uma Checkout Session para um pedido, cobrando no modo de contas conectadas:
 * o valor vai para a conta do comerciante (transfer_data.destination) e a
 * plataforma retém a taxa (application_fee_amount). Devolve a URL hospedada.
 */
const createCheckoutSessionForOrder = async (orderId) => {
  const orderRes = await pool.query(
    `SELECT o.id, o.uuid, o.total, o.tag, o.company_id, o.payment_status,
            c.name AS company_name, c.stripe_account_id, c.stripe_charges_enabled
     FROM orders o
     JOIN companies c ON c.id = o.company_id
     WHERE o.id = $1`,
    [orderId],
  );
  const order = orderRes.rows[0];
  if (!order) throw Object.assign(new Error("Pedido não encontrado."), { status: 404 });

  // Self-heal: a conta existe mas a coluna local ainda não reflete que as
  // cobranças estão habilitadas (webhook account.updated pode não ter chegado).
  // Sincroniza uma vez com a Stripe antes de recusar o pagamento.
  if (order.stripe_account_id && order.stripe_charges_enabled !== true) {
    try {
      const status = await refreshAccountStatus(order.company_id);
      if (status.charges_enabled === true) order.stripe_charges_enabled = true;
    } catch (_) {
      // Mantém o comportamento de recusa abaixo se a sincronização falhar.
    }
  }

  if (!order.stripe_account_id || order.stripe_charges_enabled !== true) {
    throw Object.assign(new Error("Este estabelecimento ainda não habilitou pagamentos online."), { status: 409 });
  }
  if (order.payment_status === "paid") {
    throw Object.assign(new Error("Pedido já pago."), { status: 409 });
  }

  const totalCents = Math.round(Number(order.total) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw Object.assign(new Error("Valor do pedido inválido."), { status: 400 });
  }
  const feeCents = Math.max(0, Math.round(totalCents * (PLATFORM_FEE_PERCENT / 100)));

  const stripe = getStripe();
  const orderRef = order.tag || `#${order.id}`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: CURRENCY,
          product_data: { name: `Pedido ${orderRef} — ${order.company_name || "Loja"}` },
          unit_amount: totalCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: feeCents,
      transfer_data: { destination: order.stripe_account_id },
      metadata: { order_id: String(order.id), company_id: String(order.company_id) },
    },
    success_url: `${APP_URL}/pedido/${order.uuid}?pagamento=sucesso`,
    cancel_url: `${APP_URL}/pedido/${order.uuid}?pagamento=cancelado`,
    metadata: { order_id: String(order.id), company_id: String(order.company_id) },
  });

  await pool.query(
    "UPDATE orders SET payment_provider = 'stripe', stripe_checkout_session_id = $2 WHERE id = $1",
    [order.id, session.id],
  );

  return { url: session.url, session_id: session.id };
};

/**
 * Cria (ou reaproveita) um PaymentIntent para um pedido no modo de contas
 * conectadas — o cliente paga SEM sair da plataforma (Payment Element embutido).
 * O valor vai para a conta do comerciante (transfer_data.destination) e a
 * plataforma retém a taxa (application_fee_amount). Restrito a cartão para
 * garantir que nenhum método exija redirect. Devolve o client_secret.
 */
const createPaymentIntentForOrder = async (orderId) => {
  const orderRes = await pool.query(
    `SELECT o.id, o.uuid, o.total, o.tag, o.company_id, o.payment_status, o.stripe_payment_intent_id,
            c.name AS company_name, c.stripe_account_id, c.stripe_charges_enabled
     FROM orders o
     JOIN companies c ON c.id = o.company_id
     WHERE o.id = $1`,
    [orderId],
  );
  const order = orderRes.rows[0];
  if (!order) throw Object.assign(new Error("Pedido não encontrado."), { status: 404 });

  // Self-heal do status Stripe (webhook account.updated pode não ter chegado).
  if (order.stripe_account_id && order.stripe_charges_enabled !== true) {
    try {
      const status = await refreshAccountStatus(order.company_id);
      if (status.charges_enabled === true) order.stripe_charges_enabled = true;
    } catch (_) {
      // Mantém a recusa abaixo se a sincronização falhar.
    }
  }
  if (!order.stripe_account_id || order.stripe_charges_enabled !== true) {
    throw Object.assign(new Error("Este estabelecimento ainda não habilitou pagamentos online."), { status: 409 });
  }
  if (order.payment_status === "paid") {
    throw Object.assign(new Error("Pedido já pago."), { status: 409 });
  }

  const totalCents = Math.round(Number(order.total) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw Object.assign(new Error("Valor do pedido inválido."), { status: 400 });
  }
  const feeCents = Math.max(0, Math.round(totalCents * (PLATFORM_FEE_PERCENT / 100)));

  const stripe = getStripe();
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || null;

  // Idempotência: se o pedido já tem um PaymentIntent utilizável e do mesmo
  // valor, reaproveita (evita PIs órfãos quando o cliente volta à tela).
  if (order.stripe_payment_intent_id) {
    try {
      const existing = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      const reusable = ["requires_payment_method", "requires_confirmation", "requires_action"].includes(existing.status);
      if (reusable && existing.amount === totalCents) {
        return { client_secret: existing.client_secret, publishable_key: publishableKey, payment_intent_id: existing.id };
      }
    } catch (_) {
      // PI inexistente/incompatível: cria um novo abaixo.
    }
  }

  const orderRef = order.tag || `#${order.id}`;
  const intent = await stripe.paymentIntents.create({
    amount: totalCents,
    currency: CURRENCY,
    description: `Pedido ${orderRef} — ${order.company_name || "Loja"}`,
    application_fee_amount: feeCents,
    transfer_data: { destination: order.stripe_account_id },
    // Métodos habilitados na conta (cartão, PIX quando ativado no dashboard) SEM
    // nenhum que exija redirect — o cliente nunca sai da plataforma. PIX exibe o
    // QR code em modal na própria página e é confirmado via webhook.
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { order_id: String(order.id), company_id: String(order.company_id) },
  });

  await pool.query(
    "UPDATE orders SET payment_provider = 'stripe', stripe_payment_intent_id = $2 WHERE id = $1",
    [order.id, intent.id],
  );

  return { client_secret: intent.client_secret, publishable_key: publishableKey, payment_intent_id: intent.id };
};

// ─── Webhook ───────────────────────────────────────────────────────────────────

const constructEvent = (rawBody, signature) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET ausente."), { status: 503 });
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
};

const _markOrderPaid = async (orderId, paymentIntentId) => {
  await pool.query(
    `UPDATE orders
     SET payment_status = 'paid', payment_provider = 'stripe', stripe_payment_intent_id = $2
     WHERE id = $1`,
    [orderId, paymentIntentId || null],
  );
};

const handleWebhookEvent = async (event) => {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;
      if (orderId && session.payment_status === "paid") {
        await _markOrderPaid(Number(orderId), session.payment_intent);
      }
      break;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;
      if (orderId) {
        await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [Number(orderId)]);
      }
      break;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object;
      const orderId = pi.metadata?.order_id;
      if (orderId) await _markOrderPaid(Number(orderId), pi.id);
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object;
      const orderId = pi.metadata?.order_id;
      if (orderId) {
        await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [Number(orderId)]);
      }
      break;
    }
    case "account.updated": {
      const account = event.data.object;
      await _saveAccountStatus(account.id, account.charges_enabled, account.details_submitted);
      break;
    }
    default:
      // Eventos não tratados são ignorados de propósito.
      break;
  }
};

module.exports = {
  createOrGetConnectedAccount,
  createOnboardingLink,
  refreshAccountStatus,
  createCheckoutSessionForOrder,
  createPaymentIntentForOrder,
  constructEvent,
  handleWebhookEvent,
};
