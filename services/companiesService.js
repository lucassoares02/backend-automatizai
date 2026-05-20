const pool = require("../db");

const find = async (id) => {
  const result = await pool.query(
    `SELECT
       c.*,
       cp.max_distance_meters_delivery,
       cp.kilometer_price,
       cp.max_distance_meters_free_delivery,
       cp.min_price_order,
       cp.min_tax_delivery
     FROM companies c
     JOIN user_companies uc ON uc.company_id = c.id
     LEFT JOIN LATERAL (
       SELECT
         max_distance_meters_delivery,
         kilometer_price,
         max_distance_meters_free_delivery,
         min_price_order,
         min_tax_delivery
       FROM company_preferences
       WHERE company_id = c.id
       ORDER BY id DESC
       LIMIT 1
     ) cp ON true
     WHERE uc.user_id = $1`,
    [id],
  );
  return result.rows || null;
};

const findId = async (id, company) => {
  const result = await pool.query(
    `SELECT
       c.*,
       cp.max_distance_meters_delivery,
       cp.kilometer_price,
       cp.max_distance_meters_free_delivery,
       cp.min_price_order,
       cp.min_tax_delivery
     FROM companies c
     LEFT JOIN LATERAL (
       SELECT
         max_distance_meters_delivery,
         kilometer_price,
         max_distance_meters_free_delivery,
         min_price_order,
         min_tax_delivery
       FROM company_preferences
       WHERE company_id = c.id
       ORDER BY id DESC
       LIMIT 1
     ) cp ON true
     WHERE c.id = $1`,
    [company],
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
    [company],
  );
  return result.rows || null;
};

// update company
const update = async (company) => {
  const result = await pool.query("update companies set nome_fantasia = $1 where id = $2 RETURNING *", [company.nome_fantasia, company.id]);
  return result.rows[0];
};

module.exports = { find, findId, findProvidersCity, update };
