// Envio de senha por e-mail ("Esqueci a senha" e "Enviar acesso").
// A rota gera uma senha nova, grava o hash e manda a senha em texto só no e-mail.
// Template, assunto e link são montados aqui; nada disso vem do cliente, para a
// rota não servir de relay de phishing com o remetente oficial.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { hashPassword } = require("../helpers/hash");
const { sendEmailSmtp } = require("./mailerService");

const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "access_email.html");

const KINDS = {
  forgot: { subject: "Recuperação de Senha", text: "E-mail de recuperação de senha." },
  access: { subject: "E-mail de acesso a plataforma", text: "E-mail de acesso a plataforma." },
};

// Um e-mail de recuperação por endereço a cada 5 min: sem isso, quem souber o
// e-mail da vítima consegue trocar a senha dela em sequência.
const FORGOT_COOLDOWN_MS = 5 * 60 * 1000;
const forgotCooldown = new Map();

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const generatePassword = (length = 12) => {
  let out = "";
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const portalUrl = () => (process.env.PORTAL_APP_URL || process.env.ORIGIN || "").replace(/\/$/, "");

let cachedTemplate = null;
const loadTemplate = () => {
  if (cachedTemplate == null) cachedTemplate = fs.readFileSync(TEMPLATE_PATH, "utf8");
  return cachedTemplate;
};

// Substituição em uma passada só: um nome com "@password" não puxa a senha.
const renderEmail = ({ template, name, email, password, link }) => {
  const values = { name, email, password, link };
  return template.replace(/@(name|email|password|link)\b/g, (_, key) => escapeHtml(values[key]));
};

const normalizeEmail = (email) => (typeof email === "string" ? email.trim().toLowerCase() : "");

const findUserByEmail = async (email) => {
  const result = await pool.query("SELECT id, name, email FROM users WHERE LOWER(email) = $1 LIMIT 1", [email]);
  return result.rows[0] || null;
};

const findUserById = async (id) => {
  const result = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
};

// Admin de conta só envia acesso para usuários de uma empresa à qual também
// está vinculado; admin do sistema envia para qualquer um.
const sharesCompany = async (userId, companyIds) => {
  const ids = (Array.isArray(companyIds) ? companyIds : []).map(Number).filter(Number.isSafeInteger);
  if (!ids.length) return false;
  const result = await pool.query(
    "SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = ANY($2::int[]) LIMIT 1",
    [userId, ids],
  );
  return result.rowCount > 0;
};

const resetAndSend = async (user, kind, deps = {}) => {
  const {
    hash = hashPassword,
    updatePassword = (id, hashed) => pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashed, id]),
    send = sendEmailSmtp,
    template = loadTemplate(),
  } = deps;
  const { subject, text } = KINDS[kind];
  const password = generatePassword();
  // Grava antes de enviar: se o envio falhar, o usuário pede de novo; o inverso
  // mandaria por e-mail uma senha que não vale.
  await updatePassword(user.id, await hash(password));
  const html = renderEmail({ template, name: user.name, email: user.email, password, link: portalUrl() });
  return send(`"Portal Associados" <${process.env.MAIL_FROM}>`, user.email, subject, text, html);
};

/**
 * "Esqueci a senha". Nunca revela se o e-mail existe: quem chama sempre
 * responde a mesma coisa, e o trabalho roda depois da resposta.
 */
const requestForgotPassword = async (rawEmail, deps = {}) => {
  const { findUser = findUserByEmail, now = Date.now(), cooldown = forgotCooldown } = deps;
  const email = normalizeEmail(rawEmail);
  if (!email) return { sent: false, reason: "invalid" };

  const last = cooldown.get(email);
  if (last && now - last < FORGOT_COOLDOWN_MS) return { sent: false, reason: "cooldown" };
  cooldown.set(email, now);

  const user = await findUser(email);
  if (!user) return { sent: false, reason: "not_found" };

  await resetAndSend(user, "forgot", deps);
  return { sent: true };
};

// Limpeza do cooldown para o Map não crescer sem limite.
setInterval(() => {
  const limit = Date.now() - FORGOT_COOLDOWN_MS;
  for (const [email, at] of forgotCooldown) if (at <= limit) forgotCooldown.delete(email);
}, 60 * 1000).unref?.();

module.exports = {
  KINDS,
  FORGOT_COOLDOWN_MS,
  generatePassword,
  escapeHtml,
  renderEmail,
  normalizeEmail,
  findUserById,
  sharesCompany,
  resetAndSend,
  requestForgotPassword,
};
