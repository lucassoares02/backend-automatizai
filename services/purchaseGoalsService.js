const pool = require("../db");

const _int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const _toPercent = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Number(n.toFixed(2))));
};

const _hydrate = (rows) => {
  const goalsMap = new Map();
  for (const row of rows) {
    if (!goalsMap.has(row.goal_id)) {
      goalsMap.set(row.goal_id, {
        id: row.goal_id,
        company_id: row.company_id,
        name: row.name,
        description: row.description,
        discount_percentage: Number(row.discount_percentage ?? 0),
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        categories: [],
      });
    }
    if (row.category_id) {
      const list = goalsMap.get(row.goal_id).categories;
      if (!list.find((c) => Number(c.id) === Number(row.category_id))) {
        list.push({
          id: row.category_id,
          name: row.category_name || null,
        });
      }
    }
  }
  return Array.from(goalsMap.values()).sort((a, b) => a.id - b.id);
};

const findByCompany = async (companyId, { onlyActive = false } = {}) => {
  const result = await pool.query(
    `SELECT
       g.id                AS goal_id,
       g.company_id,
       g.name,
       g.description,
       g.discount_percentage,
       g.is_active,
       g.created_at,
       g.updated_at,
       gc.category_id,
       mc.name             AS category_name
     FROM purchase_goals g
     LEFT JOIN purchase_goal_categories gc ON gc.purchase_goal_id = g.id
     LEFT JOIN menu_categories mc ON mc.id = gc.category_id
     WHERE g.company_id = $1 ${onlyActive ? "AND g.is_active = true" : ""}
     ORDER BY g.created_at DESC, g.id DESC`,
    [companyId],
  );
  return _hydrate(result.rows);
};

const findById = async (id) => {
  const result = await pool.query(
    `SELECT
       g.id                AS goal_id,
       g.company_id,
       g.name,
       g.description,
       g.discount_percentage,
       g.is_active,
       g.created_at,
       g.updated_at,
       gc.category_id,
       mc.name             AS category_name
     FROM purchase_goals g
     LEFT JOIN purchase_goal_categories gc ON gc.purchase_goal_id = g.id
     LEFT JOIN menu_categories mc ON mc.id = gc.category_id
     WHERE g.id = $1`,
    [id],
  );
  const list = _hydrate(result.rows);
  return list[0] || null;
};

const _validateCategoriesBelongToCompany = async (client, companyId, categoryIds) => {
  if (categoryIds.length === 0) return;
  const r = await client.query(
    `SELECT id FROM menu_categories WHERE company_id = $1 AND id = ANY($2::int[])`,
    [companyId, categoryIds],
  );
  if (r.rows.length !== categoryIds.length) {
    throw new Error("Uma ou mais categorias não pertencem à empresa informada");
  }
};

