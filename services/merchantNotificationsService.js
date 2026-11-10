const pool = require("../db");
const { tableExists } = require("../helpers/schema");

const TYPES = Object.freeze({
  PAYMENT_DECLINED: "subscription_payment_declined",
  PAUSED: "subscription_paused",
  RESUMED: "subscription_resumed",
  CANCELED: "subscription_canceled",
  ENDED: "subscription_ended",
  APPOINTMENTS_CANCELED: "subscription_appointments_canceled",
});

const notify = async ({ companyId, type, title, message, subscriptionId, orderId, eventKey }) => {
  if (!companyId || !eventKey) return false;
  try {
    if (!(await tableExists("merchant_notifications"))) return false;
    await pool.query(
      `INSERT INTO merchant_notifications
         (company_id, type, title, message, subscription_id, order_id, event_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_key) DO NOTHING`,
      [companyId, type, title, message, subscriptionId || null, orderId || null, eventKey],
    );
    return true;
  } catch (error) {
    console.error("notificações de assinatura: falha ao registrar", { event_key: eventKey, message: error.message });
    return false;
  }
};

const listForCompany = async (companyId, { unreadOnly = false, limit = 50 } = {}) => {
  if (!(await tableExists("merchant_notifications"))) return { notifications: [], unread_count: 0 };
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const result = await pool.query(
    `SELECT id, type, title, message, subscription_id, order_id, read_at, created_at
       FROM merchant_notifications
      WHERE company_id = $1 AND ($2::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [Number(companyId), unreadOnly, boundedLimit],
  );
  const count = await pool.query(
    "SELECT COUNT(*)::int AS count FROM merchant_notifications WHERE company_id = $1 AND read_at IS NULL",
    [Number(companyId)],
  );
  return { notifications: result.rows, unread_count: count.rows[0]?.count || 0 };
};

const markRead = async (companyId, notificationId) => {
  const result = await pool.query(
    `UPDATE merchant_notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND company_id = $2
      RETURNING id, type, title, message, subscription_id, order_id, read_at, created_at`,
    [Number(notificationId), Number(companyId)],
  );
  return result.rows[0] || null;
};

module.exports = { TYPES, notify, listForCompany, markRead };
