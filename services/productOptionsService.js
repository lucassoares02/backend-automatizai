const pool = require("../db");

const _int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const _money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : 0;
};

const _normalizeType = (t) => {
  const s = String(t || "single").toLowerCase();
  if (s === "multiple" || s === "quantity") return s;
  return "single";
};

const _ensureProductInCompany = async (productId, companyId) => {
  const r = await pool.query(
    "SELECT id, company_id FROM menu_items WHERE id = $1 LIMIT 1",
    [productId],
  );
  if (r.rows.length === 0) throw new Error("Produto não encontrado");
  if (Number(r.rows[0].company_id) !== Number(companyId)) {
    throw new Error("Produto não pertence à empresa informada");
  }
};

const _hydrateGroups = (rows) => {
  const groupsMap = new Map();
  for (const row of rows) {
    if (!groupsMap.has(row.group_id)) {
      groupsMap.set(row.group_id, {
        id: row.group_id,
        company_id: row.company_id,
        product_id: row.product_id,
        name: row.group_name,
        type: row.type,
        min_selection: row.min_selection,
        max_selection: row.max_selection,
        is_required: row.is_required,
        sort_order: row.sort_order,
        items: [],
      });
    }
    if (row.item_id) {
      groupsMap.get(row.group_id).items.push({
        id: row.item_id,
        group_id: row.group_id,
        name: row.item_name,
        additional_price: Number(row.additional_price ?? 0),
        sort_order: row.item_sort_order,
        is_active: row.is_active,
      });
    }
  }
  return Array.from(groupsMap.values()).sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id,
  );
};

const findByProduct = async (productId, { onlyActive = false } = {}) => {
  const result = await pool.query(
    `SELECT
       g.id            AS group_id,
       g.company_id,
       g.product_id,
       g.name          AS group_name,
       g.type,
       g.min_selection,
       g.max_selection,
       g.is_required,
       g.sort_order,
       i.id            AS item_id,
       i.name          AS item_name,
       i.additional_price,
       i.sort_order    AS item_sort_order,
       i.is_active
     FROM product_option_groups g
     LEFT JOIN product_option_items i ON i.group_id = g.id ${onlyActive ? "AND i.is_active = true" : ""}
     WHERE g.product_id = $1
     ORDER BY g.sort_order, g.id, i.sort_order, i.id`,
    [productId],
  );
  return _hydrateGroups(result.rows);
};

