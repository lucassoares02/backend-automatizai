const pool = require("../db");

/**
 * Get All company
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM company_addresses ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  // Pode haver linhas duplicadas legadas por empresa; o endereço vigente é
  // sempre o mais recente (mesmo critério usado no restante da API).
  const result = await pool.query(
    "SELECT * FROM company_addresses WHERE company_id = $1 ORDER BY id DESC LIMIT 1",
    [id],
  );
  return result.rows[0] || null;
};

const create = async (data) => {
  const { street, number, complement, neighborhood, city, state, zip_code, zipCode, company_id, latitude, longitude } = data;
  const result = await pool.query(
    `INSERT INTO company_addresses
      (street, number, complement, neighborhood, city, state, zip_code, company_id, latitude, longitude)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [street, number, complement, neighborhood, city, state, zip_code ?? zipCode, company_id,
     latitude || null, longitude || null],
  );
  return result.rows[0];
};

const update = async (data) => {
  const { id, street, number, complement, neighborhood, city, state, zip_code, latitude, longitude } = data;
  const result = await pool.query(
    `UPDATE company_addresses
     SET street = $1, number = $2, complement = $3, neighborhood = $4, city = $5,
         state = $6, zip_code = $7, latitude = $8, longitude = $9
     WHERE id = $10 RETURNING *`,
    [street, number, complement, neighborhood, city, state, zip_code,
     latitude || null, longitude || null, id],
  );
  return result.rows[0];
};

/**
 * Salva o endereço da empresa: atualiza o registro vigente (mais recente) ou
 * cria um novo quando ainda não existe. Ignora o `id` enviado pelo cliente para
 * não gerar duplicatas nem atualizar uma linha antiga.
 */
const saveForCompany = async (data) => {
  const current = await find(data.company_id);
  if (!current) return create(data);
  return update({ ...data, zip_code: data.zip_code ?? data.zipCode, id: current.id });
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM company_addresses WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, saveForCompany, remove };
