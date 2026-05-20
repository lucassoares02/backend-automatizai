const multer = require("multer");
const service = require("../services/companiessssService");
const minio = require("./minioController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

/**
 * Get all Companiessss
 */
const findAll = async (req, res) => {
  try {
    const data = await service.findAll();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching Companiessss:", error);
    return res.status(500).json({ error: "Failed to fetch Companiessss" });
  }
};

/**
 * Get Companiessss by ID
 */
const find = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const item = await service.find(id);
    if (!item) return res.status(404).json({ error: "Companiessss not found" });
    return res.status(200).json(item);
  } catch (error) {
    console.error("Error fetching Companiessss by ID:", error);
    return res.status(500).json({ error: "Failed to fetch Companiessss" });
  }
};

/**
 * Create new Companiessss
 */
const create = async (req, res) => {
  const companiessss = req.body;
  if (!companiessss || Object.keys(companiessss).length === 0) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  try {
    const newItem = await service.create(companiessss);
    return res.status(201).json(newItem);
  } catch (error) {
    console.error("Error creating Companiessss:", error);
    return res.status(500).json({ error: "Failed to create Companiessss" });
  }
};

/**
 * Update Companiessss
 */
const update = async (req, res) => {
  const companiessss = req.body;
  const id = companiessss["id"];

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const updated = await service.update({ ...companiessss, id: parseInt(id) });
    if (!updated) return res.status(404).json({ error: "Companiessss not found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating Companiessss:", error);
    return res.status(500).json({ error: "Failed to update Companiessss" });
  }
};

/**
 * Delete Companiessss
 */
const remove = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const deleted = await service.remove(id);
    if (!deleted) return res.status(404).json({ error: "Companiessss not found" });
    return res.status(200).json({ message: "Companiessss deleted", data: deleted });
  } catch (error) {
    console.error("Error deleting Companiessss:", error);
    return res.status(500).json({ error: "Failed to delete Companiessss" });
  }
};

const uploadImage = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhuma imagem enviada" });
  const { buffer, originalname, mimetype } = req.file;
  const folder = req.query.type === "banner" ? "banners" : "logos";
  const ext = originalname.split(".").pop().toLowerCase();
  const filename = `companies/${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  try {
    const { url } = await minio.uploadFile(buffer, filename, mimetype);
    return res.status(200).json({ success: true, url });
  } catch (error) {
    console.error("Error uploading company image:", error);
    return res.status(500).json({ error: "Falha ao fazer upload da imagem" });
  }
};

module.exports = { findAll, find, create, update, remove, uploadImage, upload };
