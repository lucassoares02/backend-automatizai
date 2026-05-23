const pool = require("../db");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _companyId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Invalid company_id");
  return n;
};

const computeFinalPrice = ({ discountType, discountValue, originalPrice }) => {
  const orig = Number(originalPrice ?? 0);
  if (orig <= 0) throw new Error("Product has no valid price");

  if (discountType === "percent") {
    const pct = Number(discountValue ?? 0);
    if (!Number.isFinite(pct) || pct < 0) throw new Error("Discount percent cannot be negative");
    if (pct >= 100) throw new Error("Discount percent must be less than 100");
    return Number((orig * (1 - pct / 100)).toFixed(2));
  } else {
    const final = Number(discountValue ?? 0);
    if (!Number.isFinite(final) || final < 0) throw new Error("Final price cannot be negative");
    if (final > orig) throw new Error("Final price cannot be greater than original price");
    return Number(final.toFixed(2));
  }
};

const computePercent = ({ finalPrice, originalPrice }) => {
  const orig = Number(originalPrice ?? 0);
  const fin = Number(finalPrice ?? 0);
  if (orig <= 0) return 0;
  return Number(((orig - fin) / orig * 100).toFixed(2));
};

// ─── Fetch full rules with items ──────────────────────────────────────────────

const findByCompany = async (companyId, onlyActive = false) => {
  const whereActive = onlyActive ? " AND r.active = true" : "";
  const result = await pool.query(
    `SELECT
       r.id, r.company_id, r.trigger_item_id, r.description, r.active,
       r.max_suggestions, r.created_at, r.updated_at,
       ti.name  AS trigger_name,
       ti.price AS trigger_price,
       ti.image_url AS trigger_image_url,
       COALESCE(
         json_agg(
           json_build_object(
             'id',            ri.id,
             'menu_item_id',  ri.menu_item_id,
             'discount_type', ri.discount_type,
             'discount_value',ri.discount_value,
             'final_price',   ri.final_price,
             'display_order', ri.display_order,
             'item_name',     mi.name,
             'item_price',    mi.price,
             'item_image_url',mi.image_url
           ) ORDER BY ri.display_order, ri.id
         ) FILTER (WHERE ri.id IS NOT NULL),
         '[]'
       ) AS items
     FROM upsell_rules r
     JOIN menu_items ti ON ti.id = r.trigger_item_id
     LEFT JOIN upsell_rule_items ri ON ri.rule_id = r.id
     LEFT JOIN menu_items mi ON mi.id = ri.menu_item_id
     WHERE r.company_id = $1${whereActive}
     GROUP BY r.id, ti.name, ti.price, ti.image_url
     ORDER BY r.updated_at DESC, r.id DESC`,
    [companyId],
  );
  return result.rows;
};

// ─── Public: get suggestions for a trigger item ───────────────────────────────

const getSuggestions = async (companyId, triggerItemId) => {
  const result = await pool.query(
    `SELECT
       r.id AS rule_id, r.description, r.max_suggestions,
       ri.id AS item_rule_id, ri.menu_item_id,
       ri.discount_type, ri.discount_value, ri.final_price, ri.display_order,
       mi.name AS item_name, mi.price AS item_price, mi.image_url AS item_image_url
     FROM upsell_rules r
     JOIN upsell_rule_items ri ON ri.rule_id = r.id
     JOIN menu_items mi ON mi.id = ri.menu_item_id
     WHERE r.company_id = $1
       AND r.trigger_item_id = $2
       AND r.active = true
       AND mi.available = true
     ORDER BY ri.display_order, ri.id
     LIMIT 10`,
    [companyId, triggerItemId],
  );

  if (result.rows.length === 0) return null;

  const first = result.rows[0];
  const maxSugg = first.max_suggestions ?? 3;
  const items = result.rows.slice(0, maxSugg).map((row) => ({
    item_rule_id: row.item_rule_id,
    menu_item_id: row.menu_item_id,
    item_name: row.item_name,
    item_price: Number(row.item_price ?? 0),
    item_image_url: row.item_image_url,
    discount_type: row.discount_type,
    discount_value: Number(row.discount_value ?? 0),
    final_price: Number(row.final_price ?? 0),
    discount_percent: computePercent({
      finalPrice: row.final_price,
      originalPrice: row.item_price,
    }),
  }));

  return {
    rule_id: first.rule_id,
    description: first.description,
    items,
  };
};

// ─── Create ───────────────────────────────────────────────────────────────────

