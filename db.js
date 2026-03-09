const { Pool } = require("pg");
require("dotenv").config();

const enviroment = process.env.ENVIROMENT || "development";

const pool = new Pool({
  ssl: enviroment === "development" ? false : { rejectUnauthorized: false },
  connectionString: process.env.POSTGRESQL_EXTERNAL_URL,
});

module.exports = pool;
