const service = require("../services/registerService");

/**
 * Get all Register
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching Register:", error);
    return res.status(500).json({ error: "Failed to fetch Register" });
  }
};

/**
 * Get Register by ID
 */
const find = async (req, res) => {
  const { cnpj } = req.params;
  if (!cnpj || isNaN(cnpj)) {
    return res.status(400).json({ error: "Invalid CNPJ" });
  }
  try {
    const item = await service.find(cnpj);
    if (!item) return res.status(404).json({ error: "Find Cnpj not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Cnpj :", error);
    return res.status(500).json({ error: "Failed to fetch CNPJ" });
  }
};

/**
 * Create new Register
 */
const create = async (req, res) => {
  const register = req.body;
  if (!register || Object.keys(register).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(register);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating Register:", error);
    return res.status(500).json({ error: "Failed to create Register" });
  }
};

/**
 * Create new Register
 */
const createCompanies = async (req, res) => {
  const register = req.body;
  if (!register || Object.keys(register).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.createCompanies(register);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating Register:", error);
    return res.status(500).json({ error: "Failed to create Register" });
  }
};
/**
 * Create new Register
 */
const createCompaniesWithoutId = async (req, res) => {
  const register = req.body;
  if (!register || Object.keys(register).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  register.user = req.user.id;
  try {
    const newItem = await service.createCompanies(register);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating Register:", error);
    return res.status(500).json({ error: "Failed to create Register" });
  }
};

/**
 * Update Register
 */
const update = async (req, res) => {
  const { id } = req.params;
  const register = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...register, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "Register not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Register:", error);
    return res.status(500).json({ error: "Failed to update Register" });
  }
};

/**
 * Delete Register
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Register not found" });
    return res.status(200).json({ message: "Register deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting Register:", error);
    return res.status(500).json({ error: "Failed to delete Register" });
  }
};

module.exports = { findAll, find, create, update, remove, createCompanies, createCompaniesWithoutId };
