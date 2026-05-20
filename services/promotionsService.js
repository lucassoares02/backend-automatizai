const pool = require("../db");

const normalizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      menu_item_id: Number(it.menu_item_id),
      quantity: Number(it.quantity ?? 1),
    }))
    .filter((it) => Number.isInteger(it.menu_item_id) && it.menu_item_id > 0 && Number.isFinite(it.quantity) && it.quantity > 0);
};

const computePricing = ({ originalTotal, discountPercent, finalPrice }) => {
  const original = Number(originalTotal ?? 0);
  if (original <= 0) throw new Error("Promotion must have products with valid price");

  const hasPercent = discountPercent !== null && discountPercent !== undefined;
  const hasFinal = finalPrice !== null && finalPrice !== undefined;

  let pct = 0;
  let final = original;

  if (hasPercent && hasFinal) {
    final = Number(finalPrice);
    pct = Number(discountPercent);
  } else if (hasPercent) {
    pct = Number(discountPercent);
    final = original * (1 - pct / 100);
  } else if (hasFinal) {
    final = Number(finalPrice);
    pct = ((original - final) / original) * 100;
  }

  if (!Number.isFinite(pct) || pct < 0) throw new Error("Discount cannot be negative");
  if (!Number.isFinite(final) || final < 0) throw new Error("Final price is invalid");
  if (final > original) throw new Error("Final price cannot be greater than original");

  return {
    original_price: Number(original.toFixed(2)),
    final_price: Number(final.toFixed(2)),
    discount_percent: Number(pct.toFixed(2)),
  };
};

const buildItems = async (companyId, items) => {
  const normalized = normalizeItems(items);
  if (normalized.length === 0) throw new Error("Promotion must include at least one product");

  const ids = normalized.map((i) => i.menu_item_id);
  const priceRes = await pool.query(
    `SELECT id, name, price, image_url
     FROM menu_items
     WHERE company_id = $1 AND id = ANY($2::int[])`,
    [companyId, ids],
  );

  const byId = new Map(priceRes.rows.map((r) => [r.id, r]));
  const detailed = normalized.map((item) => {
    const product = byId.get(item.menu_item_id);
    if (!product) throw new Error(`Product ${item.menu_item_id} does not belong to this company`);
    const unit = Number(product.price ?? 0);
    const subtotal = unit * item.quantity;
    return {
      menu_item_id: item.menu_item_id,
      quantity: item.quantity,
      item_name: product.name,
      unit_price: unit,
      image_url: product.image_url ?? null,
      subtotal,
    };
  });

  const originalTotal = detailed.reduce((sum, i) => sum + i.subtotal, 0);
  return { detailed, originalTotal };
};

const findByCompany = async (companyId, onlyActive = false) => {
  const whereActive = onlyActive ? " AND p.active = true" : "";
  const result = await pool.query(
    `SELECT p.*,
            COALESCE(json_agg(json_build_object(
              'id', pi.id,
              'menu_item_id', pi.menu_item_id,
              'quantity', pi.quantity,
              'item_name', mi.name,
              'unit_price', mi.price,
              'image_url', mi.image_url,
              'subtotal', (COALESCE(mi.price, 0) * pi.quantity)
            ) ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
     FROM promotions p
     LEFT JOIN promotion_items pi ON pi.promotion_id = p.id
     LEFT JOIN menu_items mi ON mi.id = pi.menu_item_id
     WHERE p.company_id = $1${whereActive}
     GROUP BY p.id
     ORDER BY p.updated_at DESC, p.id DESC`,
    [companyId],
  );
  return result.rows;
};

const find = async (id, companyId) => {
  const rows = await findByCompany(companyId);
  return rows.find((p) => p.id === Number(id)) || null;
};

const create = async (data) => {
  const companyId = Number(data.company_id);
  const items = data.items;
  const { detailed, originalTotal } = await buildItems(companyId, items);
  const pricing = computePricing({
    originalTotal,
    discountPercent: data.discount_percent,
    finalPrice: data.final_price,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const created = await client.query(
      `INSERT INTO promotions
         (company_id, name, description, image_url, active, original_price, discount_percent, final_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        companyId,
        data.name,
        data.description ?? null,
        data.image_url ?? null,
        data.active ?? true,
        pricing.original_price,
        pricing.discount_percent,
        pricing.final_price,
      ],
    );

    const promotion = created.rows[0];
    for (const item of detailed) {
      await client.query(
        `INSERT INTO promotion_items (promotion_id, menu_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [promotion.id, item.menu_item_id, item.quantity],
      );
    }

    await client.query("COMMIT");
    const createdRows = await findByCompany(companyId);
    return createdRows.find((p) => p.id === promotion.id) || promotion;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const update = async (id, data) => {
  const companyId = Number(data.company_id);
  const items = data.items;
  const { detailed, originalTotal } = await buildItems(companyId, items);
  const pricing = computePricing({
    originalTotal,
    discountPercent: data.discount_percent,
    finalPrice: data.final_price,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE promotions
       SET name = $3,
           description = $4,
           image_url = $5,
           active = $6,
           original_price = $7,
           discount_percent = $8,
           final_price = $9,
           updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [
        id,
        companyId,
        data.name,
        data.description ?? null,
        data.image_url ?? null,
        data.active ?? true,
        pricing.original_price,
        pricing.discount_percent,
        pricing.final_price,
      ],
    );

    const promotion = updated.rows[0];
    if (!promotion) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("DELETE FROM promotion_items WHERE promotion_id = $1", [id]);
    for (const item of detailed) {
      await client.query(
        `INSERT INTO promotion_items (promotion_id, menu_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [promotion.id, item.menu_item_id, item.quantity],
      );
    }

    await client.query("COMMIT");
    const updatedRows = await findByCompany(companyId);
    return updatedRows.find((p) => p.id === promotion.id) || promotion;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const remove = async (id, companyId) => {
  const result = await pool.query(
    `DELETE FROM promotions WHERE id = $1 AND company_id = $2 RETURNING *`,
    [id, companyId],
  );
  return result.rows[0] || null;
};

const toggleStatus = async (id, companyId, active) => {
  const result = await pool.query(
    `UPDATE promotions SET active = $3, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 RETURNING *`,
    [id, companyId, !!active],
  );
  return result.rows[0] || null;
};

module.exports = {
  findByCompany,
  find,
  create,
  update,
  remove,
  toggleStatus,
};
