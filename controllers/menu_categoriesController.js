const service = require("../services/menu_categoriesService");

/**
 * Get all MenuCategories
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching MenuCategories:", error);
    return res.status(500).json({ error: "Failed to fetch MenuCategories" });
  }
};

/**
 * Get MenuCategories by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "MenuCategories not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching MenuCategories by ID:", error);
    return res.status(500).json({ error: "Failed to fetch MenuCategories" });
  }
};

/**
 * Create new MenuCategories
 */
const create = async (req, res) => {
  const menu_categories = req.body;
  if (!menu_categories || Object.keys(menu_categories).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(menu_categories);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating MenuCategories:", error);
    return res.status(500).json({ error: "Failed to create MenuCategories" });
  }
};

/**
 * Update MenuCategories
 */
const update = async (req, res) => {
  const { id } = req.params;
  const menu_categories = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...menu_categories, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "MenuCategories not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating MenuCategories:", error);
    return res.status(500).json({ error: "Failed to update MenuCategories" });
  }
};

/**
 * Delete MenuCategories
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "MenuCategories not found" });
    return res.status(200).json({ message: "MenuCategories deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting MenuCategories:", error);
    return res.status(500).json({ error: "Failed to delete MenuCategories" });
  }
};

module.exports = { findAll, find, create, update, remove };
