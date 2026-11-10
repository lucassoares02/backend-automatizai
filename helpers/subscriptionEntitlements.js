const { columnExists, tableExists } = require("./schema");
const { normalizePhone } = require("./phone");

const _ready = async () =>
  (await tableExists("customer_subscriptions")) &&
  (await tableExists("subscription_included_items")) &&
  (await columnExists("menu_items", "subscription_enabled")) &&
  (await columnExists("subscription_included_items", "free_quantity_per_cycle")) &&
  (await columnExists("order_items", "subscription_id"));

/**
 * Active included-item balances, keyed by catalog item. A benefit is consumed
 * only by order lines linked to the subscription and created in its current
 * billing cycle. When lock=true, subscription rows serialize concurrent orders.
 */
const loadIncludedBenefits = async (
  db,
  { companyId, clientId = null, customerUserId = null, phone = null, itemIds = null, lock = false },
) => {
  if (!(await _ready())) return new Map();
  const normalizedPhone = normalizePhone(phone);
  const localPhone = normalizedPhone?.startsWith("55") ? normalizedPhone.slice(2) : null;
  const values = [
    companyId,
    customerUserId || null,
    clientId || null,
    normalizedPhone,
    localPhone,
    Array.isArray(itemIds) ? itemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0) : null,
  ];
  const fromAndWhere = `
    FROM customer_subscriptions cs
    JOIN menu_items plan ON plan.id = cs.menu_item_id AND plan.company_id = cs.company_id
    JOIN subscription_included_items sii ON sii.subscription_item_id = plan.id
    WHERE cs.company_id = $1 AND cs.status = 'active' AND plan.subscription_enabled = TRUE
      AND ($6::int[] IS NULL OR sii.included_item_id = ANY($6::int[]))
      AND (($2::uuid IS NOT NULL AND cs.user_id = $2)
        OR ($3::int IS NOT NULL AND cs.client_id = $3)
        OR ($4::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM clients c
           WHERE c.company_id = cs.company_id
             AND (c.id = cs.client_id OR c.user_id = cs.user_id)
             AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') IN ($4, $5)
        )))`;

  if (lock) {
    await db.query(
      `SELECT cs.id ${fromAndWhere} ORDER BY cs.id FOR UPDATE OF cs`,
      values,
    );
  }

  const result = await db.query(
    `SELECT cs.id AS subscription_id, cs.current_cycle_start, cs.created_at AS subscription_created_at,
            sii.included_item_id, sii.free_quantity_per_cycle,
            COALESCE((
              SELECT SUM(oi.quantity)::int
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
               WHERE oi.subscription_id = cs.id
                 AND oi.menu_item_id = sii.included_item_id
                 AND o.created_at >= COALESCE(cs.current_cycle_start, cs.created_at)
                 AND o.status NOT IN (6, 7)
            ), 0) AS used_quantity
       ${fromAndWhere}
       ORDER BY cs.id, sii.included_item_id`,
    values,
  );

  const byItem = new Map();
  for (const row of result.rows) {
    const itemId = Number(row.included_item_id);
    const limit = Math.max(0, Number(row.free_quantity_per_cycle) || 0);
    const used = Math.max(0, Number(row.used_quantity) || 0);
    const remaining = Math.max(0, limit - used);
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    if (remaining > 0) {
      byItem.get(itemId).push({
        subscriptionId: Number(row.subscription_id),
        remaining,
      });
    }
  }
  return byItem;
};

module.exports = { loadIncludedBenefits };
