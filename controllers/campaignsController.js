const service = require("../services/campaignsService");

const findByCompany = async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const rows = await service.findByCompany(companyId);
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Campaigns list error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao listar campanhas" });
  }
};

const find = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const companyId = Number(req.query.company_id || req.companyId);
    const row = await service.find(id, companyId);
    if (!row) return res.status(404).json({ error: "Campanha não encontrada" });
    return res.status(200).json(row);
  } catch (error) {
    console.error("Campaign get error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao obter campanha" });
  }
};

const audiencePreview = async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const result = await service.audiencePreview(companyId, {
      audience_type: req.query.audience_type,
      audience_limit: req.query.audience_limit,
      inactive_days: req.query.inactive_days,
      client_ids: req.query.client_ids ? String(req.query.client_ids).split(",").map(Number) : [],
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Campaign audience preview error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao calcular público" });
  }
};

const create = async (req, res) => {
  try {
    const result = await service.create(req.body);
    return res.status(201).json(result);
  } catch (error) {
    console.error("Campaign create error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao criar campanha" });
  }
};

const update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const companyId = Number(req.body.company_id);
    const result = await service.update(id, companyId, req.body);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Campaign update error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao atualizar campanha" });
  }
};

const dispatch = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await service.dispatchCampaign(id);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Campaign dispatch error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao disparar campanha" });
  }
};

const remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const companyId = Number(req.query.company_id);
    const result = await service.remove(id, companyId);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Campaign delete error:", error.message);
    return res.status(error.status || 500).json({ error: error.message || "Falha ao remover campanha" });
  }
};

// Callback do n8n (Basic Auth com WEBHOOK_N8N_USER/PASS). Atualiza os
// campaign_clients com o status/mensagem/horário de envio decididos pela IA.
const webhookReport = async (req, res) => {
  const auth = req.headers["authorization"] || "";
  const expected = `Basic ${Buffer.from(
    `${process.env.WEBHOOK_N8N_USER}:${process.env.WEBHOOK_N8N_PASS}`,
  ).toString("base64")}`;
  if (auth !== expected) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  try {
    const items = Array.isArray(req.body) ? req.body : req.body.items;
    const result = await service.reportFromWebhook(items);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Campaign webhook report error:", error.message);
    return res.status(500).json({ error: "Falha ao processar report" });
  }
};

module.exports = { findByCompany, find, audiencePreview, create, update, dispatch, remove, webhookReport };
