const service = require("../services/pagarmeService");

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
 * Body: { order_id, card_token, document?, email?, name?, phone?, installments? }
 */
const payCard = async (req, res) => {
  const orderId = req.body?.order_id ?? req.body?.orderId;
  const cardToken = req.body?.card_token;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  if (!cardToken) {
    return res.status(400).json({ error: "card_token é obrigatório" });
  }
  try {
    const result = await service.createCardCharge(Number(orderId), cardToken, {
      document: req.body?.document,
      email: req.body?.email,
      name: req.body?.name,
      phone: req.body?.phone,
      installments: req.body?.installments,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Pagar.me card error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao processar o pagamento" });
  }
};

/**
 * Cobrança via PIX (retorna QR code para exibição em modal).
 * Body: { order_id, document?, email?, name?, phone? }
 */
const payPix = async (req, res) => {
  const orderId = req.body?.order_id ?? req.body?.orderId;
  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: "order_id é obrigatório" });
  }
  try {
    const result = await service.createPixCharge(Number(orderId), {
      document: req.body?.document,
      email: req.body?.email,
      name: req.body?.name,
      phone: req.body?.phone,
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
 * dashboard. Responde rápido; erros de processamento são logados mas não
 * impedem o 200 quando a autenticação é válida.
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

  res.status(200).json({ received: true });

  try {
    await service.handleWebhookEvent(event);
  } catch (err) {
    console.error("Pagar.me webhook handler error:", err.message);
  }
};

module.exports = { connect, kyc, status, recipient, payments, balance, withdraw, payCard, payPix, webhook };
