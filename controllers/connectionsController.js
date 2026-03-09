const service = require("../services/connectionsService");
const evolution = require("../services/evolutionService");
const n8n = require("../services/n8nService");

/**
 * Get all Connections
 */
const findAll = async (req, res) => {
  const { company } = req.params;
  if (!company || isNaN(company)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const data = await service.findAll(company);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching Connections:", error);
    return res.status(500).json({ error: "Failed to fetch Connections" });
  }
};

/**
 * Get Connections by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Connections not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Connections by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Connections" });
  }
};

/**
 * Create new Connections
 */
const create = async (req, res) => {
  const { integration, instanceName, qrcode, company } = req.body;

  try {
    const templateN8N = await n8n.duplicate(instanceName, company);

    const newConnection = await evolution.create(instanceName, integration, qrcode);

    await service.create({
      company: company,
      instanceName,
      instanceId: newConnection.instance.instanceId,
      status: newConnection.instance.status,
      hash: newConnection.hash,
    });

    await evolution.updateInstance(instanceName, templateN8N.name);

    return res.status(201).json(newConnection);
  } catch (error) {
    console.error("Error creating Connections:", error);
    return res.status(500).json({ error: "Failed to create Connections" });
  }
};

/**
 * Update Connections
 */
const update = async (req, res) => {
  const { id } = req.params;
  const connections = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...connections, id: parseInt(id) });

    if (!updated) return res.status(404).json({ error: "Connections not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Connections:", error);
    return res.status(500).json({ error: "Failed to update Connections" });
  }
};

/**
 * Delete Connections
 */
const remove = async (req, res) => {
  const { id, instance } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleteEvolution = await evolution.deleteInstance(instance);

    if (!deleteEvolution) {
      return res.status(404).json({ error: "Connections not found in Evolution" });
    }

    const deleted = await service.remove(id);

    if (!deleted) return res.status(404).json({ error: "Connections not found" });

    return res.status(200).json({ message: "Connections deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting Connections:", error);
    return res.status(500).json({ error: "Failed to delete Connections" });
  }
};

module.exports = { findAll, find, create, update, remove };
