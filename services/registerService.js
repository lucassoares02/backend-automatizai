const pool = require("../db");
const { hashPassword } = require("../helpers/hash");
const axios = require("axios");

/**
 * Get All users
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM users ORDER BY id");
  return result.rows;
};

const find = async (cnpj) => {
  const result = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);

  return result.data || null;
};

const create = async (data) => {
  const { name, email, password } = data;
  const hashedPassword = await hashPassword(password);
  const result = await pool.query("INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING *", [name, email, hashedPassword]);
  return result.rows[0];
};

const createCompanies = async (data) => {
  const { name, description, phone, user, type } = data;

  // 1. Cria a empresa no PostgreSQL
  const result = await pool.query(
    `
    INSERT INTO companies (name, description, phone)
    VALUES ($1, $2, $3)
    RETURNING *
    `,
    [name, description, phone],
  );

  const company = result.rows[0];

  // 2. Cria relação usuário-empresa
  await pool.query(
    `
    INSERT INTO user_companies (user_id, company_id, relation_type)
    VALUES ($1, $2, $3)
    `,
    [user, company.id, type],
  );

  // O workflow do n8n NÃO é mais criado aqui. Ele é gerado sob demanda quando o
  // usuário inicia uma conexão do WhatsApp (connectionsController.create ->
  // n8nService.duplicate), que usa seu próprio template. Isso evita fluxos órfãos
  // para empresas que nunca conectam.
  return company;
};

// const createCompanies = async (data) => {
//   const { name, description, phone, user, type } = data;
//   const result = await pool.query("INSERT INTO companies (name, description, phone) VALUES ($1, $2, $3) RETURNING *", [name, description, phone]);

//   // add user-company relation if sucess
//   await pool.query("INSERT INTO user_companies (user_id, company_id, relation_type) VALUES ($1, $2, $3)", [user, result.rows[0].id, type]);

//   return result.rows[0];
// };

const update = async (data) => {
  // espera um objeto com propriedades em camelCase + id
  const { name, email, password, type } = data;
  const result = await pool.query("UPDATE users SET name = $1, email = $2, password = $3, type = $4 WHERE id = $5 RETURNING *", [
    name,
    email,
    password,
    type,
    id,
  ]);
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove, createCompanies };
