const DEFAULT_WEBHOOK_URL = "https://n8n.arbian.com.br/webhook/cardapio-digital";
const FETCH_TIMEOUT_MS = 180000;

// Basic Auth do webhook n8n (mesmas credenciais dos demais webhooks).
const _webhookAuthHeader = () => {
  const u = process.env.WEBHOOK_N8N_USER;
  const p = process.env.WEBHOOK_N8N_PASS;
  if (!u && !p) return null;
  return `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
};

// Encaminha o cardápio ao n8n como multipart/form-data: campos `company_id`,
// `source` ("file" | "url"), `url` (quando houver) e o binário em `file`.
const sendToWebhook = async ({ companyId, url, file }) => {
  const form = new FormData();
  form.append("company_id", String(companyId));
  form.append("source", file ? "file" : "url");
  if (url) form.append("url", url);
  if (file) {
    form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  }

  const auth = _webhookAuthHeader();
  const res = await fetch(process.env.MENU_IMPORT_WEBHOOK_URL || DEFAULT_WEBHOOK_URL, {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
};

module.exports = { sendToWebhook };
