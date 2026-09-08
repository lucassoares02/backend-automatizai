const service = require("../services/orderStatusNotificationService");

const findByCompany = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }
  try {
    const data = await service.findByCompany(Number(companyId));
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching order status notifications:", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch order status notifications" });
  }
};

const upsert = async (req, res) => {
  const body = req.body || {};
  const companyId = body.company_id;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "company_id is required" });
  }
  if (!Array.isArray(body.items)) {
    return res.status(400).json({ error: "items must be an array" });
  }
  try {
    const data = await service.upsertMany(Number(companyId), body.items);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error saving order status notifications:", error);
    return res
      .status(500)
      .json({ error: "Failed to save order status notifications" });
  }
};

module.exports = { findByCompany, upsert };
