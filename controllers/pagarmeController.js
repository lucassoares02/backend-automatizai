const service = require("../services/pagarmeService");
const { verifyPaymentSession, tokenFromRequest } = require("../helpers/publicPaymentSession");

const _paymentSessionForOrder = (req, orderId) => {
  const session = verifyPaymentSession(tokenFromRequest(req));
  if (!session || Number(session.order_id) !== Number(orderId)) return null;
  return session;
};

const _paymentRiskContext = (req) => ({
  // `req.ip` só usa X-Forwarded-For quando TRUST_PROXY está configurado no
  // bootstrap. Assim não confiamos em cabeçalho controlado pelo navegador.
  clientIp: req.ip || req.socket?.remoteAddress || null,
  riskSessionId: req.body?.risk_session_id,
  devicePlatform: req.body?.device_platform,
  location: req.body?.location,
});

/**
 * Cria o token efêmero usado pelo challenge 3DS no navegador. A sessão curta
 * comprova que o chamador está pagando o pedido informado.
 */
const threeDsToken = async (req, res) => {
  const orderId = req.query?.order_id;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  if (!_paymentSessionForOrder(req, orderId)) {
    return res.status(401).json({ error: "Sessão de pagamento inválida ou expirada." });
  }
  try {
    const result = await service.createThreeDsToken();
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me 3DS token error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao iniciar autenticação de segurança" });
  }
};

// ─── Comerciante (autenticado) ─────────────────────────────────────────────────

/**
 * Cria/atualiza o recebedor da empresa a partir do formulário do portal.
 * Body: { company_id, register_information, default_bank_account }
 */
const connect = async (req, res) => {
  const companyId = req.body?.company_id ?? req.body?.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id é obrigatório" });
  }
  const { register_information, default_bank_account } = req.body || {};
  if (!register_information || !default_bank_account) {
    return res.status(400).json({ error: "register_information e default_bank_account são obrigatórios" });
  }
  try {
    const result = await service.createOrUpdateRecipient(Number(companyId), {
      register_information,
      default_bank_account,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me connect error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao conectar Pagar.me" });
  }
};

/**
 * Gera o link de verificação (KYC) do recebedor da empresa.
 * Body: { company_id }
 */
const kyc = async (req, res) => {
  const companyId = req.body?.company_id ?? req.body?.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id é obrigatório" });
  }
  try {
    const result = await service.createKycLink(Number(companyId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me kyc error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao gerar verificação" });
  }
};

/**
 * Status do recebedor (sincronizando com o Pagar.me).
 * Param: :companyId
 */
const status = async (req, res) => {
  const companyId = req.params.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "companyId inválido" });
  }
  try {
    const result = await service.refreshRecipientStatus(Number(companyId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me status error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao obter status" });
  }
};

/**
 * Dados já cadastrados do recebedor, para pré-preencher o formulário de
 * "Atualizar dados". Param: :companyId
 */
const recipient = async (req, res) => {
  const companyId = req.params.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "companyId inválido" });
  }
  try {
    const result = await service.getRecipientDetails(Number(companyId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me recipient error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao carregar dados do recebedor" });
  }
};

/**
 * Atualiza a agenda de transferências automáticas do recebedor.
 * Body: { company_id, transfer_enabled, transfer_interval, transfer_day }.
 */
const updateTransferSettings = async (req, res) => {
  const companyId = req.body?.company_id ?? req.body?.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id é obrigatório" });
  }
  try {
    const result = await service.updateTransferSettings(Number(companyId), {
      transfer_enabled: req.body?.transfer_enabled,
      transfer_interval: req.body?.transfer_interval,
      transfer_day: req.body?.transfer_day,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me transfer settings error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao atualizar transferências automáticas" });
  }
};

/**
 * Resumo de recebimentos (pagamentos online) para o dashboard do lojista.
 * Param: :companyId. Query opcional: ?days=30 (0/ausente = tudo).
 */
const payments = async (req, res) => {
  const companyId = req.params.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "companyId inválido" });
  }
  try {
    const days = Number(req.query.days) || 0;
    const result = await service.getPaymentsSummary(Number(companyId), { days });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me payments error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao carregar recebimentos" });
  }
};

/**
 * Saldo do recebedor (disponível / a liberar / transferido). Param: :companyId
 */
const balance = async (req, res) => {
  const companyId = req.params.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "companyId inválido" });
  }
  try {
    const result = await service.getRecipientBalance(Number(companyId));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me balance error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao consultar saldo" });
  }
};

/**
 * Solicita um saque do saldo disponível para a conta bancária do recebedor.
 * Body: { company_id, amount? } — amount em reais; ausente = total disponível.
 */
const withdraw = async (req, res) => {
  const companyId = req.body?.company_id ?? req.body?.companyId;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id é obrigatório" });
  }
  try {
    const amount = req.body?.amount != null && req.body.amount !== "" ? Number(req.body.amount) : null;
    const result = await service.requestWithdrawal(Number(companyId), amount);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me withdraw error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao solicitar saque" });
  }
};

// ─── Cliente (público) ─────────────────────────────────────────────────────────

