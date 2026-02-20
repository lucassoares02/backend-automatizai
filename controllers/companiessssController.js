const service = require("../services/companiessssService");

/**
 * Get all Companiessss
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching Companiessss:", error);
    return res.status(500).json({ error: "Failed to fetch Companiessss" });
  }
};

/**
 * Get Companiessss by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Companiessss not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Companiessss by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Companiessss" });
  }
};

/**
 * Create new Companiessss
 */
const create = async (req, res) => {
  const companiessss = req.body;
  if (!companiessss || Object.keys(companiessss).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(companiessss);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating Companiessss:", error);
    return res.status(500).json({ error: "Failed to create Companiessss" });
  }
};

/**
 * Update Companiessss
 */
const update = async (req, res) => {
  const companiessss = req.body;
  const id = companiessss["id"];

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...companiessss, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "Companiessss not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Companiessss:", error);
    return res.status(500).json({ error: "Failed to update Companiessss" });
  }
};

/**
 * Delete Companiessss
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Companiessss not found" });
    return res.status(200).json({ message: "Companiessss deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting Companiessss:", error);
    return res.status(500).json({ error: "Failed to delete Companiessss" });
  }
};

module.exports = { findAll, find, create, update, remove };
