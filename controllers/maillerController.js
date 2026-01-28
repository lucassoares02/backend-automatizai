const dotenv = require("dotenv");
const pool = require("../db");
const { hashPassword } = require("../helpers/hash");
const { sendEmailSmtp } = require("../services/mailerService");

dotenv.config(); // carrega variáveis de .env

/**
 * Envia um e-mail.
 *
 * @param {string|string[]} to     Destinatário(s). Pode ser string ou array de strings.
 * @param {string}          subject Assunto do e-mail.
 * @param {string}          html    Conteúdo HTML do e-mail.
 * @param {string}          [text]  Conteúdo em texto puro (fallback).
 */
exports.sendEmail = async (req, res) => {
  const { id, subject, html, text, link, email } = req.body;

  user = null;

  if (id != null && id != "null") {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    user = result.rows[0];
  } else if (email != null && email != "null") {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    user = result.rows[0];
  }

  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado" });
  }

  const randomPassword = Math.random().toString(36).slice(-8);
  const decodedPassword = await hashPassword(randomPassword);
  await pool.query("UPDATE users SET password = $1 WHERE id = $2 RETURNING *", [decodedPassword, id]);

  console.log("Senha atualizada para o usuário:", user.id, "Nova senha:", randomPassword);

  const replaceHtml = html
    .replaceAll("@name", user.name)
    .replaceAll("@email", user.email)
    .replaceAll("@password", randomPassword)
    .replaceAll("@link", link);

  const info = await sendEmailSmtp(`"Portal Associados" <${process.env.MAIL_FROM}>`, user.email, subject, text, replaceHtml);

  console.log("E-mail enviado:", info.messageId);
  return res.status(200).json({ message: "E-mail enviado com sucesso", messageId: info.messageId });
};
