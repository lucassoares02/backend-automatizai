const multer = require("multer");
const service = require("../services/menuImportService");

const MAX_URL_LENGTH = 2048;
const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const _upload = multer({
  storage: multer.memoryStorage(),
  // O multer aplica um único teto; o limite menor das imagens é conferido em `upload`.
  // O +1 é porque ele recusa o arquivo ao atingir o teto, e 50 MB exatos são permitidos.
  limits: { fileSize: MAX_PDF_BYTES + 1 },
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
    if (!error) {
      if (req.file && req.file.mimetype !== "application/pdf" && req.file.size > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: "FILE_TOO_LARGE", message: "A imagem deve ter no máximo 10 MB." });
      }
      return next();
    }
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "FILE_TOO_LARGE", message: "O arquivo deve ter no máximo 50 MB." });
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

  let result;
  try {
    result = await service.sendToWebhook({ companyId, url, file });
  } catch (error) {
    console.error("Falha ao extrair cardápio no webhook:", error.message);
    if (["UNSUPPORTED_VERSION", "COMPANY_MISMATCH", "INVALID_PACKAGE"].includes(error.code)) {
      return res.status(502).json({ error: error.code, message: "O extrator devolveu um formato inesperado. Tente novamente." });
    }
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    return res.status(502).json({
      error: timedOut ? "WEBHOOK_TIMEOUT" : "WEBHOOK_FAILED",
      message: timedOut
        ? "A leitura do cardápio demorou demais. Tente com um arquivo menor ou menos páginas."
        : "Não foi possível ler o cardápio. Tente novamente.",
    });
  }

  // 422: nada aproveitável; o motivo vem em review.issues.
  if (result.status === 422) {
    const issue = (result.pack.review?.issues || [])[0];
    return res.status(422).json({
      error: "NO_MENU",
      code: issue?.code || null,
      message: issue?.message || "Não encontramos um cardápio nesse arquivo ou link.",
      pack: result.pack,
    });
  }

  try {
    const context = await service.buildPreviewContext(companyId, result.pack);
    return res.status(200).json({ success: true, pack: result.pack, context });
  } catch (error) {
    console.error("Falha ao montar a prévia da importação:", error.message);
    return res.status(200).json({ success: true, pack: result.pack, context: null });
  }
};

// ─── POST /menu-import/confirm ─────────────────────────────────────────────
// Recebe o pacote já conferido pelo dono e grava tudo numa transação.

const confirmImport = async (req, res) => {
  const companyId = Number(req.body?.company_id);
  const pack = req.body?.pack;
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: "INVALID_COMPANY", message: "Empresa inválida." });
  }

  try {
    const summary = await service.applyPackage(companyId, pack, { applyCompany: req.body?.apply_company !== false });
    return res.status(200).json({ success: true, ...summary });
  } catch (error) {
    if (["UNSUPPORTED_VERSION", "COMPANY_MISMATCH", "INVALID_PACKAGE"].includes(error.code)) {
      return res.status(400).json({ error: error.code, message: error.message });
    }
    if (error.status && error.status < 500) {
      return res.status(error.status).json({ error: error.code, message: error.message, ref: error.ref ?? null });
    }
    console.error("Falha ao gravar a importação de cardápio:", error);
    return res.status(500).json({ error: "IMPORT_FAILED", message: "Não foi possível importar o cardápio. Nada foi gravado." });
  }
};

module.exports = { upload, importMenu, confirmImport };
