const service = require("../services/connectionsService");
const evolution = require("../services/evolutionService");
const n8n = require("../services/n8nService");
const googleService = require("../services/googleService");

/**
 * Get all Connections for a company
 */
const findAll = async (req, res) => {
  const { company } = req.params;
  if (!company || isNaN(company)) {
    return res.status(400).json({ error: "Invalid company ID" });
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
 * Get Connection by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Connection not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Connection by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Connection" });
  }
};

/**
 * Create a new Connection (Evolution instance + N8N workflow)
 */
const create = async (req, res) => {
  const { integration, instanceName, qrcode, company, description } = req.body;

  if (!integration || !instanceName || !company) {
    return res.status(400).json({ error: "integration, instanceName and company are required" });
  }

  try {
    const templateN8N = await n8n.duplicate(instanceName, company);

    const newConnection = await evolution.create(instanceName, integration, qrcode ?? true);

    await service.create({
      company,
      instanceName,
      instanceId: newConnection.instance.instanceId,
      integration,
      description: description ?? null,
      status: newConnection.instance.status,
      hash: newConnection.hash,
    });

    await evolution.updateInstance(instanceName);

    return res.status(201).json(newConnection);
  } catch (error) {
    console.error("Error creating Connection:", error);
    return res.status(500).json({ error: "Failed to create Connection", details: error.message });
  }
};

/**
 * Update Connection
 */
const update = async (req, res) => {
  const { id } = req.params;
  const connections = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...connections, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "Connection not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Connection:", error);
    return res.status(500).json({ error: "Failed to update Connection" });
  }
};

/**
 * Delete Connection (Evolution instance + DB record)
 */
const remove = async (req, res) => {
  const { id, instance } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleteEvolution = await evolution.deleteInstance(instance);
    if (!deleteEvolution) {
      return res.status(404).json({ error: "Connection not found in Evolution" });
    }

    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Connection not found" });

    return res.status(200).json({ message: "Connection deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting Connection:", error);
    return res.status(500).json({ error: "Failed to delete Connection", details: error.message });
  }
};

/**
 * Atualizar fluxo do n8n vinculado a uma conexão existente.
 *
 * Estratégia simples: delete + recria.
 *  1. Busca conexão atual (valida que ela pertence à empresa do token)
 *  2. Chama n8n.update — internamente faz deactivate → delete → recreate → activate
 *     do workflow com o mesmo nome (instanceName) usando o template master atualizado
 *  3. Reaplica os dados da empresa via os mesmos transformers da criação
 *
 * Nada precisa ser gravado no banco: o vínculo workflow ↔ empresa é feito
 * pelo `instanceName`, que continua o mesmo após a recriação.
 */
const updateWorkflow = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const connection = await service.find(id);
    if (!connection) return res.status(404).json({ error: "Connection not found" });

    const instance = connection.instance_name;
    const company = connection.company_id;
    if (!instance || !company) {
      return res.status(400).json({ error: "Connection missing instanceName or company" });
    }

    const result = await n8n.update(instance, company);
    return res.status(200).json({ message: "Workflow updated", data: result });
  } catch (error) {
    console.error("Error updating workflow:", error);
    return res.status(500).json({ error: "Failed to update workflow", details: error.message });
  }
};

/**
 * Get fresh QR code for an instance — used for auto-refresh in the UI
 */
const getQrCode = async (req, res) => {
  const { instance } = req.params;
  if (!instance) {
    return res.status(400).json({ error: "Instance name required" });
  }
  try {
    const result = await evolution.getQrCode(instance);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error getting QR code:", error);
    return res.status(500).json({ error: "Failed to get QR code", details: error.message });
  }
};

/**
 * Test a Connection — checks real-time state via Evolution API
 */
const testConnection = async (req, res) => {
  const { instance } = req.params;
  if (!instance) {
    return res.status(400).json({ error: "Instance name required" });
  }
  try {
    const result = await evolution.testConnection(instance);
    // Sync status back to DB if it changed
    const state = result?.instance?.state ?? result?.state;
    if (state) {
      // Best-effort status update — no await, failure is non-critical
      service
        .find_by_instance(instance)
        .then((conn) => {
          if (conn && conn.status !== state) {
            service.update({ id: conn.id, status: state }).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error testing Connection:", error);
    return res.status(500).json({ error: "Failed to test Connection", details: error.message });
  }
};

/**
 * Search address via Google Geocoding (belongs here for routing convenience)
 */
const searchAddress = async (req, res) => {
  const { logradouro, cidade, estado } = req.body;
  if (!logradouro || !cidade || !estado) {
    return res.status(400).json({ error: "Missing required query parameters" });
  }
  try {
    const addressData = await googleService.buscarEndereco(logradouro, cidade, estado);
    return res.status(200).json(addressData);
  } catch (error) {
    console.error("Error searching address:", error);
    return res.status(500).json({ error: "Failed to search address" });
  }
};

/**
 * Webhook receiver — called by Evolution API on MESSAGES_UPSERT and CONNECTION_UPDATE.
 * Always returns 200 so Evolution stops retrying on transient errors.
 */
const webhook = async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const { event, instance, data } = req.body || {};
    if (!event || !instance) return;

    if (event === "CONNECTION_UPDATE") {
      const state = data?.state;
      if (state) {
        await service.updateStatusByInstance(instance, state);
      }
    } else if (event === "MESSAGES_UPSERT") {
      evolution.forwardToN8n(instance, req.body).catch((e) => console.error("[webhook] N8N forward failed:", e.message));
    }
  } catch (err) {
    console.error("[webhook] handler error:", err.message);
  }
};

/**
 * DB-based status check — used by Flutter polling (avoids hammering Evolution API).
 */
const getStatus = async (req, res) => {
  const { instance } = req.params;
  if (!instance) return res.status(400).json({ error: "Instance name required" });
  try {
    const status = await service.getStatusByInstance(instance);
    if (status === null) return res.status(404).json({ error: "Connection not found" });
    return res.status(200).json({ status });
  } catch (err) {
    console.error("Error getting connection status:", err);
    return res.status(500).json({ error: "Failed to get status" });
  }
};

module.exports = { findAll, find, create, update, remove, getQrCode, testConnection, searchAddress, webhook, getStatus, updateWorkflow };
