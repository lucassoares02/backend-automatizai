const pool = require("../db");

const _normalizePhone = (phone) => String(phone || "").replace(/\D/g, "");

/**
 * Rebuilds a cart payload from an existing order, resolving every product
 * and every option against the CURRENT menu state. Always returns up-to-date
 * names, images and prices — original snapshots in `order_item_options` are
 * used only when the option no longer exists, so the customer can see what
 * is no longer available.
 *
 * @returns {Object} { valid_items, unavailable, totals_preview }
 */
const reorder = async ({ orderId, phone }) => {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Invalid order id"), { status: 400 });
  }

  // 1) Order + ownership check
  const orderRes = await pool.query(
    `SELECT o.id, o.company_id, c.phone AS client_phone
     FROM orders o JOIN clients c ON c.id = o.client_id
     WHERE o.id = $1`,
    [id],
  );
  const order = orderRes.rows[0];
  if (!order) {
    throw Object.assign(new Error("Order not found"), { status: 404 });
  }
  if (phone) {
    const a = _normalizePhone(order.client_phone);
    const b = _normalizePhone(phone);
    if (a && b && a !== b) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
  }

  // 2) Load original lines (with options snapshots in a single roundtrip)
  const linesRes = await pool.query(
    `SELECT
       oi.id, oi.menu_item_id, oi.item_name, oi.quantity, oi.notes,
       oi.promotion_id, oi.promotion_group_key,
       COALESCE((
         SELECT json_agg(
           json_build_object(
             'group_id', oio.group_id,
             'group_name', oio.group_name,
             'option_id', oio.option_id,
             'option_name', oio.option_name,
             'additional_price', oio.additional_price,
             'quantity', oio.quantity
           ) ORDER BY oio.id
         ) FROM order_item_options oio WHERE oio.order_item_id = oi.id
       ), '[]'::json) AS options
     FROM order_items oi
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [id],
  );
  const lines = linesRes.rows;
  if (lines.length === 0) {
    return { valid_items: [], unavailable: [], totals_preview: { subtotal: 0 } };
  }

  // 3) Bulk fetch current menu items + option groups/items so we only hit the
  //    database 3 times regardless of how many lines are in the order.
  const menuItemIds = [
    ...new Set(lines.map((l) => l.menu_item_id).filter(Boolean)),
  ];
  const menuRes = menuItemIds.length
    ? await pool.query(
        `SELECT id, company_id, name, description, price, image_url, available
         FROM menu_items
         WHERE id = ANY($1::int[])`,
        [menuItemIds],
      )
    : { rows: [] };
  const menuById = new Map(menuRes.rows.map((r) => [r.id, r]));

  const groupsRes = menuItemIds.length
    ? await pool.query(
        `SELECT g.id, g.product_id, g.name, g.type, g.min_selection, g.max_selection, g.is_required
         FROM product_option_groups g
         WHERE g.product_id = ANY($1::int[])`,
        [menuItemIds],
      )
    : { rows: [] };
  const groupsByProduct = new Map();
  const groupById = new Map();
  for (const g of groupsRes.rows) {
    groupById.set(g.id, g);
    if (!groupsByProduct.has(g.product_id)) groupsByProduct.set(g.product_id, []);
    groupsByProduct.get(g.product_id).push(g);
  }

  const optionIds = lines.flatMap((l) =>
    (l.options || []).map((o) => o.option_id).filter(Boolean),
  );
  const groupIdsFromOpts = lines.flatMap((l) =>
    (l.options || []).map((o) => o.group_id).filter(Boolean),
  );
  const itemsRes = optionIds.length
    ? await pool.query(
        `SELECT i.id, i.group_id, i.name, i.additional_price, i.is_active
         FROM product_option_items i
         WHERE i.id = ANY($1::int[])
            OR i.group_id = ANY($2::int[])`,
        [[...new Set(optionIds)], [...new Set(groupIdsFromOpts)]],
      )
    : { rows: [] };
  const optionById = new Map(itemsRes.rows.map((r) => [r.id, r]));

  // 4) Resolve every line against current state
  const valid_items = [];
  const unavailable = [];

  for (const line of lines) {
    const product = line.menu_item_id ? menuById.get(line.menu_item_id) : null;
    if (!product) {
      unavailable.push({
        name: line.item_name,
        quantity: line.quantity,
        reason: "product_removed",
        message: "Produto não está mais no cardápio",
      });
      continue;
    }
    if (Number(product.company_id) !== Number(order.company_id)) {
      unavailable.push({
        name: line.item_name,
        quantity: line.quantity,
        reason: "wrong_company",
        message: "Produto pertence a outra empresa",
      });
      continue;
    }
    if (product.available === false) {
      unavailable.push({
        name: product.name || line.item_name,
        quantity: line.quantity,
        reason: "product_unavailable",
        image_url: product.image_url,
        message: "Indisponível no momento",
      });
      continue;
    }

    // Resolve options using current state
    const resolvedOptions = [];
    const droppedOptions = [];
    let optionsBroken = false;

    for (const opt of line.options || []) {
      const currentItem = opt.option_id ? optionById.get(opt.option_id) : null;
      if (!currentItem || currentItem.is_active === false) {
        droppedOptions.push({
          group_name: opt.group_name,
          option_name: opt.option_name,
        });
        // If the parent group is required and this drop leaves no valid
        // alternative selected in the same group → flag the whole item.
        const group = currentItem ? groupById.get(currentItem.group_id) : null;
        if (group && group.is_required) {
          optionsBroken = true;
        }
        continue;
      }
      const group = groupById.get(currentItem.group_id);
      const qty = Math.max(1, Number(opt.quantity ?? 1));
      resolvedOptions.push({
        group_id: currentItem.group_id,
        group_name: group ? group.name : opt.group_name,
        option_id: currentItem.id,
        option_name: currentItem.name,
        additional_price: Number(currentItem.additional_price ?? 0),
        quantity: qty,
      });
    }

    if (optionsBroken) {
      unavailable.push({
        name: product.name || line.item_name,
        quantity: line.quantity,
        reason: "options_unavailable",
        image_url: product.image_url,
        message: "Algumas opções obrigatórias não existem mais. Refaça a escolha.",
      });
      continue;
    }

    const basePrice = Number(product.price ?? 0);
    const extraPerUnit = resolvedOptions.reduce(
      (s, o) => s + Number(o.additional_price) * Number(o.quantity),
      0,
    );
    const unitPrice = Number((basePrice + extraPerUnit).toFixed(2));
    const subtotal = Number((unitPrice * line.quantity).toFixed(2));

    valid_items.push({
      menu_item_id: product.id,
      name: product.name,
      description: product.description,
      image_url: product.image_url,
      base_price: basePrice,
      unit_price: unitPrice,
      quantity: line.quantity,
      notes: line.notes,
      options: resolvedOptions,
      dropped_options: droppedOptions, // optionals that disappeared
      subtotal,
    });
  }

  const subtotalPreview = valid_items.reduce((s, i) => s + i.subtotal, 0);

  return {
    order_id: id,
    company_id: order.company_id,
    valid_items,
    unavailable,
    totals_preview: {
      subtotal: Number(subtotalPreview.toFixed(2)),
      items_count: valid_items.length,
      unavailable_count: unavailable.length,
    },
  };
};

module.exports = { reorder };
