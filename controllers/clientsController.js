const service = require("../services/clientsService");

const findAllWithStats = async (req, res) => {
  const { id } = req.params;
  const { search = "", filter = "all" } = req.query;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.findAllWithStats(id, search, filter);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching clients:", error);
    return res.status(500).json({ error: "Failed to fetch clients" });
  }
};

const getSummary = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.getSummary(id);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching clients summary:", error);
    return res.status(500).json({ error: "Failed to fetch clients summary" });
  }
};

const getDetails = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const data = await service.getDetails(id);
    if (!data) return res.status(404).json({ error: "Client not found" });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching client details:", error);
    return res.status(500).json({ error: "Failed to fetch client details" });
  }
};

const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const client = await service.find(id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.status(200).json(client);
  } catch (error) {
    console.error("Error fetching client:", error);
    return res.status(500).json({ error: "Failed to fetch client" });
  }
};

const create = async (req, res) => {
  const { company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code, note } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: "company_id and name are required" });
  try {
    const client = await service.create({ company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code, note });
    return res.status(201).json(client);
  } catch (error) {
    console.error("Error creating client:", error);
    return res.status(500).json({ error: "Failed to create client" });
  }
};

const update = async (req, res) => {
  const { id } = req.params;
  const { name, phone, street, number, complement, neighborhood, city, state, zip_code, note } = req.body;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const updated = await service.update({ id: parseInt(id), name, phone, street, number, complement, neighborhood, city, state, zip_code, note });
    if (!updated) return res.status(404).json({ error: "Client not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating client:", error);
    return res.status(500).json({ error: "Failed to update client" });
  }
};

const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Client not found" });
    return res.status(200).json({ message: "Client deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting client:", error);
    return res.status(500).json({ error: "Failed to delete client" });
  }
};

module.exports = { findAllWithStats, getSummary, getDetails, find, create, update, remove };
