const service = require("../services/publicService");
const reorderService = require("../services/reorderService");

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
    const client = await service.createPublicClient(req.body);
    return res.status(201).json(client);
  } catch (error) {
    console.error("Error creating public client:", error);
    return res.status(500).json({ error: "Failed to create client" });
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
  try {
    const order = await service.createPublicOrder(req.body);
    return res.status(201).json(order);
  } catch (error) {
    console.error("Error creating public order:", error);
    return res.status(500).json({ error: "Failed to create order" });
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

const listOrdersByPhone = async (req, res) => {
  const { company_id, phone } = req.query;
  if (!company_id || isNaN(company_id)) {
    return res.status(400).json({ error: "company_id inválido" });
  }
  if (!phone) {
    return res.status(400).json({ error: "phone é obrigatório" });
  }
  try {
    const orders = await service.findPublicOrdersByPhone({
      company_id: Number(company_id),
      phone: String(phone),
    });
    return res.status(200).json(orders);
  } catch (error) {
    console.error("Error listing public orders by phone:", error);
    return res.status(500).json({ error: "Failed to list orders" });
  }
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

module.exports = {
  listRestaurants,
  getCompanyMenu,
  findClientByPhone,
  createClient,
  updateClient,
  createOrder,
  calculateDeliveryFee,
  getOrder,
  listOrdersByPhone,
  reorder,
};
