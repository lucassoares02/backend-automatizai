const service = require("../services/ordersService");
const VALID_STATUS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const findByCompany = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.findByCompany(id);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching orders:", error);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
};

const findTodayByCompany = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.findTodayByCompany(id);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching today's orders:", error);
    return res.status(500).json({ error: "Failed to fetch today's orders" });
  }
};

const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const order = await service.find(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.status(200).json(order);
  } catch (error) {
    console.error("Error fetching order:", error);
    return res.status(500).json({ error: "Failed to fetch order" });
  }
};

const summarize = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.summarize(id);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching order summary:", error);
    return res.status(500).json({ error: "Failed to fetch order summary" });
  }
};

const create = async (req, res) => {
  const body = req.body;
  if (!body || !body.client_id || !Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: "client_id and at least one item are required" });
  }
  try {
    const order = await service.create(body);
    return res.status(201).json(order);
  } catch (error) {
    console.error("Error creating order:", error);
    return res.status(500).json({ error: "Failed to create order" });
  }
};

const updateStatus = async (req, res) => {
  const { id } = req.params;
  const { cancel_reason } = req.body;
  const status = Number(req.body?.status);
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  if (!Number.isInteger(status) || !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(", ")}` });
  }
  try {
    const updated = await service.updateStatus(id, status, cancel_reason);
    if (!updated) return res.status(404).json({ error: "Order not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating order status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
};

const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Order not found" });
    return res.status(200).json({ message: "Order deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting order:", error);
    return res.status(500).json({ error: "Failed to delete order" });
  }
};

module.exports = { findByCompany, findTodayByCompany, find, summarize, create, updateStatus, remove };