const create = async (data) => {
  const cid = _companyId(data.company_id);
  const triggerId = Number(data.trigger_item_id);
  if (!Number.isInteger(triggerId) || triggerId <= 0) throw new Error("trigger_item_id is required");
  if (!Array.isArray(data.items) || data.items.length === 0) throw new Error("At least one suggested product is required");

  // Validate trigger belongs to company
  const triggerCheck = await pool.query(
    "SELECT id, price FROM menu_items WHERE id = $1 AND company_id = $2",
    [triggerId, cid],
  );
  if (triggerCheck.rows.length === 0) throw new Error("Trigger product not found in this company");

  // Validate and enrich items
  const itemIds = data.items.map((it) => Number(it.menu_item_id));
  const unique = new Set(itemIds);
  if (unique.size !== itemIds.length) throw new Error("Duplicate suggested products are not allowed");
  if (unique.has(triggerId)) throw new Error("Trigger product cannot be in the suggested list");

  const menuRes = await pool.query(
    "SELECT id, price FROM menu_items WHERE id = ANY($1::int[]) AND company_id = $2",
    [itemIds, cid],
  );
  const byId = new Map(menuRes.rows.map((r) => [r.id, r]));
  if (byId.size !== itemIds.length) throw new Error("One or more suggested products not found in this company");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ruleRes = await client.query(
      `INSERT INTO upsell_rules
         (company_id, trigger_item_id, description, active, max_suggestions)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [cid, triggerId, data.description ?? null, data.active ?? true, data.max_suggestions ?? 3],
    );
    const rule = ruleRes.rows[0];

    for (let i = 0; i < data.items.length; i++) {
      const it = data.items[i];
      const menuItem = byId.get(Number(it.menu_item_id));
      const discountType = it.discount_type === "final_price" ? "final_price" : "percent";
      const discountValue = Number(it.discount_value ?? 0);
      const finalPrice = discountType === "percent"
        ? computeFinalPrice({ discountType, discountValue, originalPrice: menuItem.price })
        : computeFinalPrice({ discountType, discountValue, originalPrice: menuItem.price });

      await client.query(
        `INSERT INTO upsell_rule_items
           (rule_id, menu_item_id, discount_type, discount_value, final_price, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rule.id, it.menu_item_id, discountType, discountValue, finalPrice, i],
      );
    }

    await client.query("COMMIT");
    const rows = await findByCompany(cid);
    return rows.find((r) => r.id === rule.id) || rule;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────

const update = async (id, data) => {
  const cid = _companyId(data.company_id);
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) throw new Error("Invalid rule id");

  const triggerId = Number(data.trigger_item_id);
  if (!Number.isInteger(triggerId) || triggerId <= 0) throw new Error("trigger_item_id is required");
  if (!Array.isArray(data.items) || data.items.length === 0) throw new Error("At least one suggested product is required");

  const triggerCheck = await pool.query(
    "SELECT id, price FROM menu_items WHERE id = $1 AND company_id = $2",
    [triggerId, cid],
  );
  if (triggerCheck.rows.length === 0) throw new Error("Trigger product not found");

  const itemIds = data.items.map((it) => Number(it.menu_item_id));
  const unique = new Set(itemIds);
  if (unique.size !== itemIds.length) throw new Error("Duplicate suggested products are not allowed");
  if (unique.has(triggerId)) throw new Error("Trigger product cannot be in the suggested list");

  const menuRes = await pool.query(
    "SELECT id, price FROM menu_items WHERE id = ANY($1::int[]) AND company_id = $2",
    [itemIds, cid],
  );
  const byId = new Map(menuRes.rows.map((r) => [r.id, r]));
  if (byId.size !== itemIds.length) throw new Error("One or more suggested products not found in this company");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ruleRes = await client.query(
      `UPDATE upsell_rules
       SET trigger_item_id = $3, description = $4, active = $5,
           max_suggestions = $6, updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [ruleId, cid, triggerId, data.description ?? null, data.active ?? true, data.max_suggestions ?? 3],
    );
    if (ruleRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const rule = ruleRes.rows[0];

    await client.query("DELETE FROM upsell_rule_items WHERE rule_id = $1", [ruleId]);

    for (let i = 0; i < data.items.length; i++) {
      const it = data.items[i];
      const menuItem = byId.get(Number(it.menu_item_id));
      const discountType = it.discount_type === "final_price" ? "final_price" : "percent";
      const discountValue = Number(it.discount_value ?? 0);
      const finalPrice = computeFinalPrice({ discountType, discountValue, originalPrice: menuItem.price });

      await client.query(
        `INSERT INTO upsell_rule_items
           (rule_id, menu_item_id, discount_type, discount_value, final_price, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rule.id, it.menu_item_id, discountType, discountValue, finalPrice, i],
      );
    }

    await client.query("COMMIT");
    const rows = await findByCompany(cid);
    return rows.find((r) => r.id === rule.id) || rule;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// ─── Toggle active ────────────────────────────────────────────────────────────

const toggleStatus = async (id, companyId, active) => {
  const result = await pool.query(
    `UPDATE upsell_rules SET active = $3, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 RETURNING *`,
    [id, companyId, !!active],
  );
  return result.rows[0] || null;
};

// ─── Duplicate ────────────────────────────────────────────────────────────────

const duplicate = async (id, companyId) => {
  const cid = _companyId(companyId);
  const rows = await findByCompany(cid);
  const original = rows.find((r) => r.id === Number(id));
  if (!original) return null;

  const items = (original.items || []).map((it) => ({
    menu_item_id: it.menu_item_id,
    discount_type: it.discount_type,
    discount_value: it.discount_value,
  }));

  return create({
    company_id: cid,
    trigger_item_id: original.trigger_item_id,
    description: original.description ? `${original.description} (cópia)` : "Cópia",
    active: false,
    max_suggestions: original.max_suggestions,
    items,
  });
};

// ─── Delete ───────────────────────────────────────────────────────────────────

const remove = async (id, companyId) => {
  const result = await pool.query(
    "DELETE FROM upsell_rules WHERE id = $1 AND company_id = $2 RETURNING *",
    [id, companyId],
  );
  return result.rows[0] || null;
};

module.exports = { findByCompany, getSuggestions, create, update, toggleStatus, duplicate, remove };
