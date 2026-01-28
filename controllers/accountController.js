const service = require("../services/accountService");

/**
 * Get all Account
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching Account:", error);
    return res.status(500).json({ error: "Failed to fetch Account" });
  }
};

/**
 * Get Account by ID
 */
const find = async (req, res) => {
  const { id } = req.user;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Account not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Account by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Account" });
  }
};

/**
 * Update Account
 */
const update = async (req, res) => {
  const { id } = req.user;
  const account = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...account, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "Account not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Account:", error);
    return res.status(500).json({ error: "Failed to update Account" });
  }
};

module.exports = { findAll, find, update };