const create = async ({ company_id, product_id, name, type, min_selection, max_selection, is_required, sort_order, items }) => {
  const cid = _int(company_id);
  const pid = _int(product_id);
  if (!cid || cid <= 0) throw new Error("company_id inválido");
  if (!pid || pid <= 0) throw new Error("product_id inválido");
  if (!name || !String(name).trim()) throw new Error("Nome do grupo é obrigatório");

  await _ensureProductInCompany(pid, cid);

  const groupType = _normalizeType(type);
  const minSel = Math.max(0, _int(min_selection) ?? 0);
  const maxSel = Math.max(0, _int(max_selection) ?? (groupType === "single" ? 1 : 0));
  const required = !!is_required;
  const order = _int(sort_order) ?? 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gRes = await client.query(
      `INSERT INTO product_option_groups
        (company_id, product_id, name, type, min_selection, max_selection, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [cid, pid, String(name).trim(), groupType, minSel, maxSel, required, order],
    );
    const groupId = gRes.rows[0].id;

    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it?.name || !String(it.name).trim()) continue;
        await client.query(
          `INSERT INTO product_option_items
            (group_id, name, additional_price, sort_order, is_active)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            groupId,
            String(it.name).trim(),
            _money(it.additional_price),
            _int(it.sort_order) ?? i,
            it.is_active === false ? false : true,
          ],
        );
      }
    }

    await client.query("COMMIT");
    const groups = await findByProduct(pid);
    return groups.find((g) => g.id === groupId) || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const update = async (groupId, { company_id, name, type, min_selection, max_selection, is_required, sort_order, items }) => {
  const gid = _int(groupId);
  const cid = _int(company_id);
  if (!gid || gid <= 0) throw new Error("Group id inválido");
  if (!cid || cid <= 0) throw new Error("company_id inválido");

  const existing = await pool.query(
    "SELECT id, product_id, company_id FROM product_option_groups WHERE id = $1 LIMIT 1",
    [gid],
  );
  if (existing.rows.length === 0) throw new Error("Grupo não encontrado");
  if (Number(existing.rows[0].company_id) !== cid) {
    throw new Error("Grupo não pertence à empresa informada");
  }
  const productId = existing.rows[0].product_id;

  const groupType = _normalizeType(type);
  const minSel = Math.max(0, _int(min_selection) ?? 0);
  const maxSel = Math.max(0, _int(max_selection) ?? (groupType === "single" ? 1 : 0));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE product_option_groups
       SET name = $2, type = $3, min_selection = $4, max_selection = $5,
           is_required = $6, sort_order = COALESCE($7, sort_order)
       WHERE id = $1`,
      [
        gid,
        String(name || "").trim() || "Grupo",
        groupType,
        minSel,
        maxSel,
        !!is_required,
        _int(sort_order),
      ],
    );

    if (Array.isArray(items)) {
      const incomingIds = items.filter((it) => _int(it?.id)).map((it) => _int(it.id));
      if (incomingIds.length > 0) {
        await client.query(
          `DELETE FROM product_option_items WHERE group_id = $1 AND id <> ALL($2::int[])`,
          [gid, incomingIds],
        );
      } else {
        await client.query(`DELETE FROM product_option_items WHERE group_id = $1`, [gid]);
      }

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it?.name || !String(it.name).trim()) continue;
        const itemId = _int(it.id);
        if (itemId) {
          await client.query(
            `UPDATE product_option_items
             SET name = $2, additional_price = $3, sort_order = $4, is_active = $5
             WHERE id = $1 AND group_id = $6`,
            [
              itemId,
              String(it.name).trim(),
              _money(it.additional_price),
              _int(it.sort_order) ?? i,
              it.is_active === false ? false : true,
              gid,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO product_option_items
              (group_id, name, additional_price, sort_order, is_active)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              gid,
              String(it.name).trim(),
              _money(it.additional_price),
              _int(it.sort_order) ?? i,
              it.is_active === false ? false : true,
            ],
          );
        }
      }
    }

    await client.query("COMMIT");
    const groups = await findByProduct(productId);
    return groups.find((g) => g.id === gid) || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const remove = async (groupId, companyId) => {
  const result = await pool.query(
    "DELETE FROM product_option_groups WHERE id = $1 AND company_id = $2 RETURNING *",
    [groupId, companyId],
  );
  return result.rows[0] || null;
};

const reorder = async (productId, companyId, orderedIds) => {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `UPDATE product_option_groups SET sort_order = $3
         WHERE id = $1 AND product_id = $2 AND company_id = $4`,
        [orderedIds[i], productId, i, companyId],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return await findByProduct(productId);
};

// ─── Validation used by order creation ────────────────────────────────────────
const validateSelections = async (productId, selectedGroups) => {
  const groups = await findByProduct(productId, { onlyActive: true });
  const incoming = Array.isArray(selectedGroups) ? selectedGroups : [];

  let extraTotalPerUnit = 0;
  const snapshot = [];

  for (const group of groups) {
    const incomingGroup = incoming.find((g) => Number(g.group_id) === Number(group.id));
    const selections = incomingGroup?.options || [];
    const totalQty = selections.reduce((sum, s) => sum + Math.max(1, _int(s.quantity) ?? 1), 0);

    if (group.is_required && totalQty < Math.max(1, group.min_selection || 1)) {
      throw new Error(`Selecione pelo menos ${Math.max(1, group.min_selection || 1)} opção em "${group.name}"`);
    }
    if (group.max_selection > 0 && totalQty > group.max_selection) {
      throw new Error(`No grupo "${group.name}" é permitido no máximo ${group.max_selection}`);
    }

    for (const s of selections) {
      const item = group.items.find((it) => Number(it.id) === Number(s.option_id));
      if (!item) {
        // permite item nomeado livre apenas se vier name (raro), mas por segurança rejeita
        throw new Error(`Opção inválida em "${group.name}"`);
      }
      const qty = group.type === "quantity" ? Math.max(1, _int(s.quantity) ?? 1) : 1;
      const price = Number(item.additional_price ?? 0);
      extraTotalPerUnit += price * qty;
      snapshot.push({
        group_id: group.id,
        group_name: group.name,
        option_id: item.id,
        option_name: item.name,
        additional_price: price,
        quantity: qty,
      });
    }
  }

  return { extraTotalPerUnit: Number(extraTotalPerUnit.toFixed(2)), snapshot };
};

const productHasOptions = async (productId) => {
  const r = await pool.query(
    "SELECT 1 FROM product_option_groups WHERE product_id = $1 LIMIT 1",
    [productId],
  );
  return r.rows.length > 0;
};

module.exports = {
  findByProduct,
  create,
  update,
  remove,
  reorder,
  validateSelections,
  productHasOptions,
};