/**
 * Cobrança com cartão (card_token gerado no cliente via pagarme.js).
 * Body: { order_id, payment_session_token, request_id, card_token, saved_card_id?, document?, email?, installments?, billing_address? }
 */
const payCard = async (req, res) => {
  const orderId = req.body?.order_id ?? req.body?.orderId;
  const cardToken = req.body?.card_token;
  const savedCardId = req.body?.saved_card_id;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  if (!cardToken && !savedCardId) {
    return res.status(400).json({ error: "card_token ou saved_card_id é obrigatório" });
  }
  if (!_paymentSessionForOrder(req, orderId)) {
    return res.status(401).json({ error: "Sessão de pagamento inválida ou expirada." });
  }
  const session = _paymentSessionForOrder(req, orderId);
  if ((savedCardId || req.body?.save_card === true) && session.customer_verified !== true) {
    return res.status(403).json({ error: "Cartões salvos exigem verificação de identidade do cliente." });
  }
  try {
    const result = await service.createCardCharge(Number(orderId), cardToken, {
      document: req.body?.document,
      email: req.body?.email,
      name: req.body?.name,
      phone: req.body?.phone,
      installments: req.body?.installments,
      billingAddress: req.body?.billing_address,
      savedCardId,
      saveCard: req.body?.save_card === true,
      requestId: req.body?.request_id,
      threeDs: req.body?.three_ds,
      customerVerified: session.customer_verified === true,
      ..._paymentRiskContext(req),
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me card error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao processar o pagamento" });
  }
};

/**
 * Lista métodos salvos da sessão de pagamento. Nunca devolve o card_id do cofre.
 * Query: ?order_id=...
 */
const listCards = async (req, res) => {
  const orderId = req.query?.order_id;
  if (!orderId || isNaN(orderId)) return res.status(400).json({ error: "order_id é obrigatório" });
  const session = _paymentSessionForOrder(req, orderId);
  if (!session) return res.status(401).json({ error: "Sessão de pagamento inválida ou expirada." });
  if (session.customer_verified !== true) return res.status(200).json([]);
  try {
    const cards = await service.listSavedCardsForClient(session.client_id);
    return res.status(200).json(cards);
  } catch (error) {
    console.error("Pagar.me listCards error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao listar cartões" });
  }
};

/**
 * Remove um cartão salvo do cliente. Param :id (linha em user_payment_tokens);
 * Sessão de pagamento comprova o contexto do pedido.
 */
const deleteCard = async (req, res) => {
  const id = req.params?.id;
  if (!id || isNaN(id)) return res.status(400).json({ error: "id inválido" });
  const orderId = req.body?.order_id ?? req.query?.order_id;
  if (!orderId || isNaN(orderId)) return res.status(400).json({ error: "order_id é obrigatório" });
  const session = _paymentSessionForOrder(req, orderId);
  if (!session) return res.status(401).json({ error: "Sessão de pagamento inválida ou expirada." });
  if (session.customer_verified !== true) {
    return res.status(403).json({ error: "Cartões salvos exigem verificação de identidade do cliente." });
  }
  try {
    const result = await service.deleteSavedCardForClient(session.client_id, Number(id));
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me deleteCard error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao remover cartão" });
  }
};

/**
 * Cobrança via PIX (retorna QR code para exibição em modal).
 * Body: { order_id, payment_session_token, request_id, document?, email?, name?, phone? }
 */
const payPix = async (req, res) => {
  const orderId = req.body?.order_id ?? req.body?.orderId;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  if (!_paymentSessionForOrder(req, orderId)) {
    return res.status(401).json({ error: "Sessão de pagamento inválida ou expirada." });
  }
  try {
    const result = await service.createPixCharge(Number(orderId), {
      document: req.body?.document,
      email: req.body?.email,
      name: req.body?.name,
      phone: req.body?.phone,
      requestId: req.body?.request_id,
      ..._paymentRiskContext(req),
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me pix error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao gerar o PIX" });
  }
};

// ─── Webhook (sem auth JWT; Basic auth verificado) ─────────────────────────────

/**
 * Recebe eventos do Pagar.me. Segurança por HTTP Basic auth configurado no
 * dashboard. O 2xx só é devolvido depois que o evento foi persistido e aplicado;
 * assim o Pagar.me pode tentar novamente quando houver falha transitória.
 */
const webhook = async (req, res) => {
  if (!service.verifyBasicAuth(req.headers["authorization"])) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  // Corpo pode chegar como Buffer (express.raw) ou objeto (express.json).
  let event = req.body;
  if (Buffer.isBuffer(event)) {
    try {
      event = JSON.parse(event.toString("utf8"));
    } catch (_) {
      return res.status(400).json({ error: "Payload inválido" });
    }
  }

  try {
    const result = await service.handleWebhookEvent(event);
    return res.status(200).json({ received: true, duplicate: result.duplicate === true });
  } catch (err) {
    console.error("Pagar.me webhook handler error:", err.message);
    return res.status(err.status || 500).json({ error: "Falha temporária ao processar evento." });
  }
};

module.exports = { connect, kyc, status, recipient, updateTransferSettings, payments, balance, withdraw, threeDsToken, payCard, payPix, listCards, deleteCard, webhook };
