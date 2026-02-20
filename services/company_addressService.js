const pool = require("../db");

/**
 * Get All company
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM company_addresses ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM company_addresses WHERE company_id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  const { street, number, complement, neighborhood, city, state, zipCode, company_id } = data;
  const result = await pool.query(
    "INSERT INTO company_addresses (street, number, complement, neighborhood, city, state, zip_code, company_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
    [street, number, complement, neighborhood, city, state, zipCode, company_id],
  );
  return result.rows[0];
};

const update = async (data) => {
  console.log(data.zipCode);
  const { id, street, number, complement, neighborhood, city, state, zip_code } = data;
  const result = await pool.query(
    "UPDATE company_addresses SET street = $1, number = $2, complement = $3, neighborhood = $4, city = $5, state = $6, zip_code = $7 WHERE id = $8 RETURNING *",
    [street, number, complement, neighborhood, city, state, zip_code, id],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM company_addresses WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove };
