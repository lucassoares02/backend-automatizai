const service = require("../services/company_opening_hoursService");

/**
 * Get all CompanyOpeningHours
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching CompanyOpeningHours:", error);
    return res.status(500).json({ error: "Failed to fetch CompanyOpeningHours" });
  }
};

/**
 * Get CompanyOpeningHours by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "CompanyOpeningHours not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching CompanyOpeningHours by ID:", error);
    return res.status(500).json({ error: "Failed to fetch CompanyOpeningHours" });
  }
};

/**
 * Create new CompanyOpeningHours
 */
const create = async (req, res) => {
  const company_opening_hours = req.body;
  if (!company_opening_hours || Object.keys(company_opening_hours).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(company_opening_hours);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating CompanyOpeningHours:", error);
    return res.status(500).json({ error: "Failed to create CompanyOpeningHours" });
  }
};

/**
 * Update CompanyOpeningHours
 */
const update = async (req, res) => {
  const { id } = req.params;
  const company_opening_hours = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...company_opening_hours, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "CompanyOpeningHours not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating CompanyOpeningHours:", error);
    return res.status(500).json({ error: "Failed to update CompanyOpeningHours" });
  }
};

/**
 * Delete CompanyOpeningHours
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "CompanyOpeningHours not found" });
    return res.status(200).json({ message: "CompanyOpeningHours deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting CompanyOpeningHours:", error);
    return res.status(500).json({ error: "Failed to delete CompanyOpeningHours" });
  }
};

module.exports = { findAll, find, create, update, remove };
