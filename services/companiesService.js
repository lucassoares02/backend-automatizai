const pool = require("../db");

const find = async (id) => {
  const result = await pool.query(
    "select c.id, c.razao_social, c.cnpj, uc.relation_type from companies c join users_companies uc on uc.company_id = c.id where uc.user_id = $1",
    [id]
  );
  return result.rows || null;
};

const findId = async (id, company) => {
  const result = await pool.query(
    "select c.*, uc.relation_type from companies c join users_companies uc on uc.company_id = c.id where uc.user_id = $1 and uc.company_id = $2",
    [id, company]
  );
  return result.rows || null;
};

// const findProvidersCity = async (company) => {
//   const result = await pool.query(
//     "SELECT DISTINCT c.* FROM companies c JOIN routes r ON r.company_id = c.id JOIN route_cities rc ON rc.route_id = r.id JOIN companies c2 ON c2.codigo_municipio_ibge = rc.city_id WHERE c2.id = $1",
//     [company]
//   );
//   return result.rows || null;
// };

const findProvidersCity = async (company) => {
  const result = await pool.query(
    "SELECT c.*, MAX(o.id) AS order_id FROM companies c JOIN routes r ON r.company_id = c.id JOIN route_cities rc ON rc.route_id = r.id JOIN companies c2 ON c2.codigo_municipio_ibge = rc.city_id LEFT JOIN orders o ON o.supplier_id = c.id AND o.company_id = c2.id AND o.status = 'DRAFT' WHERE c2.id = $1 GROUP BY c.id;",
    [company]
  );
  return result.rows || null;
};

// update company
const update = async (company) => {
  const result = await pool.query("update companies set nome_fantasia = $1 where id = $2 RETURNING *", [company.nome_fantasia, company.id]);
  return result.rows[0];
};

module.exports = { find, findId, findProvidersCity, update };
