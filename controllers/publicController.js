const service = require("../services/publicService");
const reorderService = require("../services/reorderService");
const pagarmeService = require("../services/pagarmeService");
const { verifyPaymentSession, tokenFromRequest } = require("../helpers/publicPaymentSession");

const listRestaurants = async (_req, res) => {
  try {
    const data = await service.listPublicRestaurants();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching public restaurants:", error);
    return res.status(500).json({ error: "Failed to fetch restaurants" });
  }
};

const getCompanyMenu = async (req, res) => {
  const { companyId } = req.params;
  // companyId pode ser o UUID público ou o id numérico (retrocompatível).
  if (!companyId || !String(companyId).trim()) return res.status(400).json({ error: "Invalid company reference" });
  try {
    const data = await service.getCompanyPublicMenu(companyId);
    if (!data) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching public menu:", error);
    return res.status(500).json({ error: "Failed to fetch menu" });
  }
};

const findClientByPhone = async (req, res) => {
  const { phone, company_id } = req.query;
  if (!phone || !company_id) return res.status(400).json({ error: "phone and company_id are required" });
  try {
    const client = await service.findClientByPhone(phone, company_id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.status(200).json(client);
  } catch (error) {
    console.error("Error finding client by phone:", error);
    return res.status(500).json({ error: "Failed to find client" });
  }
};

const createClient = async (req, res) => {
  const { company_id, name } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: "company_id and name are required" });
  try {
    const client = await service.createPublicClient({
      ...req.body,
      authenticated_user_id: req.customer?.id || null,
    });
    return res.status(201).json(client);
  } catch (error) {
    console.error("Error creating public client:", error);
    return res.status(error.status || 500).json({ error: error.message || "Failed to create client" });
  }
};

const updateClient = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid client ID" });
  try {
    const client = await service.updatePublicClient({ id: Number(id), ...req.body });
    if (client && client._forbidden) {
      return res.status(403).json({ error: "Telefone não confere para este cadastro" });
    }
    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.status(200).json(client);
  } catch (error) {
    console.error("Error updating public client:", error);
    return res.status(500).json({ error: "Failed to update client" });
  }
};

const createOrder = async (req, res) => {
  const { company_id, client_id, items } = req.body;
  if (!company_id || !client_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "company_id, client_id, and items are required" });
  }
  if (req.body?.payment_provider === "pagarme" && !(await pagarmeService.isPaymentInfrastructureReady())) {
    return res.status(503).json({ error: "Pagamento online indisponível no momento." });
  }
  try {
    const order = await service.createPublicOrder({
      ...req.body,
      authenticated_user_id: req.customer?.id || null,
    });
    const paymentSession = order.payment_provider === "pagarme"
      ? pagarmeService.createPublicPaymentSession(order, {
          customerVerified: Boolean(req.customer?.id),
        })
      : {};
    return res.status(201).json({ ...order, ...paymentSession });
  } catch (error) {
    console.error("Error creating public order:", error);
    return res.status(error.status || 500).json({ error: error.message || "Failed to create order" });
  }
};

