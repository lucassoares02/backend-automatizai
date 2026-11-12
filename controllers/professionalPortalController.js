const multer = require("multer");
const service = require("../services/professionalPortalService");
const minio = require("./minioController");

// Fotos do atendimento: o portal já reduz a imagem antes do envio; o limite
// aqui é só a rede de proteção.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Tipo de arquivo não suportado"));
  },
});

const NOT_FOUND = { error: "Atendimento não encontrado." };

const _handleError = (res, error, label) => {
  if (error?.status && error.status < 500) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.status === 503) return res.status(503).json({ error: error.message, code: error.code });
  console.error(`Error ${label}:`, error);
  return res.status(500).json({ error: "Não foi possível concluir a ação." });
};

// Página pública do profissional (por token, sem auth): clientes + ações.
const listAppointments = async (req, res) => {
  try {
    const data = await service.listAppointments(req.params.token);
    if (!data) return res.status(404).json({ error: "Link do profissional não encontrado." });
    return res.status(200).json(data);
  } catch (error) {
    return _handleError(res, error, "listing professional appointments");
  }
};

const _action = (fn, label) => async (req, res) => {
  const { token, appointmentId } = req.params;
  if (!appointmentId || isNaN(appointmentId)) return res.status(400).json({ error: "Invalid appointment ID" });
  try {
    const result = await fn(token, Number(appointmentId), req.body || {});
    if (!result) return res.status(404).json(NOT_FOUND);
    return res.status(200).json(result);
  } catch (error) {
    return _handleError(res, error, label);
  }
};

const start = _action((token, id) => service.startAppointment(token, id), "starting appointment");
const complete = _action(
  (token, id, body) => service.completeAppointment(token, id, body.comment),
  "completing appointment",
);
const noShow = _action((token, id) => service.markNoShow(token, id), "marking no-show");
const reopen = _action((token, id) => service.reopenAppointment(token, id), "reopening appointment");

const addPhoto = async (req, res) => {
  const { token, appointmentId } = req.params;
  if (!appointmentId || isNaN(appointmentId)) return res.status(400).json({ error: "Invalid appointment ID" });
  if (!req.file) return res.status(400).json({ error: "Nenhuma imagem enviada" });
  try {
    const photo = await service.addPhoto(token, Number(appointmentId), req.file, (buffer, filename, mime) =>
      minio.uploadFile(buffer, filename, mime),
    );
    if (!photo) return res.status(404).json(NOT_FOUND);
    return res.status(201).json(photo);
  } catch (error) {
    return _handleError(res, error, "uploading appointment photo");
  }
};

const removePhoto = async (req, res) => {
  const { token, appointmentId, photoId } = req.params;
  if (!appointmentId || isNaN(appointmentId) || !photoId || isNaN(photoId)) {
    return res.status(400).json({ error: "Invalid ID" });
  }
  try {
    const result = await service.removePhoto(token, Number(appointmentId), Number(photoId));
    if (!result) return res.status(404).json({ error: "Foto não encontrada." });
    return res.status(200).json(result);
  } catch (error) {
    return _handleError(res, error, "removing appointment photo");
  }
};

module.exports = { upload, listAppointments, start, complete, noShow, reopen, addPhoto, removePhoto };
