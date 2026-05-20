const service = require("../services/dashboardService");

const getDashboard = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }
  try {
    const data = await service.getDashboard(companyId);
    if (!data) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching dashboard:", error);
    return res.status(500).json({ error: "Failed to fetch dashboard" });
  }
};

module.exports = { getDashboard };
