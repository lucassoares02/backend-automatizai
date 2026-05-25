const service = require("../services/purchaseGoalsService");

const _int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const findByCompany = async (req, res) => {
  const companyId = _int(req.params.companyId);
  if (!companyId || companyId <= 0) return res.status(400).json({ error: "Invalid companyId" });
  try {
    const goals = await service.findByCompany(companyId);
    return res.status(200).json(goals);
  } catch (err) {
    console.error("purchaseGoals findByCompany:", err);
    return res.status(500).json({ error: "Failed to fetch purchase goals" });
  }
};

const create = async (req, res) => {
  try {
    const goal = await service.create(req.body);
    return res.status(201).json(goal);
  } catch (err) {
    console.error("purchaseGoals create:", err);
    return res.status(400).json({ error: err?.message || "Failed to create goal" });
  }
};

const update = async (req, res) => {
  const id = _int(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: "Invalid id" });
  try {
    const goal = await service.update(id, req.body);
    return res.status(200).json(goal);
  } catch (err) {
    console.error("purchaseGoals update:", err);
    return res.status(400).json({ error: err?.message || "Failed to update goal" });
  }
};

const setStatus = async (req, res) => {
  const id = _int(req.params.id);
  const companyId = _int(req.body?.company_id);
  if (!id || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!companyId || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const updated = await service.setStatus(id, companyId, !!req.body?.is_active);
    if (!updated) return res.status(404).json({ error: "Objetivo não encontrado" });
    return res.status(200).json(updated);
  } catch (err) {
    console.error("purchaseGoals setStatus:", err);
    return res.status(500).json({ error: "Failed to update status" });
  }
};

const remove = async (req, res) => {
  const id = _int(req.params.id);
  const companyId = _int(req.query.company_id ?? req.body?.company_id);
  if (!id || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!companyId || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const deleted = await service.remove(id, companyId);
    if (!deleted) return res.status(404).json({ error: "Objetivo não encontrado" });
    return res.status(200).json({ message: "Deleted", data: deleted });
  } catch (err) {
    console.error("purchaseGoals remove:", err);
    return res.status(500).json({ error: "Failed to delete goal" });
  }
};

const publicSuggest = async (req, res) => {
  const companyId = _int(req.body?.company_id);
  const categoryIds = Array.isArray(req.body?.category_ids) ? req.body.category_ids.map(_int).filter(Boolean) : [];
  const excludedProductIds = Array.isArray(req.body?.excluded_product_ids)
    ? req.body.excluded_product_ids.map(_int).filter(Boolean)
    : [];
  if (!companyId || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const result = await service.suggestNext(companyId, categoryIds, excludedProductIds);
    return res.status(200).json(result);
  } catch (err) {
    console.error("purchaseGoals publicSuggest:", err);
    return res.status(500).json({ error: "Failed to compute suggestion" });
  }
};

module.exports = { findByCompany, create, update, setStatus, remove, publicSuggest };
