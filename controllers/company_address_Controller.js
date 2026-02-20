const service = require("../services/company_addressService");

/**
 * Get all Company
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching Company:", error);
    return res.status(500).json({ error: "Failed to fetch Company" });
  }
};

/**
 * Get Company by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);

    if (!item)
      return res.status(200).json({
        id: null,
        company_id: null,
        street: null,
        number: null,
        complement: null,
        neighborhood: null,
        city: null,
        state: null,
        zip_code: null,
        latitude: null,
        longitude: null,
        is_main: true,
        created_at: null,
        updated_at: null,
      });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Company by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Company" });
  }
};

/**
 * Create new Company
 */
const create = async (req, res) => {
  const company = req.body;
  if (!company || Object.keys(company).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(company);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating Company:", error);
    return res.status(500).json({ error: "Failed to create Company" });
  }
};

/**
 * Update Company
 */
const update = async (req, res) => {
  const company = req.body;
  const id = company["id"];

  if (!id || isNaN(id)) {
    const newItem = await service.create(company);
    return res.status(201).json(newItem);
  }
  try {
    const updated = await service.update({ ...company, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Company:", error);
    return res.status(500).json({ error: "Failed to update Company" });
  }
};

/**
 * Delete Company
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json({ message: "Company deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting Company:", error);
    return res.status(500).json({ error: "Failed to delete Company" });
  }
};

module.exports = { findAll, find, create, update, remove };
