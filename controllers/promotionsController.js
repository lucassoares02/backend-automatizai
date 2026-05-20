const service = require("../services/promotionsService");

const _companyFromReq = (req) => Number(req.query.company_id ?? req.body?.company_id ?? req.params?.companyId);

const findByCompany = async (req, res) => {
  const companyId = _companyFromReq(req);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const rows = await service.findByCompany(companyId, req.query.active === "true");
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Error fetching promotions:", error);
    return res.status(500).json({ error: "Failed to fetch promotions" });
  }
};

const create = async (req, res) => {
  const companyId = _companyFromReq(req);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  if (!req.body?.name) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const created = await service.create({ ...req.body, company_id: companyId });
    return res.status(201).json(created);
  } catch (error) {
    console.error("Error creating promotion:", error);
    return res.status(500).json({ error: error?.message || "Failed to create promotion" });
  }
};

const update = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _companyFromReq(req);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const updated = await service.update(id, { ...req.body, company_id: companyId });
    if (!updated) return res.status(404).json({ error: "Promotion not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating promotion:", error);
    return res.status(500).json({ error: error?.message || "Failed to update promotion" });
  }
};

const remove = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _companyFromReq(req);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const deleted = await service.remove(id, companyId);
    if (!deleted) return res.status(404).json({ error: "Promotion not found" });
    return res.status(200).json({ message: "Promotion deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting promotion:", error);
    return res.status(500).json({ error: "Failed to delete promotion" });
  }
};

const toggleStatus = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _companyFromReq(req);
  const active = req.body?.active;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be boolean" });
  try {
    const updated = await service.toggleStatus(id, companyId, active);
    if (!updated) return res.status(404).json({ error: "Promotion not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error toggling promotion:", error);
    return res.status(500).json({ error: "Failed to toggle promotion" });
  }
};

module.exports = { findByCompany, create, update, remove, toggleStatus };
