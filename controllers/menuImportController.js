const multer = require("multer");
const service = require("../services/menuImportService");

const MAX_URL_LENGTH = 2048;
const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];

const _upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    const error = new Error("Formato não suportado. Use PDF, JPG, PNG ou WEBP.");
    error.code = "INVALID_FILE";
    return cb(error);
  },
});

// Traduz os erros do multer em respostas 4xx (o handler global devolveria 500).
const upload = (req, res, next) => {
  _upload.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "FILE_TOO_LARGE", message: "O arquivo deve ter no máximo 10 MB." });
    }
    if (error.code === "INVALID_FILE") {
      return res.status(400).json({ error: "INVALID_FILE", message: error.message });
    }
    return res.status(400).json({ error: "INVALID_UPLOAD", message: "Não foi possível ler o arquivo enviado." });
  });
};

const _isValidUrl = (value) => {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// ─── POST /menu-import ──────────────────────────────────────────────────────

const importMenu = async (req, res) => {
  const companyId = parseInt(req.body?.company_id, 10);
  const url = (req.body?.url || "").toString().trim();
  const file = req.file
    ? // multer entrega o nome do arquivo em latin1; os acentos vêm em UTF-8.
      { ...req.file, originalname: Buffer.from(req.file.originalname, "latin1").toString("utf8") }
    : null;

  if (!companyId || Number.isNaN(companyId)) {
    return res.status(400).json({ error: "INVALID_COMPANY", message: "Empresa inválida." });
  }
  if (Boolean(file) === Boolean(url)) {
    return res.status(400).json({ error: "INVALID_SOURCE", message: "Envie um arquivo ou informe uma URL." });
  }
  if (url && !_isValidUrl(url)) {
    return res.status(400).json({ error: "INVALID_URL", message: "Informe uma URL válida, começando com http:// ou https://." });
  }

  try {
    await service.sendToWebhook({ companyId, url, file });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Falha ao enviar cardápio ao webhook:", error.message);
    return res.status(502).json({ error: "WEBHOOK_FAILED", message: "Não foi possível enviar o cardápio. Tente novamente." });
  }
};

module.exports = { upload, importMenu };
