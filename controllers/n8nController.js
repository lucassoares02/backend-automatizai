const service = require("../services/n8nReportsService");

// ─── Controller dedicado às requisições consumidas pelo n8n ───────────────────
// Ponto de entrada para as integrações que o n8n faz contra a nossa API.
// Novas rotas do n8n devem ser adicionadas aqui, delegando a lógica ao service.

/**
 * GET /api/n8n/company/:companyId/daily-summary
 *
 * Resumo diário da empresa: hora atual, média das últimas 4 semanas no mesmo dia
 * da semana vs. hoje, nome do dono, horário de funcionamento, cardápio (ativos e
 * desativados) e data de cadastro ("ativo desde").
 *
 * Aceita `?tz=` (timezone IANA) para o cálculo de "hoje"/dia da semana.
 * Protegida por `authMiddleware` — aceita a API Key de serviço (`x-api-key`).
 */
const dailySummary = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }

  const tz = typeof req.query.tz === "string" && req.query.tz.trim() ? req.query.tz.trim() : undefined;

  try {
    const data = await service.getDailySummary(companyId, tz);
    if (!data) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error building n8n daily summary:", error);
    return res.status(500).json({ error: "Failed to build daily summary" });
  }
};

module.exports = { dailySummary };
