const service = require("../services/deliveryDriversService");

const findByCompany = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const onlyActive = String(req.query.active || "") === "true";
    const drivers = await service.findByCompany(companyId, { onlyActive });
    return res.status(200).json(drivers);
  } catch (error) {
    console.error("Error fetching delivery drivers:", error);
    return res.status(500).json({ error: "Failed to fetch delivery drivers" });
  }
};

const create = async (req, res) => {
  const { company_id, name } = req.body || {};
  if (!company_id || isNaN(company_id)) return res.status(400).json({ error: "Invalid company_id" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
  try {
    const driver = await service.create({ ...req.body, name: String(name).trim() });
    return res.status(201).json(driver);
  } catch (error) {
    console.error("Error creating delivery driver:", error);
    return res.status(500).json({ error: "Failed to create delivery driver" });
  }
};

const update = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const driver = await service.update(id, req.body || {});
    if (!driver) return res.status(404).json({ error: "Delivery driver not found" });
    return res.status(200).json(driver);
  } catch (error) {
    console.error("Error updating delivery driver:", error);
    return res.status(500).json({ error: "Failed to update delivery driver" });
  }
};

const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const driver = await service.remove(id);
    if (!driver) return res.status(404).json({ error: "Delivery driver not found" });
    return res.status(200).json({ message: "Delivery driver removed", data: driver });
  } catch (error) {
    console.error("Error removing delivery driver:", error);
    return res.status(500).json({ error: "Failed to remove delivery driver" });
  }
};

module.exports = { findByCompany, create, update, remove };
