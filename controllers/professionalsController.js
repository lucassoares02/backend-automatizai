const service = require("../services/professionalsService");

const _fail = (res, error, fallback) => {
  if (!error.status) console.error(`${fallback}:`, error);
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback });
};

const _validId = (value) => value && !isNaN(value);

const findByCompany = async (req, res) => {
  const { companyId } = req.params;
  if (!_validId(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const onlyActive = String(req.query.active || "") === "true";
    return res.status(200).json(await service.findByCompany(companyId, { onlyActive }));
  } catch (error) {
    return _fail(res, error, "Failed to fetch professionals");
  }
};

const find = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Professional not found" });
    return res.status(200).json(item);
  } catch (error) {
    return _fail(res, error, "Failed to fetch professional");
  }
};

const create = async (req, res) => {
  const { company_id } = req.body || {};
  if (!_validId(company_id)) return res.status(400).json({ error: "Invalid company_id" });
  try {
    return res.status(201).json(await service.create(req.body));
  } catch (error) {
    return _fail(res, error, "Failed to create professional");
  }
};

const update = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const item = await service.update(id, req.body || {});
    if (!item) return res.status(404).json({ error: "Professional not found" });
    return res.status(200).json(item);
  } catch (error) {
    return _fail(res, error, "Failed to update professional");
  }
};

const remove = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const item = await service.remove(id);
    if (!item) return res.status(404).json({ error: "Professional not found" });
    return res.status(200).json({ message: "Professional removed", data: item });
  } catch (error) {
    return _fail(res, error, "Failed to remove professional");
  }
};

const updateServiceOverride = async (req, res) => {
  const { id, menuItemId } = req.params;
  if (!_validId(id) || !_validId(menuItemId)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const item = await service.updateServiceOverride(id, menuItemId, req.body || {});
    if (!item) return res.status(404).json({ error: "Service not linked to professional" });
    return res.status(200).json(item);
  } catch (error) {
    return _fail(res, error, "Failed to update professional service");
  }
};

const listTimeOff = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const includePast = String(req.query.past || "") === "true";
    return res.status(200).json(await service.listTimeOff(id, { includePast }));
  } catch (error) {
    return _fail(res, error, "Failed to fetch time off");
  }
};

const addTimeOff = async (req, res) => {
  const { id } = req.params;
  if (!_validId(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    return res.status(201).json(await service.addTimeOff(id, req.body || {}));
  } catch (error) {
    return _fail(res, error, "Failed to create time off");
  }
};

const removeTimeOff = async (req, res) => {
  const { id, timeOffId } = req.params;
  if (!_validId(id) || !_validId(timeOffId)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const item = await service.removeTimeOff(id, timeOffId);
    if (!item) return res.status(404).json({ error: "Time off not found" });
    return res.status(200).json({ message: "Time off removed", data: item });
  } catch (error) {
    return _fail(res, error, "Failed to remove time off");
  }
};

module.exports = {
  findByCompany,
  find,
  create,
  update,
  remove,
  updateServiceOverride,
  listTimeOff,
  addTimeOff,
  removeTimeOff,
};
