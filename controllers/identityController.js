const service = require("../services/identityService");

// ─── Resolução de identidade (consumido pelo n8n via service key `x-api-key`) ──
// POST /identity/resolve  { company_id, phone, name? }
// Ponto ÚNICO onde o fluxo WhatsApp resolve telefone -> identidade -> client.
// Retorna o client_id já canônico da empresa, usado no restante do fluxo n8n.
const resolve = async (req, res) => {
  const { company_id, phone, name } = req.body || {};
  if (!company_id || !phone) {
    return res.status(400).json({ error: "company_id e phone são obrigatórios" });
  }
  try {
    const { client, userId } = await service.resolveClientByPhone({
      companyId: Number(company_id),
      phone: String(phone),
      name: name ? String(name) : null,
    });
    return res.status(200).json({
      client_id: client.id,
      user_id: userId,
      company_id: client.company_id,
      name: client.name,
      client,
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Error resolving identity:", error);
    return res.status(500).json({ error: "Failed to resolve identity" });
  }
};

// ─── Endereços salvos (público — prova de posse via telefone) ──────────────────
// O app público sempre envia o telefone do próprio cliente; ele resolve a
// identidade global e opera apenas sobre os endereços dela.

const listAddresses = async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  try {
    const userId = await service.lookupUserIdByPhone(String(phone));
    if (!userId) return res.status(200).json([]); // sem identidade ainda → lista vazia
    const rows = await service.listAddresses(userId);
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Error listing addresses:", error);
    return res.status(500).json({ error: "Failed to list addresses" });
  }
};

const createAddress = async (req, res) => {
  const { phone, street } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  if (!street) return res.status(400).json({ error: "street é obrigatório" });
  try {
    // Cadastrar endereço resolve/cria a identidade (posse do número = nível 1).
    const uid = await resolveUid(service, phone);
    const row = await service.createAddress(uid, req.body);
    return res.status(201).json(row);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Error creating address:", error);
    return res.status(500).json({ error: "Failed to create address" });
  }
};

const updateAddress = async (req, res) => {
  const { id } = req.params;
  const { phone } = req.body || {};
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid address id" });
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  try {
    const userId = await service.lookupUserIdByPhone(String(phone));
    if (!userId) return res.status(403).json({ error: "Telefone não confere" });
    const row = await service.updateAddress(Number(id), userId, req.body);
    if (!row) return res.status(404).json({ error: "Endereço não encontrado" });
    return res.status(200).json(row);
  } catch (error) {
    console.error("Error updating address:", error);
    return res.status(500).json({ error: "Failed to update address" });
  }
};

const deleteAddress = async (req, res) => {
  const { id } = req.params;
  const { phone } = req.query;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid address id" });
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  try {
    const userId = await service.lookupUserIdByPhone(String(phone));
    if (!userId) return res.status(403).json({ error: "Telefone não confere" });
    const ok = await service.deleteAddress(Number(id), userId);
    if (!ok) return res.status(404).json({ error: "Endereço não encontrado" });
    return res.status(200).json({ deleted: true });
  } catch (error) {
    console.error("Error deleting address:", error);
    return res.status(500).json({ error: "Failed to delete address" });
  }
};

// Helper: resolve (criando se preciso) o userId a partir do telefone.
const resolveUid = async (svc, phone) => {
  const pool = require("../db");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { userId } = await svc.resolveUserByPhone(db, String(phone));
    await db.query("COMMIT");
    return userId;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
};

module.exports = { resolve, listAddresses, createAddress, updateAddress, deleteAddress };
