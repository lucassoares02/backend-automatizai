const service = require("../services/payment_methodsService");

/**
 * Get all PaymentMethods
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching PaymentMethods:", error);
    return res.status(500).json({ error: "Failed to fetch PaymentMethods" });
  }
};

/**
 * Get PaymentMethods by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "PaymentMethods not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching PaymentMethods by ID:", error);
    return res.status(500).json({ error: "Failed to fetch PaymentMethods" });
  }
};

/**
 * Get PaymentMethods by Company ID
 */
const findByCompany = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.findByCompany(id);
    if (!item) return res.status(404).json({ error: "PaymentMethods not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching PaymentMethods by Company ID:", error);
    return res.status(500).json({ error: "Failed to fetch PaymentMethods" });
  }
};

/**
 * Create new PaymentMethods
 */
const create = async (req, res) => {
  const payment_methods = req.body;
  if (!payment_methods || Object.keys(payment_methods).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(payment_methods);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating PaymentMethods:", error);
    return res.status(500).json({ error: "Failed to create PaymentMethods" });
  }
};

/**
 * Update PaymentMethods
 */
const update = async (req, res) => {
  const { id } = req.params;
  const payment_methods = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...payment_methods, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "PaymentMethods not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating PaymentMethods:", error);
    return res.status(500).json({ error: "Failed to update PaymentMethods" });
  }
};

/**
 * Delete PaymentMethods
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "PaymentMethods not found" });
    return res.status(200).json({ message: "PaymentMethods deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting PaymentMethods:", error);
    return res.status(500).json({ error: "Failed to delete PaymentMethods" });
  }
};

module.exports = { findAll, find, findByCompany, create, update, remove };
