const service = require("../services/orderAutoAcceptService");

const getSettings = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }
  try {
    const data = await service.getSettings(Number(companyId));
    if (!data) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching order auto-accept settings:", error);
    return res.status(500).json({ error: "Failed to fetch auto-accept settings" });
  }
};

const updateSettings = async (req, res) => {
  const body = req.body || {};
  const companyId = body.company_id;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id is required" });
  }
  try {
    const data = await service.updateSettings(Number(companyId), body);
    if (!data) return res.status(404).json({ error: "Company not found" });
    return res.status(200).json(data);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error("Error saving order auto-accept settings:", error);
    return res.status(500).json({ error: "Failed to save auto-accept settings" });
  }
};

module.exports = { getSettings, updateSettings };
