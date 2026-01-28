const pool = require("../db");
const userService = require("../services/userService");
const { sendEmailSmtp } = require("../services/mailerService");
const { templateHtml } = require("./template_html.js");

// Get all users
exports.getAllUsers = async (req, res) => {
  console.log("Get Users");
  try {
    const users = await userService.getAllUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createUser = async (req, res) => {
  console.log("Create User");
  const { id, name, email, link, active } = req.body;
  const password = req.body.password || null;
  try {
    const result = await userService.createUser(name, email, password, active);

    const html = templateHtml;
    const replaceHtml = html.replaceAll("@name", name).replaceAll("@email", email).replaceAll("@link", link);

    await sendEmailSmtp(
      `"Fornecees" <${process.env.MAIL_FROM}>`,
      email,
      "Cadastro de Usuário",
      "Seu cadastro foi realizado com sucesso",
      replaceHtml
    );

    res.status(201).json(result);
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: err.message });
  }
};
