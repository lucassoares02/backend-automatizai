const service = require("../services/additional_infoService");

/**
 * Get all AdditionalInfo
 */
const findAll = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }
  try {
    const data = await service.findAll(id);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching AdditionalInfo:", error);
    return res.status(500).json({ error: "Failed to fetch AdditionalInfo" });
  }
};

/**
 * Get AdditionalInfo by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "AdditionalInfo not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching AdditionalInfo by ID:", error);
    return res.status(500).json({ error: "Failed to fetch AdditionalInfo" });
  }
};

/**
 * Create new AdditionalInfo
 */
const create = async (req, res) => {
  const additional_info = req.body;
  if (!additional_info || Object.keys(additional_info).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(additional_info);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating AdditionalInfo:", error);
    return res.status(500).json({ error: "Failed to create AdditionalInfo" });
  }
};

/**
 * Update AdditionalInfo
 */
const update = async (req, res) => {
  const { id } = req.params;
  const additional_info = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...additional_info, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "AdditionalInfo not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating AdditionalInfo:", error);
    return res.status(500).json({ error: "Failed to update AdditionalInfo" });
  }
};

/**
 * Delete AdditionalInfo
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "AdditionalInfo not found" });
    return res.status(200).json({ message: "AdditionalInfo deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting AdditionalInfo:", error);
    return res.status(500).json({ error: "Failed to delete AdditionalInfo" });
  }
};

module.exports = { findAll, find, create, update, remove };
