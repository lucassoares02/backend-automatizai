const service = require("../services/menu_itemsService");

/**
 * Get all MenuItems
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching MenuItems:", error);
    return res.status(500).json({ error: "Failed to fetch MenuItems" });
  }
};

/**
 * Get MenuItems by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "MenuItems not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching MenuItems by ID:", error);
    return res.status(500).json({ error: "Failed to fetch MenuItems" });
  }
};

/**
 * Create new MenuItems
 */
const create = async (req, res) => {
  const menu_items = req.body;
  if (!menu_items || Object.keys(menu_items).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(menu_items);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating MenuItems:", error);
    return res.status(500).json({ error: "Failed to create MenuItems" });
  }
};

/**
 * Update MenuItems
 */
const update = async (req, res) => {
  const { id } = req.params;
  const menu_items = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...menu_items, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "MenuItems not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating MenuItems:", error);
    return res.status(500).json({ error: "Failed to update MenuItems" });
  }
};

/**
 * Delete MenuItems
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "MenuItems not found" });
    return res.status(200).json({ message: "MenuItems deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting MenuItems:", error);
    return res.status(500).json({ error: "Failed to delete MenuItems" });
  }
};

module.exports = { findAll, find, create, update, remove };