// A sessão curta de pagamento é a autorização para mudar apenas o submétodo
// online (cartão/PIX) de um pedido ainda pendente. Não aceita telefone como prova
// de identidade e o service bloqueia a troca quando já há cobrança ativa.
const changeOnlinePaymentMethod = async (req, res) => {
  const orderId = Number(req.params?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const session = verifyPaymentSession(tokenFromRequest(req));
  if (!session || Number(session.order_id) !== orderId) {
    return res.status(401).json({ error: "Sessão de pagamento inválida ou expirada." });
  }
  try {
    const order = await service.changePendingOnlinePaymentMethod({
      orderId,
      companyId: session.company_id,
      clientId: session.client_id,
      onlinePaymentMethod: req.body?.online_payment_method,
      paymentMethodId: req.body?.payment_method_id,
    });
    return res.status(200).json(order);
  } catch (error) {
    if (error.status >= 500) console.error("Error changing public payment method:", error);
    return res.status(error.status || 500).json({ error: error.message || "Não foi possível trocar a forma de pagamento." });
  }
};

const calculateDeliveryFee = async (req, res) => {
  const { company_id, destination_lat, destination_lng } = req.query;
  if (!company_id || isNaN(company_id)) {
    return res.status(400).json({ error: "company_id inválido" });
  }
  if (!destination_lat || !destination_lng) {
    return res
      .status(400)
      .json({ error: "destination_lat e destination_lng são obrigatórios" });
  }
  try {
    const result = await service.calculatePublicDeliveryFee({
      company_id: Number(company_id),
      destination_lat: Number(destination_lat),
      destination_lng: Number(destination_lng),
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error calculating public delivery fee:", error);
    return res.status(500).json({ error: "Failed to calculate delivery fee" });
  }
};

const getOrder = async (req, res) => {
  const { id } = req.params;
  const { phone } = req.query;
  // id pode ser o UUID público do pedido ou o id numérico (retrocompatível).
  if (!id || !String(id).trim()) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const order = await service.getPublicOrder({
      id: String(id).trim(),
      phone: phone ? String(phone) : null,
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.status(200).json(order);
  } catch (error) {
    console.error("Error fetching public order:", error);
    return res.status(500).json({ error: "Failed to fetch order" });
  }
};

const createOrderPaymentSession = async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!id) return res.status(400).json({ error: "Invalid order id" });
  try {
    const order = await service.getPublicOrder({
      id,
      phone: req.body?.phone ? String(req.body.phone) : null,
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (
      order.payment_provider !== "pagarme" ||
      Number(order.status) !== 10 ||
      ["paid", "refunded", "refund_pending", "chargedback"].includes(
        String(order.payment_status || ""),
      )
    ) {
      return res.status(409).json({
        error: "Este pedido não está disponível para pagamento online.",
      });
    }
    if (
      order.delivery_fee_pending_agreement === true &&
      !order.delivery_fee_agreement_confirmed_at
    ) {
      return res.status(409).json({
        error: "O pagamento será liberado depois que o frete for definido.",
      });
    }
    const customerVerified = req.customer?.id
      ? await service.publicOrderClientBelongsToUser(
          order.client_id,
          req.customer.id,
        )
      : false;
    return res.status(200).json(
      pagarmeService.createPublicPaymentSession(order, {
        customerVerified,
      }),
    );
  } catch (error) {
    console.error("Error creating public payment session:", error);
    return res
      .status(error.status || 500)
      .json({ error: error.message || "Failed to create payment session" });
  }
};

const listOrdersByPhone = async (req, res) => {
  // Telefone não é autenticação. O histórico será reaberto quando o provedor de
  // OTP emitir uma sessão de cliente verificada; até lá, use links UUID de cada
  // pedido para evitar enumeração e vazamento de dados pessoais.
  return res.status(410).json({
    error: "Histórico por telefone indisponível sem verificação de identidade.",
  });
};

const reorder = async (req, res) => {
  const { id } = req.params;
  const { phone } = req.query;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const data = await reorderService.reorder({
      orderId: Number(id),
      phone: phone ? String(phone) : null,
    });
    return res.status(200).json(data);
  } catch (error) {
    const status = error?.status || 500;
    const message = error?.message || "Failed to reorder";
    if (status >= 500) console.error("Error rebuilding reorder:", error);
    return res.status(status).json({ error: message });
  }
};

const cancelOrder = async (req, res) => {
  const { id } = req.params;
  const { phone, reason } = req.body || {};
  if (!id || !String(id).trim()) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const result = await service.cancelPublicOrder({
      id: String(id).trim(),
      phone: phone ? String(phone) : null,
      reason: reason ? String(reason).slice(0, 500) : null,
    });
    if (!result.ok) {
      return res.status(result.code || 400).json({ error: result.message });
    }
    return res.status(200).json({
      cancelled: true,
      refunded: result.refunded,
      refund_pending: result.refundPending,
      paid_online: result.paidOnline,
    });
  } catch (error) {
    console.error("Error cancelling public order:", error);
    return res.status(500).json({ error: "Failed to cancel order" });
  }
};

module.exports = {
  listRestaurants,
  getCompanyMenu,
  findClientByPhone,
  createClient,
  updateClient,
  createOrder,
  changeOnlinePaymentMethod,
  calculateDeliveryFee,
  getOrder,
  createOrderPaymentSession,
  listOrdersByPhone,
  reorder,
  cancelOrder,
};
