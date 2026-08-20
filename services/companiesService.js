const pool = require("../db");

// Lista TODAS as lojas (uso do admin do sistema no switcher do header).
// Nome amigável: prioriza nome_fantasia e cai em razao_social; aliasado como
// `razao_social` para reaproveitar o CompaniesModel do Portal.
const findAllCompanies = async () => {
  const result = await pool.query(
    `SELECT id,
            COALESCE(NULLIF(TRIM(nome_fantasia), ''), razao_social) AS razao_social,
            cnpj
       FROM companies
      ORDER BY COALESCE(NULLIF(TRIM(nome_fantasia), ''), razao_social) ASC NULLS LAST`,
  );
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query(
    `SELECT
       c.*,
       cp.max_distance_meters_delivery,
       cp.kilometer_price,
       cp.max_distance_meters_free_delivery,
       cp.min_price_order,
       cp.min_tax_delivery,
       cp.accepts_orders_outside_delivery_area
     FROM companies c
     JOIN user_companies uc ON uc.company_id = c.id
     LEFT JOIN LATERAL (
       SELECT
         max_distance_meters_delivery,
         kilometer_price,
         max_distance_meters_free_delivery,
         min_price_order,
         min_tax_delivery,
         COALESCE(
           (to_jsonb(company_preferences)->>'accepts_orders_outside_delivery_area')::boolean,
           false
         ) AS accepts_orders_outside_delivery_area
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
       cp.min_tax_delivery,
       cp.accepts_orders_outside_delivery_area
     FROM companies c
     LEFT JOIN LATERAL (
       SELECT
         max_distance_meters_delivery,
         kilometer_price,
         max_distance_meters_free_delivery,
         min_price_order,
         min_tax_delivery,
         COALESCE(
           (to_jsonb(company_preferences)->>'accepts_orders_outside_delivery_area')::boolean,
           false
         ) AS accepts_orders_outside_delivery_area
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

// Override manual de aberto/fechado. `manualOpen`: true|false força; null segue horário.
const setOpenStatus = async (companyId, manualOpen) => {
  const result = await pool.query(
    "UPDATE companies SET manual_open = $1 WHERE id = $2 RETURNING id, manual_open",
    [manualOpen, companyId],
  );
  return result.rows[0] || null;
};

module.exports = { find, findId, findAllCompanies, findProvidersCity, update, setOpenStatus };
