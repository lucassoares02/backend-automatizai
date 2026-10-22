const service = require("../services/technicalSheetService");

const _id = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const find = async (req, res) => {
  const id = _id(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const result = await service.find(id);
    if (!result) return res.status(404).json({ error: "Produto não encontrado" });
    return res.status(200).json(result);
  } catch (err) {
    console.error("technicalSheet find:", err);
    return res.status(500).json({ error: "Failed to fetch technical sheet" });
  }
};

const save = async (req, res) => {
  const id = _id(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const result = await service.save(id, req.body || {});
    if (!result) return res.status(404).json({ error: "Produto não encontrado" });
    return res.status(200).json(result);
  } catch (err) {
    // Validação (400) e migração pendente (503) já trazem mensagem para o usuário.
    if (err?.status === 400 || err?.status === 503) return res.status(err.status).json({ error: err.message });
    console.error("technicalSheet save:", err);
    return res.status(500).json({ error: "Failed to save technical sheet" });
  }
};

module.exports = { find, save };
