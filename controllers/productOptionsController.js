const service = require("../services/productOptionsService");

const _int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const findByProduct = async (req, res) => {
  const productId = _int(req.params.productId);
  if (!productId || productId <= 0) return res.status(400).json({ error: "Invalid productId" });
  try {
    const groups = await service.findByProduct(productId);
    return res.status(200).json(groups);
  } catch (err) {
    console.error("productOptions findByProduct:", err);
    return res.status(500).json({ error: "Failed to fetch product options" });
  }
};

const publicFindByProduct = async (req, res) => {
  const productId = _int(req.params.productId);
  if (!productId || productId <= 0) return res.status(400).json({ error: "Invalid productId" });
  try {
    const groups = await service.findByProduct(productId, { onlyActive: true });
    return res.status(200).json(groups);
  } catch (err) {
    console.error("productOptions publicFindByProduct:", err);
    return res.status(500).json({ error: "Failed to fetch product options" });
  }
};

const create = async (req, res) => {
  try {
    const group = await service.create(req.body);
    return res.status(201).json(group);
  } catch (err) {
    console.error("productOptions create:", err);
    return res.status(400).json({ error: err?.message || "Failed to create group" });
  }
};

const update = async (req, res) => {
  const groupId = _int(req.params.groupId);
  if (!groupId || groupId <= 0) return res.status(400).json({ error: "Invalid groupId" });
  try {
    const group = await service.update(groupId, req.body);
    return res.status(200).json(group);
  } catch (err) {
    console.error("productOptions update:", err);
    return res.status(400).json({ error: err?.message || "Failed to update group" });
  }
};

const remove = async (req, res) => {
  const groupId = _int(req.params.groupId);
  const companyId = _int(req.query.company_id ?? req.body?.company_id);
  if (!groupId || groupId <= 0) return res.status(400).json({ error: "Invalid groupId" });
  if (!companyId || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const deleted = await service.remove(groupId, companyId);
    if (!deleted) return res.status(404).json({ error: "Group not found" });
    return res.status(200).json({ message: "Deleted", data: deleted });
  } catch (err) {
    console.error("productOptions remove:", err);
    return res.status(500).json({ error: "Failed to delete group" });
  }
};

const reorder = async (req, res) => {
  const productId = _int(req.params.productId);
  const companyId = _int(req.body?.company_id);
  const orderedIds = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids.map(_int).filter(Boolean) : [];
  if (!productId || productId <= 0) return res.status(400).json({ error: "Invalid productId" });
  if (!companyId || companyId <= 0) return res.status(400).json({ error: "Invalid company_id" });
  try {
    const groups = await service.reorder(productId, companyId, orderedIds);
    return res.status(200).json(groups);
  } catch (err) {
    console.error("productOptions reorder:", err);
    return res.status(500).json({ error: "Failed to reorder groups" });
  }
};

module.exports = { findByProduct, publicFindByProduct, create, update, remove, reorder };
