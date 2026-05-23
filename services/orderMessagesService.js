const pool = require("../db");

const listMessages = async (orderId) => {
  const result = await pool.query(
    `SELECT id, order_id, company_id, sender_type, sender_name, message, is_read, created_at
     FROM order_messages
     WHERE order_id = $1
     ORDER BY created_at ASC`,
    [orderId],
  );
  return result.rows;
};

const verifyOrderPhone = async (orderId, phone) => {
  const result = await pool.query(
    `SELECT o.id FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.id = $1 AND c.phone = $2`,
    [orderId, phone],
  );
  return result.rows.length > 0;
};

const getOrderCompanyId = async (orderId) => {
  const result = await pool.query("SELECT company_id FROM orders WHERE id = $1", [orderId]);
  return result.rows[0]?.company_id ?? null;
};

const sendCustomerMessage = async (orderId, companyId, senderName, message) => {
  const result = await pool.query(
    `INSERT INTO order_messages (order_id, company_id, sender_type, sender_name, message)
     VALUES ($1, $2, 'customer', $3, $4)
     RETURNING *`,
    [orderId, companyId, senderName, message],
  );
  return result.rows[0];
};

const sendCompanyMessage = async (orderId, companyId, senderName, message) => {
  const result = await pool.query(
    `INSERT INTO order_messages (order_id, company_id, sender_type, sender_name, message, is_read)
     VALUES ($1, $2, 'company', $3, $4, true)
     RETURNING *`,
    [orderId, companyId, senderName, message],
  );
  return result.rows[0];
};

const markAsRead = async (orderId, companyId) => {
  await pool.query(
    `UPDATE order_messages
     SET is_read = true
     WHERE order_id = $1 AND company_id = $2 AND sender_type = 'customer' AND is_read = false`,
    [orderId, companyId],
  );
};

module.exports = {
  listMessages,
  verifyOrderPhone,
  getOrderCompanyId,
  sendCustomerMessage,
  sendCompanyMessage,
  markAsRead,
};
