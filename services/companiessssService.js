const pool = require("../db");

/**
 * Get All companies
 */
const findAll = async () => {
  const result = await pool.query("SELECT * FROM companies ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM companies WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async (data) => {
  // espera um objeto com propriedades em camelCase (ex: { someField: 'x' })
  const { id, name, description, status, phone } = data;
  const result = await pool.query("INSERT INTO companies (id, name, description, status, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *", [
    id,
    name,
    description,
    status,
    phone,
  ]);
  return result.rows[0];
};

const update = async (data) => {
  const {
    id, name, description, status, phone,
    logo_url, brand_color, banner_url,
    ai_name, ai_gender, ai_personality, cuisine_type, dietary_restrictions,
    max_distance_meters_delivery,
    kilometer_price,
    max_distance_meters_free_delivery,
    min_price_order,
    min_tax_delivery,
  } = data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const companyRes = await client.query(
      `UPDATE companies SET
         name = $2, description = $3, status = $4, phone = $5,
         logo_url = $6, brand_color = $7, banner_url = $8,
         ai_name = $9, ai_gender = $10, ai_personality = $11,
         cuisine_type = $12, dietary_restrictions = $13
       WHERE id = $1 RETURNING *`,
      [
        id, name, description, status, phone,
        logo_url ?? null, brand_color ?? null, banner_url ?? null,
        ai_name ?? null, ai_gender ?? null, ai_personality ?? null,
        cuisine_type ?? null, dietary_restrictions ?? null,
      ],
    );

    const prefPayload = {
      max_distance_meters_delivery:
        max_distance_meters_delivery === undefined
          ? null
          : max_distance_meters_delivery,
      kilometer_price: kilometer_price === undefined ? null : kilometer_price,
      max_distance_meters_free_delivery:
        max_distance_meters_free_delivery === undefined
          ? null
          : max_distance_meters_free_delivery,
      min_price_order: min_price_order === undefined ? null : min_price_order,
      min_tax_delivery: min_tax_delivery === undefined ? null : min_tax_delivery,
    };

    const hasAnyPreference = Object.values(prefPayload).some((v) => v !== null);
    if (hasAnyPreference) {
      const existing = await client.query(
        `SELECT id
         FROM company_preferences
         WHERE company_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [id],
      );

      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE company_preferences SET
             max_distance_meters_delivery = $2,
             kilometer_price = $3,
             max_distance_meters_free_delivery = $4,
             min_price_order = $5,
             min_tax_delivery = $6
           WHERE id = $1`,
          [
            existing.rows[0].id,
            prefPayload.max_distance_meters_delivery,
            prefPayload.kilometer_price,
            prefPayload.max_distance_meters_free_delivery,
            prefPayload.min_price_order,
            prefPayload.min_tax_delivery,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO company_preferences
             (company_id, max_distance_meters_delivery, kilometer_price, max_distance_meters_free_delivery, min_price_order, min_tax_delivery)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            prefPayload.max_distance_meters_delivery,
            prefPayload.kilometer_price,
            prefPayload.max_distance_meters_free_delivery,
            prefPayload.min_price_order,
            prefPayload.min_tax_delivery,
          ],
        );
      }
    }

    await client.query("COMMIT");
    return companyRes.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM companies WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, create, update, remove };
