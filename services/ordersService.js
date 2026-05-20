const pool = require("../db");
const STATUS_IN_PROGRESS = [1, 2, 3, 4, 8];
const STATUS_COMPLETED = [5, 9];
const STATUS_CANCELLED = [6, 7];

const ORDER_SELECT = `
  SELECT o.*,
         c.name  AS client_name,
         c.phone AS client_phone,
         COALESCE(json_agg(oi ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
  FROM orders o
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN order_items oi ON oi.order_id = o.id
`;

const findByCompany = async (companyId) => {
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.company_id = $1
     GROUP BY o.id, c.name, c.phone
     ORDER BY o.created_at DESC`,
    [companyId],
  );
  return result.rows;
};

const findTodayByCompany = async (companyId) => {
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.company_id = $1
       AND o.created_at::date = CURRENT_DATE
     GROUP BY o.id, c.name, c.phone
     ORDER BY o.created_at DESC`,
    [companyId],
  );
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.id = $1
     GROUP BY o.id, c.name, c.phone`,
    [id],
  );
  return result.rows[0] || null;
};

const summarize = async (companyId) => {
  const result = await pool.query(
    `WITH latest_status AS (
       SELECT DISTINCT ON (order_id)
         order_id,
         CASE WHEN status ~ '^[0-9]+$' THEN status::int ELSE NULL END AS status_code
       FROM order_status_history
       ORDER BY order_id, created_at DESC
     )
     SELECT
       COUNT(*)                                                                                        AS total,
       COUNT(*) FILTER (WHERE o.created_at::date = CURRENT_DATE)                                      AS today,
       COUNT(*) FILTER (WHERE ls.status_code IS NULL OR ls.status_code = ANY($2::int[])) AS in_progress,
       COUNT(*) FILTER (WHERE ls.status_code = ANY($3::int[]))                             AS completed,
       COUNT(*) FILTER (WHERE ls.status_code = ANY($4::int[]))                             AS cancelled
     FROM orders o
     LEFT JOIN latest_status ls ON ls.order_id = o.id
     WHERE o.company_id = $1`,
    [companyId, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_CANCELLED],
  );
  return result.rows[0];
};

const create = async (data) => {
  const { company_id, client_id, notes, items, payment_method_id, delivery_address, delivery_type, tag } = data;

  const delivery_fee = Number(data.delivery_fee ?? 0);
  const discount = Number(data.discount ?? 0);
  const subtotal = items.reduce((sum, i) => sum + Number(i.subtotal), 0);
  const total = subtotal + delivery_fee - discount;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderRes = await client.query(
      `INSERT INTO orders
         (company_id, client_id, status, notes, subtotal, delivery_fee, discount, total,
          payment_method_id, delivery_address, delivery_type, tag)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        company_id,
        client_id,
        notes ?? null,
        subtotal,
        delivery_fee,
        discount,
        total,
        payment_method_id ?? null,
        delivery_address ?? null,
        delivery_type ?? null,
        tag ?? null,
      ],
    );
    const order = orderRes.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.menu_item_id ?? null, item.name, item.quantity, item.unit_price, item.subtotal],
      );
    }

    await client.query("COMMIT");
    return await find(order.id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const updateStatus = async (id, status, cancelReason) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE orders
       SET status = $2,
           cancel_reason = CASE WHEN $2 = ANY($4::int[]) THEN $3 ELSE cancel_reason END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, cancelReason ?? null, STATUS_CANCELLED],
    );

    const order = result.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO order_status_history (order_id, status, notes)
       VALUES ($1, $2, $3)`,
      [id, String(status), cancelReason ?? null],
    );

    await client.query("COMMIT");
    return order;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM orders WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = { findByCompany, findTodayByCompany, find, summarize, create, updateStatus, remove };