const create = async ({ company_id, name, description, discount_percentage, is_active, category_ids }) => {
  const cid = _int(company_id);
  if (!cid || cid <= 0) throw new Error("company_id inválido");
  if (!name || !String(name).trim()) throw new Error("Nome do objetivo é obrigatório");
  const cats = Array.isArray(category_ids) ? category_ids.map(_int).filter((v) => v && v > 0) : [];
  if (cats.length === 0) throw new Error("Selecione pelo menos uma categoria");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await _validateCategoriesBelongToCompany(client, cid, cats);

    const res = await client.query(
      `INSERT INTO purchase_goals
        (company_id, name, description, discount_percentage, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        cid,
        String(name).trim(),
        description ? String(description).trim() : null,
        _toPercent(discount_percentage),
        is_active === false ? false : true,
      ],
    );
    const goalId = res.rows[0].id;
    for (const catId of cats) {
      await client.query(
        `INSERT INTO purchase_goal_categories (purchase_goal_id, category_id) VALUES ($1,$2)
         ON CONFLICT (purchase_goal_id, category_id) DO NOTHING`,
        [goalId, catId],
      );
    }
    await client.query("COMMIT");
    return await findById(goalId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const update = async (id, { company_id, name, description, discount_percentage, is_active, category_ids }) => {
  const gid = _int(id);
  const cid = _int(company_id);
  if (!gid || gid <= 0) throw new Error("id inválido");
  if (!cid || cid <= 0) throw new Error("company_id inválido");
  const existing = await pool.query(
    "SELECT id, company_id FROM purchase_goals WHERE id = $1 LIMIT 1",
    [gid],
  );
  if (existing.rows.length === 0) throw new Error("Objetivo não encontrado");
  if (Number(existing.rows[0].company_id) !== cid) {
    throw new Error("Objetivo não pertence à empresa informada");
  }
  const cats = Array.isArray(category_ids) ? category_ids.map(_int).filter((v) => v && v > 0) : [];
  if (cats.length === 0) throw new Error("Selecione pelo menos uma categoria");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await _validateCategoriesBelongToCompany(client, cid, cats);

    await client.query(
      `UPDATE purchase_goals
       SET name = $2, description = $3, discount_percentage = $4,
           is_active = COALESCE($5, is_active), updated_at = NOW()
       WHERE id = $1`,
      [
        gid,
        String(name || "").trim() || "Objetivo",
        description ? String(description).trim() : null,
        _toPercent(discount_percentage),
        typeof is_active === "boolean" ? is_active : null,
      ],
    );

    // Substitui categorias
    await client.query(`DELETE FROM purchase_goal_categories WHERE purchase_goal_id = $1`, [gid]);
    for (const catId of cats) {
      await client.query(
        `INSERT INTO purchase_goal_categories (purchase_goal_id, category_id) VALUES ($1,$2)
         ON CONFLICT (purchase_goal_id, category_id) DO NOTHING`,
        [gid, catId],
      );
    }
    await client.query("COMMIT");
    return await findById(gid);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const setStatus = async (id, companyId, isActive) => {
  const r = await pool.query(
    `UPDATE purchase_goals SET is_active = $3, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 RETURNING *`,
    [id, companyId, !!isActive],
  );
  return r.rows[0] || null;
};

const remove = async (id, companyId) => {
  const r = await pool.query(
    `DELETE FROM purchase_goals WHERE id = $1 AND company_id = $2 RETURNING *`,
    [id, companyId],
  );
  return r.rows[0] || null;
};

// ─── Suggestion engine ────────────────────────────────────────────────────────

/**
 * Recebe: companyId + array de category_ids presentes no carrinho + opcional
 * lista de menu_item_ids já sugeridos/aceitos para evitar repetição.
 * Retorna: { goal, missing_category, product } ou { suggestion: null, reason }
 */
const suggestNext = async (companyId, presentCategoryIds, excludedProductIds = []) => {
  const cid = _int(companyId);
  if (!cid) return { suggestion: null, reason: "company_id inválido" };

  const goals = await findByCompany(cid, { onlyActive: true });
  if (goals.length === 0) return { suggestion: null, reason: "Sem objetivos ativos" };

  const presentSet = new Set((presentCategoryIds || []).map((v) => Number(v)).filter((v) => v > 0));
  const excludedSet = new Set((excludedProductIds || []).map((v) => Number(v)).filter((v) => v > 0));

  // Priorizar objetivos com maior cobertura no carrinho (mais "perto de completar"),
  // depois o maior desconto.
  const ranked = goals
    .map((g) => {
      const totalCats = g.categories.length;
      const presentCount = g.categories.filter((c) => presentSet.has(Number(c.id))).length;
      const missing = g.categories.filter((c) => !presentSet.has(Number(c.id)));
      return { goal: g, totalCats, presentCount, missing };
    })
    .filter((r) => r.totalCats > 0 && r.presentCount > 0 && r.missing.length > 0)
    .sort((a, b) => {
      const ratioA = a.presentCount / a.totalCats;
      const ratioB = b.presentCount / b.totalCats;
      if (ratioB !== ratioA) return ratioB - ratioA;
      return Number(b.goal.discount_percentage) - Number(a.goal.discount_percentage);
    });

  if (ranked.length === 0) return { suggestion: null, reason: "Nenhum objetivo aplicável" };

  // Tenta cada objetivo até achar um produto disponível
  for (const r of ranked) {
    for (const cat of r.missing) {
      const product = await _pickProductForCategory(cid, cat.id, excludedSet);
      if (product) {
        const discountPct = Number(r.goal.discount_percentage) || 0;
        const original = Number(product.price) || 0;
        const finalPrice = Number((original * (1 - discountPct / 100)).toFixed(2));
        const discountAmount = Number((original - finalPrice).toFixed(2));
        return {
          suggestion: {
            goal: {
              id: r.goal.id,
              name: r.goal.name,
              description: r.goal.description,
              discount_percentage: discountPct,
            },
            missing_category: { id: cat.id, name: cat.name },
            product: {
              id: product.id,
              name: product.name,
              description: product.description,
              image_url: product.image_url,
              original_price: original,
              final_price: finalPrice,
              discount_amount: discountAmount,
              category_id: product.category_id,
              category_name: cat.name,
              has_options: !!product.has_options,
              prep_time_minutes: product.prep_time_minutes,
            },
          },
        };
      }
    }
  }
  return { suggestion: null, reason: "Sem produtos disponíveis para sugerir" };
};

const _pickProductForCategory = async (companyId, categoryId, excludedSet) => {
  const result = await pool.query(
    `SELECT
       mi.id,
       mi.name,
       mi.description,
       mi.price,
       mi.image_url,
       mi.category_id,
       mi.featured,
       mi.prep_time_minutes,
       EXISTS (
         SELECT 1 FROM product_option_groups pog
         WHERE pog.product_id = mi.id
       ) AS has_options
     FROM menu_items mi
     WHERE mi.company_id = $1
       AND mi.category_id = $2
       AND COALESCE(mi.available, true) = true
     ORDER BY mi.featured DESC, mi.price ASC, mi.id ASC`,
    [companyId, categoryId],
  );
  for (const row of result.rows) {
    if (!excludedSet.has(Number(row.id))) return row;
  }
  return null;
};

/**
 * Valida que os descontos pedidos pelos itens existem nos objetivos ativos
 * e calcula o desconto real (snapshot servidor). Retorna mapa por menu_item_id.
 * Espera: [{ menu_item_id, purchase_goal_id }]
 */
const validateGoalDiscounts = async (companyId, requestedDiscounts) => {
  const map = new Map();
  if (!Array.isArray(requestedDiscounts) || requestedDiscounts.length === 0) return map;
  const goals = await findByCompany(companyId, { onlyActive: true });
  for (const req of requestedDiscounts) {
    const menuItemId = _int(req.menu_item_id);
    const goalId = _int(req.purchase_goal_id);
    if (!menuItemId || !goalId) continue;
    const goal = goals.find((g) => Number(g.id) === goalId);
    if (!goal) continue;
    // Confirma que o produto pertence a uma das categorias do objetivo
    const r = await pool.query(
      `SELECT mi.id, mi.price, mi.category_id FROM menu_items mi WHERE mi.id = $1 AND mi.company_id = $2 LIMIT 1`,
      [menuItemId, companyId],
    );
    const item = r.rows[0];
    if (!item) continue;
    const catIds = goal.categories.map((c) => Number(c.id));
    if (!catIds.includes(Number(item.category_id))) continue;
    const pct = Number(goal.discount_percentage) || 0;
    map.set(menuItemId, { goalId, percentage: pct, basePrice: Number(item.price) || 0 });
  }
  return map;
};

module.exports = {
  findByCompany,
  findById,
  create,
  update,
  setStatus,
  remove,
  suggestNext,
  validateGoalDiscounts,
};
