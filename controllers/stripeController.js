const service = require("../services/stripeService");

// ─── Comerciante (autenticado) ─────────────────────────────────────────────────

/**
 * Inicia/continua o onboarding Connect da empresa. Retorna a URL da Stripe para
 * o comerciante concluir o cadastro (dados bancários, KYC, etc.).
 * Body: { company_id }
 */
const connect = async (req, res) => {
  const companyId = req.body?.company_id ?? req.body?.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id é obrigatório" });
  }
  try {
    const result = await service.createOnboardingLink(Number(companyId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Stripe connect error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao conectar Stripe" });
  }
};

/**
 * Retorna o status atual da conta conectada (sincronizando com a Stripe).
 * Param: :companyId
 */
const status = async (req, res) => {
  const companyId = req.params.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "companyId inválido" });
  }
  try {
    const result = await service.refreshAccountStatus(Number(companyId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Stripe status error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao obter status" });
  }
};

// ─── Cliente (público) ─────────────────────────────────────────────────────────

/**
 * Cria a Checkout Session para um pedido e devolve a URL hospedada da Stripe.
 * Body: { order_id }
 */
const createCheckout = async (req, res) => {
  const orderId = req.body?.order_id ?? req.body?.orderId;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  try {
    const result = await service.createCheckoutSessionForOrder(Number(orderId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Stripe checkout error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao iniciar pagamento" });
  }
};

/**
 * Cria (ou reaproveita) o PaymentIntent de um pedido e devolve o client_secret
 * para o pagamento embutido (Payment Element) — o cliente não sai da plataforma.
 * Body: { order_id }
 */
const createPaymentIntent = async (req, res) => {
  const orderId = req.body?.order_id ?? req.body?.orderId;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  try {
    const result = await service.createPaymentIntentForOrder(Number(orderId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Stripe payment intent error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao iniciar pagamento" });
  }
};

// ─── Webhook (sem auth; assinatura verificada) ─────────────────────────────────

/**
 * Recebe eventos da Stripe. Requer o corpo RAW (configurado em index.js) para
 * validar a assinatura. Sempre responde rápido; erros de processamento são
 * logados mas não impedem o 200 quando a assinatura é válida.
 */
const webhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = service.constructEvent(req.body, signature);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  res.status(200).json({ received: true });

  try {
    await service.handleWebhookEvent(event);
  } catch (err) {
    console.error("Stripe webhook handler error:", err.message);
  }
};

module.exports = { connect, status, createCheckout, createPaymentIntent, webhook };
