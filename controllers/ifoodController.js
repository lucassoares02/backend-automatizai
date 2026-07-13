const service = require("../services/ifoodService");

// ─── GET /ifood/merchant/:companyId ─────────────────────────────────────────────
// Retorna o perfil iFood salvo (merchant id + nome cacheado + status de conexão).
const getMerchant = async (req, res) => {
  const companyId = parseInt(req.params.companyId, 10);
  if (!companyId || Number.isNaN(companyId)) {
    return res.status(400).json({ error: "INVALID_COMPANY", message: "companyId inválido." });
  }
  try {
    const data = await service.getSavedMerchant(companyId);
    return res.status(200).json(data);
  } catch (error) {
    console.error("iFood getMerchant error:", error.message);
    return res.status(error.status || 500).json({ error: error.code || "UNKNOWN", message: error.message });
  }
};

// ─── POST /ifood/merchant ───────────────────────────────────────────────────────
// Salva/atualiza o perfil (merchant id) informado pelo comerciante.
// Body: { company_id, merchant_id }  (merchant_id vazio desvincula)
const saveMerchant = async (req, res) => {
  const companyId = parseInt(req.body?.company_id ?? req.body?.companyId, 10);
  const merchantId = req.body?.merchant_id ?? req.body?.merchantId ?? "";
  if (!companyId || Number.isNaN(companyId)) {
    return res.status(400).json({ error: "INVALID_COMPANY", message: "company_id inválido." });
  }
  try {
    const data = await service.saveMerchant(companyId, merchantId);
    return res.status(200).json(data);
  } catch (error) {
    console.error("iFood saveMerchant error:", error.message);
    return res.status(error.status || 500).json({ error: error.code || "UNKNOWN", message: error.message });
  }
};

// ─── GET /ifood/consult/:companyId ──────────────────────────────────────────────
// Consulta consolidada na API do iFood: nome, produtos e pedidos.
const consult = async (req, res) => {
  const companyId = parseInt(req.params.companyId, 10);
  if (!companyId || Number.isNaN(companyId)) {
    return res.status(400).json({ error: "INVALID_COMPANY", message: "companyId inválido." });
  }
  try {
    const data = await service.consult(companyId);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    console.error("iFood consult error:", error.message, error.detail || "");
    return res.status(error.status || 500).json({ error: error.code || "UNKNOWN", message: error.message });
  }
};

module.exports = { getMerchant, saveMerchant, consult };
