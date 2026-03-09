const { Pool } = require("pg");
require("dotenv").config();

const enviroment = process.env.ENVIROMENT || "development";

const pool = new Pool({
  // ssl: false,
  connectionString: process.env.POSTGRESQL_EXTERNAL_URL,
  ssl: enviroment === "development" ? { rejectUnauthorized: false } : undefined, // para Render
});

module.exports = pool;
