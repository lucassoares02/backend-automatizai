const service = require("../services/aiIgnoredPhoneNumbersService");

const findAllByCompany = async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Empresa inválida." });
  }

  try {
    const data = await service.findAllByCompany(companyId);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching AI ignored phone numbers:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao carregar os números." });
  }
};

const create = async (req, res) => {
  const companyId = Number(req.body?.company_id);
  const { description, phone } = req.body || {};
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Empresa inválida." });
  }

  try {
    const data = await service.create({ companyId, description, phone });
    return res.status(201).json(data);
  } catch (error) {
    console.error("Error creating AI ignored phone number:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao adicionar o número." });
  }
};

const remove = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Registro inválido." });
  }

  try {
    const data = await service.remove(id);
    if (!data) return res.status(404).json({ error: "Número não encontrado." });
    return res.status(200).json({ message: "Número removido da lista.", data });
  } catch (error) {
    console.error("Error deleting AI ignored phone number:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao remover o número." });
  }
};

module.exports = { findAllByCompany, create, remove };
