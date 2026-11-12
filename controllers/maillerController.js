const service = require("../services/passwordEmailService");

const GENERIC_FORGOT_MESSAGE = "Se o e-mail estiver cadastrado, você receberá uma nova senha em instantes.";

/**
 * POST /send-email — "Esqueci a senha" (público, rate-limited).
 * Body: { email }. Gera uma senha nova e envia para o e-mail cadastrado.
 * Responde sempre a mesma mensagem, exista o e-mail ou não, e faz o envio
 * depois da resposta (o tempo de resposta também não revela nada).
 */
exports.sendEmail = async (req, res) => {
  const email = service.normalizeEmail(req.body?.email);
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Informe um e-mail válido" });
  }

  res.status(200).json({ message: GENERIC_FORGOT_MESSAGE });

  try {
    await service.requestForgotPassword(email);
  } catch (err) {
    console.error("Erro ao enviar e-mail de recuperação:", err.message);
  }
};

/**
 * POST /users/:id/send-access — gera senha nova e envia o acesso ao usuário.
 * Exige admin; admin de conta só alcança usuários das empresas dele.
 */
exports.sendAccess = async (req, res) => {
  const id = /^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : null;
  if (!id) return res.status(400).json({ error: "Usuário inválido" });

  try {
    const user = await service.findUserById(id);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    if (!req.isSystemAdmin && !(await service.sharesCompany(id, req.userCompanies))) {
      return res.status(403).json({ error: "Acesso negado a este usuário" });
    }

    const info = await service.resetAndSend(user, "access");
    return res.status(200).json({ message: "E-mail enviado com sucesso", messageId: info?.messageId });
  } catch (err) {
    console.error("Erro ao enviar e-mail de acesso:", err.message);
    return res.status(500).json({ error: "Erro ao enviar e-mail" });
  }
};
