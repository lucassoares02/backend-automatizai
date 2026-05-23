const service = require("../services/upsellService");

const _cid = (req) => Number(req.query.company_id ?? req.body?.company_id ?? req.params?.companyId);

const findByCompany = async (req, res) => {
  const companyId = _cid(req);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const rows = await service.findByCompany(companyId);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("upsell findByCompany:", err);
    return res.status(500).json({ error: "Failed to fetch upsell rules" });
  }
};

const create = async (req, res) => {
  const companyId = _cid(req);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const rule = await service.create({ ...req.body, company_id: companyId });
    return res.status(201).json(rule);
  } catch (err) {
    console.error("upsell create:", err);
    return res.status(400).json({ error: err?.message || "Failed to create upsell rule" });
  }
};

const update = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _cid(req);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const rule = await service.update(id, { ...req.body, company_id: companyId });
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    return res.status(200).json(rule);
  } catch (err) {
    console.error("upsell update:", err);
    return res.status(400).json({ error: err?.message || "Failed to update upsell rule" });
  }
};

const toggleStatus = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _cid(req);
  const { active } = req.body;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be boolean" });
  try {
    const rule = await service.toggleStatus(id, companyId, active);
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    return res.status(200).json(rule);
  } catch (err) {
    console.error("upsell toggleStatus:", err);
    return res.status(500).json({ error: "Failed to toggle upsell rule" });
  }
};

const duplicate = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _cid(req);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const rule = await service.duplicate(id, companyId);
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    return res.status(201).json(rule);
  } catch (err) {
    console.error("upsell duplicate:", err);
    return res.status(500).json({ error: "Failed to duplicate upsell rule" });
  }
};

const remove = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _cid(req);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const deleted = await service.remove(id, companyId);
    if (!deleted) return res.status(404).json({ error: "Rule not found" });
    return res.status(200).json({ message: "Upsell rule deleted", data: deleted });
  } catch (err) {
    console.error("upsell remove:", err);
    return res.status(500).json({ error: "Failed to delete upsell rule" });
  }
};

// Public — no auth required
const getSuggestions = async (req, res) => {
  const companyId = Number(req.query.company_id);
  const triggerItemId = Number(req.query.trigger_item_id);
  if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  if (!Number.isInteger(triggerItemId) || triggerItemId <= 0) return res.status(400).json({ error: "Invalid trigger_item_id" });
  try {
    const data = await service.getSuggestions(companyId, triggerItemId);
    if (!data) return res.status(200).json(null);
    return res.status(200).json(data);
  } catch (err) {
    console.error("upsell getSuggestions:", err);
    return res.status(500).json({ error: "Failed to get upsell suggestions" });
  }
};

module.exports = { findByCompany, create, update, toggleStatus, duplicate, remove, getSuggestions };
