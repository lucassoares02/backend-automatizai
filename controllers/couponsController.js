const service = require("../services/couponsService");

const _cid = (req) =>
  Number(req.query.company_id ?? req.body?.company_id ?? req.params?.companyId);

const findByCompany = async (req, res) => {
  const companyId = _cid(req);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const rows = await service.findByCompany(companyId);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("coupons findByCompany:", err);
    return res.status(500).json({ error: "Failed to fetch coupons" });
  }
};

const create = async (req, res) => {
  const companyId = _cid(req);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const coupon = await service.create({ ...req.body, company_id: companyId });
    return res.status(201).json(coupon);
  } catch (err) {
    if (!err.status || err.status >= 500) console.error("coupons create:", err);
    return res
      .status(err.status || 400)
      .json({ error: err?.message || "Failed to create coupon" });
  }
};

const update = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _cid(req);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const coupon = await service.update(id, { ...req.body, company_id: companyId });
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    return res.status(200).json(coupon);
  } catch (err) {
    if (!err.status || err.status >= 500) console.error("coupons update:", err);
    return res
      .status(err.status || 400)
      .json({ error: err?.message || "Failed to update coupon" });
  }
};

const toggleStatus = async (req, res) => {
  const id = Number(req.params.id);
  const companyId = _cid(req);
  const { active } = req.body;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  if (typeof active !== "boolean") {
    return res.status(400).json({ error: "active must be boolean" });
  }
  try {
    const coupon = await service.toggleStatus(id, companyId, active);
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    return res.status(200).json(coupon);
  } catch (err) {
    console.error("coupons toggleStatus:", err);
    return res.status(500).json({ error: "Failed to toggle coupon" });
  }
};

const remove = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  try {
    const coupon = await service.remove(id);
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    return res.status(200).json({ message: "Coupon deleted", data: coupon });
  } catch (err) {
    console.error("coupons remove:", err);
    return res.status(500).json({ error: "Failed to delete coupon" });
  }
};

// Histórico de uso de um cupom.
const redemptions = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  try {
    const rows = await service.redemptions(id);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("coupons redemptions:", err);
    return res.status(500).json({ error: "Failed to fetch redemptions" });
  }
};

// Público: valida um código para uma empresa (não incrementa uso). Recebe o
// contexto do carrinho para segmentação (categoria/produto), escopo (subtotal x
// total) e vínculo ao cliente (cupom de aniversário).
const publicValidate = async (req, res) => {
  const companyId = Number(req.body?.company_id);
  const code = req.body?.code;
  const subtotal = Number(req.body?.subtotal ?? 0);
  const deliveryFee = Number(req.body?.delivery_fee ?? 0);
  const clientId = req.body?.client_id ? Number(req.body.client_id) : null;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "Invalid company_id" });
  }
  try {
    const result = await service.validate({
      companyId,
      code,
      clientId,
      subtotal,
      deliveryFee,
      items,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("coupons publicValidate:", err);
    return res.status(500).json({ error: "Failed to validate coupon" });
  }
};

module.exports = {
  findByCompany,
  create,
  update,
  toggleStatus,
  remove,
  redemptions,
  publicValidate,
};
