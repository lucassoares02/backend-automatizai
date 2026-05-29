const pool = require("../db");
const { comparePassword, hashPassword } = require("../helpers/hash");

const findUserByEmail = async (email) => {
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  console.log("Result", result);
  return result.rows[0];
};

const findPrimaryCompanyId = async (userId) => {
  const result = await pool.query(
    `SELECT company_id
     FROM user_companies
     WHERE user_id = $1
     ORDER BY company_id
     LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.company_id ?? null;
};

const validateLogin = async (email, password) => {
  const user = await findUserByEmail(email);
  if (!user) throw new Error("User not found");

  const passwordMatch = await comparePassword(password, user.password);
  if (!passwordMatch) throw new Error("Invalid credentials");

  const { password: _, ...userWithoutPassword } = user;
  userWithoutPassword.company = await findPrimaryCompanyId(user.id);

  return userWithoutPassword;
};

const getAllUsers = async () => {
  // const result = await pool.query('SELECT * FROM users');
  const result = await pool.query(`SELECT * from users ORDER BY id DESC`);
  return result.rows;
};

const createUser = async (name, email, password, active) => {
  const hashedPassword = await hashPassword(password);
  const result = await pool.query("INSERT INTO users (name, email, password,active) VALUES ($1, $2, $3,$4) RETURNING *", [
    name,
    email,
    hashedPassword,
    active,
  ]);
  return result.rows[0];
};

module.exports = { findUserByEmail, validateLogin, getAllUsers, createUser, findPrimaryCompanyId };
