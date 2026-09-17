const service = require("../services/reportsService");

// Formata Date -> YYYY-MM-DD (data local do servidor).
const _fmt = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Relatório do período. Aceita ?from=YYYY-MM-DD&to=YYYY-MM-DD; sem datas,
// assume os últimos 7 dias (hoje inclusive).
const getReport = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }

  let { from, to } = req.query;
  if (!from || !to) {
    const today = new Date();
    const start = new Date();
    start.setDate(today.getDate() - 6);
    from = _fmt(start);
    to = _fmt(today);
  }

  if (!service.isValidDate(from) || !service.isValidDate(to)) {
    return res
      .status(400)
      .json({ error: "Datas inválidas. Use o formato YYYY-MM-DD." });
  }
  if (from > to) {
    return res
      .status(400)
      .json({ error: "A data inicial não pode ser maior que a final." });
  }

  try {
    const data = await service.getReport(companyId, from, to);
    if (!data) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching report:", error);
    return res.status(500).json({ error: "Failed to fetch report" });
  }
};

module.exports = { getReport };
