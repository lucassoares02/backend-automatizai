const pool = require("../db");

const findAllWithStats = async (companyId, search = "", filter = "all") => {
  const searchParam = search.trim() ? `%${search.trim()}%` : "";

  let filterWhere = "";
  let orderBy = "COALESCE(os.total_orders, 0) DESC, c.name ASC";

  switch (filter) {
    case "recurring":  filterWhere = "AND COALESCE(os.total_orders, 0) > 1"; break;
    case "new":        filterWhere = "AND c.created_at >= NOW() - INTERVAL '30 days'"; break;
    case "inactive":   filterWhere = "AND (os.last_order_at IS NULL OR os.last_order_at < NOW() - INTERVAL '60 days')"; break;
    case "high_value": filterWhere = "AND COALESCE(os.total_orders, 0) > 0"; orderBy = "COALESCE(os.total_spent, 0) DESC"; break;
  }

  const query = `
    WITH order_stats AS (
      SELECT
        o.client_id,
        COUNT(o.id)::int                                                              AS total_orders,
        COALESCE(SUM(CASE WHEN o.status NOT IN (6,7) THEN o.total ELSE 0 END),0)::float  AS total_spent,
        COALESCE(AVG(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS avg_ticket,
        COALESCE(MAX(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS max_order,
        MAX(o.created_at)                                                              AS last_order_at,
        MIN(o.created_at)                                                              AS first_order_at,
        COUNT(CASE WHEN o.status IN (6,7) THEN 1 END)::int                             AS cancelled_orders
      FROM orders o
      WHERE o.company_id = $1
      GROUP BY o.client_id
    )
    SELECT
      c.*,
      COALESCE(os.total_orders, 0)::int     AS total_orders,
      COALESCE(os.total_spent, 0)::float    AS total_spent,
      COALESCE(os.avg_ticket, 0)::float     AS avg_ticket,
      COALESCE(os.max_order, 0)::float      AS max_order,
      os.last_order_at,
      os.first_order_at,
      COALESCE(os.cancelled_orders, 0)::int AS cancelled_orders
    FROM clients c
    LEFT JOIN order_stats os ON os.client_id = c.id
    WHERE c.company_id = $1
      AND ($2 = '' OR c.name ILIKE $2 OR c.phone ILIKE $2)
      ${filterWhere}
    ORDER BY ${orderBy}
    LIMIT 200
  `;
  const result = await pool.query(query, [companyId, searchParam]);
  return result.rows;
};

const getSummary = async (companyId) => {
  const result = await pool.query(`
    WITH client_stats AS (
      SELECT
        c.id,
        c.created_at                                                                           AS client_created_at,
        COUNT(o.id)::int                                                                       AS order_count,
        COALESCE(SUM(CASE WHEN o.status NOT IN (6,7) THEN o.total ELSE 0 END), 0)::float      AS total_spent,
        MAX(o.created_at)                                                                      AS last_order_at
      FROM clients c
      LEFT JOIN orders o ON o.client_id = c.id AND o.company_id = $1
      WHERE c.company_id = $1
      GROUP BY c.id
    )
    SELECT
      COUNT(*)::int                                                                        AS total_clients,
      COUNT(*) FILTER (WHERE last_order_at >= NOW() - INTERVAL '30 days')::int            AS active_clients,
      COUNT(*) FILTER (WHERE client_created_at >= date_trunc('month', CURRENT_DATE))::int AS new_this_month,
      COUNT(*) FILTER (WHERE order_count > 1)::int                                        AS recurring_clients,
      COALESCE(AVG(NULLIF(total_spent, 0)), 0)::float                                     AS avg_spent_per_client
    FROM client_stats
  `, [companyId]);
  return result.rows[0];
};

const getDetails = async (clientId) => {
  const result = await pool.query(`
    WITH client_stats AS (
      SELECT
        o.client_id,
        COUNT(o.id)::int                                                              AS total_orders,
        COALESCE(SUM(CASE WHEN o.status NOT IN (6,7) THEN o.total ELSE 0 END),0)::float  AS total_spent,
        COALESCE(AVG(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS avg_ticket,
        COALESCE(MAX(CASE WHEN o.status NOT IN (6,7) THEN o.total END), 0)::float        AS max_order,
        MAX(o.created_at)                                                              AS last_order_at,
        MIN(o.created_at)                                                              AS first_order_at,
        COUNT(CASE WHEN o.status IN (6,7) THEN 1 END)::int                             AS cancelled_orders
      FROM orders o
      WHERE o.client_id = $1
      GROUP BY o.client_id
    )
    SELECT
      c.*,
      COALESCE(cs.total_orders, 0)::int     AS total_orders,
      COALESCE(cs.total_spent, 0)::float    AS total_spent,
      COALESCE(cs.avg_ticket, 0)::float     AS avg_ticket,
      COALESCE(cs.max_order, 0)::float      AS max_order,
      cs.last_order_at,
      cs.first_order_at,
      COALESCE(cs.cancelled_orders, 0)::int AS cancelled_orders,
      COALESCE(json_agg(
        json_build_object(
          'id',         o.id,
          'status',     o.status,
          'total',      o.total::float,
          'notes',      o.notes,
          'created_at', o.created_at,
          'items', (
            SELECT COALESCE(json_agg(json_build_object(
              'id',         oi.id,
              'name',       oi.item_name,
              'quantity',   oi.quantity,
              'unit_price', oi.item_price::float,
              'subtotal',   oi.subtotal::float
            ) ORDER BY oi.id), '[]'::json)
            FROM order_items oi WHERE oi.order_id = o.id
          )
        ) ORDER BY o.created_at DESC
      ) FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS orders
    FROM clients c
    LEFT JOIN client_stats cs ON cs.client_id = c.id
    LEFT JOIN orders o ON o.client_id = c.id
    WHERE c.id = $1
    GROUP BY c.id, cs.total_orders, cs.total_spent, cs.avg_ticket, cs.max_order,
             cs.last_order_at, cs.first_order_at, cs.cancelled_orders
  `, [clientId]);
  return result.rows[0] || null;
};

const find = async (id) => {
  const result = await pool.query("SELECT * FROM clients WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const create = async ({ company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code }) => {
  const result = await pool.query(
    `INSERT INTO clients (company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [company_id, name, phone ?? null, street ?? null, number ?? null, complement ?? null, neighborhood ?? null, city ?? null, state ?? null, zip_code ?? null],
  );
  return result.rows[0];
};

const update = async ({ id, name, phone, street, number, complement, neighborhood, city, state, zip_code }) => {
  const result = await pool.query(
    `UPDATE clients
     SET name = $2, phone = $3, street = $4, number = $5, complement = $6,
         neighborhood = $7, city = $8, state = $9, zip_code = $10, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, name, phone ?? null, street ?? null, number ?? null, complement ?? null, neighborhood ?? null, city ?? null, state ?? null, zip_code ?? null],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM clients WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findAllWithStats, getSummary, getDetails, find, create, update, remove };
