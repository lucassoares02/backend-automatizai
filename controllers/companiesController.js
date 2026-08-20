const service = require("../services/companiesService");

/**
 * Get Home by ID
 */
const find = async (req, res) => {
  const { id } = req.user;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Home not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Home by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Home" });
  }
};

/**
 * Get Home by ID
 */
const findId = async (req, res) => {
  console.log(req.user);
  const { id } = req.user;
  const { company } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.findId(id, company);
    if (!item) return res.status(404).json({ error: "Home not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Home by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Home" });
  }
};

/**
 * Lista todas as lojas (somente admin do sistema) para o switcher do header.
 */
const findAll = async (req, res) => {
  try {
    const items = await service.findAllCompanies();
    return res.status(200).json(items);
  } catch (error) {
    console.error("Error fetching all companies:", error);
    return res.status(500).json({ error: "Failed to fetch companies" });
  }
};

/**
 * Get Providers by City
 */
const findProvidersCity = async (req, res) => {
  const { id } = req.user;
  const { company } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.findProvidersCity(company);
    if (!item) return res.status(404).json({ error: "Providers not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Providers by City:", error);
    return res.status(500).json({ error: "Failed to fetch Providers by City" });
  }
};

/**
 * Patch update Company
 */
const update = async (req, res) => {
  const company = req.body;
  try {
    const updatedItem = await service.update(company);
    return res.status(200).json(updatedItem);
  } catch (error) {
    console.error("Error updating Company:", error);
    return res.status(500).json({ error: "Failed to update Company" });
  }
};

// Abrir/fechar a loja manualmente. Body: { manual_open: true | false | null }
// true/false forçam o status; null volta a seguir os horários cadastrados.
const setOpenStatus = async (req, res) => {
  const companyId = Number(req.params.companyId);
  const raw = req.body?.manual_open;
  if (!(raw === true || raw === false || raw === null)) {
    return res.status(400).json({ error: "manual_open deve ser true, false ou null" });
  }
  try {
    const updated = await service.setOpenStatus(companyId, raw);
    if (!updated) return res.status(404).json({ error: "Empresa não encontrada" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error setting open status:", error);
    return res.status(500).json({ error: "Failed to update open status" });
  }
};

module.exports = { find, findId, findAll, findProvidersCity, update, setOpenStatus };
