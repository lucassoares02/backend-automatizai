const pool = require("../db");
const { hashPassword } = require("../helpers/hash");
const axios = require("axios");
const base = require("../templates/base.json");

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

  const title_flow = `${company.id} - ${name}`;

  // 3. Monta o payload do workflow do n8n
  const workflowPayload = base;
  workflowPayload["name"] = title_flow;
  workflowPayload["nodes"][2]["parameters"]["url"] = `https://backend-automatizai.onrender.com/api/companies/${company.id}`;

  console.log("Payload do workflow:", JSON.stringify(workflowPayload, null, 2));

  // 4. Envia para o n8n
  await axios.post(`${process.env.URL_N8N}workflows`, workflowPayload, {
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": process.env.TOKEN_N8N,
    },
  });

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
