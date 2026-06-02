const pool = require("../db");

const findAll = async () => {
  const result = await pool.query("SELECT * FROM menu_items ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM menu_items WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const findByCompany = async (id) => {
  const result = await pool.query(
    `SELECT mi.*, mc.name AS category_name
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.company_id = $1
     ORDER BY
       CASE
         WHEN mi.available = false THEN 2
         WHEN mi.featured = true THEN 0
         ELSE 1
       END,
       COALESCE(mi.display_order, mi.id) DESC`,
    [id],
  );
  return result.rows || null;
};

const create = async (data) => {
  const { company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku } = data;
  const result = await pool.query(
    `INSERT INTO menu_items
       (company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [company_id, category_id, name, description, price, available, image_url ?? null, featured ?? false, display_order ?? null, prep_time_minutes ?? null, sku ?? null],
  );
  return result.rows[0];
};

const update = async (data) => {
  const { id, company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku } = data;
  const result = await pool.query(
    `UPDATE menu_items
     SET company_id = $2, category_id = $3, name = $4, description = $5, price = $6,
         available = $7, image_url = $8, featured = $9, display_order = $10,
         prep_time_minutes = $11, sku = $12
     WHERE id = $1
     RETURNING *`,
    [id, company_id, category_id, name, description, price, available, image_url ?? null, featured ?? false, display_order ?? null, prep_time_minutes ?? null, sku ?? null],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM menu_items WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAll, find, findByCompany, create, update, remove };
