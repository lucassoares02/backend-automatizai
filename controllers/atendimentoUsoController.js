const service = require("../services/atendimentoUsoService");

// Resolve o negócio da requisição. O company_id vem da sessão (user_companies,
// carregado pelo authMiddleware em req.userCompanies). Quem tem mais de um
// negócio informa ?company_id=, que só é aceito se pertencer à usuária.
// Retorna null quando não dá para resolver/autorizar.
const resolveCompanyId = (req) => {
  const raw = req.query.company_id;
  const list = (Array.isArray(req.userCompanies) ? req.userCompanies : []).map(Number);

  if (raw === undefined || raw === "") {
    return list.length === 1 ? list[0] : null;
  }

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (req.isService || req.isSystemAdmin || list.includes(id)) return id;
  return null;
};

// GET /atendimento/uso?mes=YYYY-MM[&company_id=N]
const getUsage = async (req, res) => {
  const companyId = resolveCompanyId(req);
  if (!companyId) {
    return res.status(403).json({ error: "Acesso negado a esta empresa" });
  }

  const current = service.currentMonth();
  const month = req.query.mes || current;
  if (!service.isValidMonth(month)) {
    return res.status(400).json({ error: "Mês inválido. Use o formato YYYY-MM." });
  }
  if (month > current) {
    return res.status(400).json({ error: "O mês não pode ser futuro." });
  }

  try {
    const data = await service.getUsage(companyId, month);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching atendimento usage:", error);
    return res.status(500).json({ error: "Failed to fetch atendimento usage" });
  }
};

module.exports = { getUsage, _testing: { resolveCompanyId } };
