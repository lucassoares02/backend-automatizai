const pool = require("../db");
const { tableExists } = require("../helpers/schema");
const { normalizeSheet, computeCosts } = require("../helpers/technicalSheet");

const SHEETS = "menu_item_technical_sheets";
const INGREDIENTS = "menu_item_technical_sheet_ingredients";

// Sem a migração (DB_CHANGES_NEEDED.md) a ficha técnica fica indisponível,
// mas o restante do cardápio segue funcionando.
const isAvailable = async () => (await tableExists(SHEETS)) && (await tableExists(INGREDIENTS));

const _n = (v) => (v === null || v === undefined ? null : Number(v));

const _hydrate = (sheet, ingredients) => ({
  menu_item_id: sheet.menu_item_id,
  yield_quantity: _n(sheet.yield_quantity),
  yield_unit: sheet.yield_unit,
  portion_size: _n(sheet.portion_size),
  portion_unit: sheet.portion_unit,
  packaging_cost: _n(sheet.packaging_cost) ?? 0,
  other_costs: _n(sheet.other_costs) ?? 0,
  target_cmv_percent: _n(sheet.target_cmv_percent),
  preparation_method: sheet.preparation_method,
  storage_instructions: sheet.storage_instructions,
  shelf_life_days: sheet.shelf_life_days,
  updated_at: sheet.updated_at,
  ingredients: ingredients.map((i) => ({
    id: i.id,
    position: i.position,
    name: i.name,
    brand: i.brand,
    purchase_quantity: _n(i.purchase_quantity),
    purchase_unit: i.purchase_unit,
    purchase_price: _n(i.purchase_price),
    recipe_quantity: _n(i.recipe_quantity),
    recipe_unit: i.recipe_unit,
    loss_percent: _n(i.loss_percent) ?? 0,
  })),
});

const _itemPrice = async (db, menuItemId) => {
  const r = await db.query("SELECT price FROM menu_items WHERE id = $1 AND deleted_at IS NULL", [menuItemId]);
  if (r.rowCount === 0) return undefined;
  return _n(r.rows[0].price);
};

const _load = async (db, menuItemId) => {
  const s = await db.query(`SELECT * FROM ${SHEETS} WHERE menu_item_id = $1`, [menuItemId]);
  if (s.rowCount === 0) return null;
  const i = await db.query(`SELECT * FROM ${INGREDIENTS} WHERE menu_item_id = $1 ORDER BY position, id`, [menuItemId]);
  return _hydrate(s.rows[0], i.rows);
};

const _response = (sheet, price) => ({
  available: true,
  sheet,
  costs: sheet ? computeCosts(sheet, price) : null,
});

/** Devolve `{available, sheet, costs}`; `null` quando o item não existe. */
const find = async (menuItemId) => {
  if (!(await isAvailable())) return { available: false, sheet: null, costs: null };
  const price = await _itemPrice(pool, menuItemId);
  if (price === undefined) return null;
  return _response(await _load(pool, menuItemId), price);
};

/** Cria ou substitui a ficha (matérias-primas são regravadas por inteiro). */
const save = async (menuItemId, body) => {
  if (!(await isAvailable())) {
    const err = new Error("Ficha técnica indisponível: a migração do banco ainda não foi aplicada");
    err.status = 503;
    throw err;
  }
  const data = normalizeSheet(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query(
      "SELECT company_id, price FROM menu_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [menuItemId],
    );
    if (item.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO ${SHEETS}
         (menu_item_id, company_id, yield_quantity, yield_unit, portion_size, portion_unit,
          packaging_cost, other_costs, target_cmv_percent, preparation_method,
          storage_instructions, shelf_life_days, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       ON CONFLICT (menu_item_id) DO UPDATE SET
         yield_quantity = EXCLUDED.yield_quantity,
         yield_unit = EXCLUDED.yield_unit,
         portion_size = EXCLUDED.portion_size,
         portion_unit = EXCLUDED.portion_unit,
         packaging_cost = EXCLUDED.packaging_cost,
         other_costs = EXCLUDED.other_costs,
         target_cmv_percent = EXCLUDED.target_cmv_percent,
         preparation_method = EXCLUDED.preparation_method,
         storage_instructions = EXCLUDED.storage_instructions,
         shelf_life_days = EXCLUDED.shelf_life_days,
         updated_at = NOW()`,
      [
        menuItemId,
        item.rows[0].company_id,
        data.yield_quantity,
        data.yield_unit,
        data.portion_size,
        data.portion_unit,
        data.packaging_cost,
        data.other_costs,
        data.target_cmv_percent,
        data.preparation_method,
        data.storage_instructions,
        data.shelf_life_days,
      ],
    );
    await client.query(`DELETE FROM ${INGREDIENTS} WHERE menu_item_id = $1`, [menuItemId]);
    for (const ing of data.ingredients) {
      await client.query(
        `INSERT INTO ${INGREDIENTS}
           (menu_item_id, position, name, brand, purchase_quantity, purchase_unit,
            purchase_price, recipe_quantity, recipe_unit, loss_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          menuItemId,
          ing.position,
          ing.name,
          ing.brand,
          ing.purchase_quantity,
          ing.purchase_unit,
          ing.purchase_price,
          ing.recipe_quantity,
          ing.recipe_unit,
          ing.loss_percent,
        ],
      );
    }
    const sheet = await _load(client, menuItemId);
    await client.query("COMMIT");
    return _response(sheet, _n(item.rows[0].price));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/** Copia a ficha de um item para outro (usado ao duplicar produto). */
const copy = async (client, fromId, toId) => {
  if (!(await isAvailable())) return;
  const r = await client.query(
    `INSERT INTO ${SHEETS}
       (menu_item_id, company_id, yield_quantity, yield_unit, portion_size, portion_unit,
        packaging_cost, other_costs, target_cmv_percent, preparation_method,
        storage_instructions, shelf_life_days)
     SELECT $2, company_id, yield_quantity, yield_unit, portion_size, portion_unit,
            packaging_cost, other_costs, target_cmv_percent, preparation_method,
            storage_instructions, shelf_life_days
     FROM ${SHEETS} WHERE menu_item_id = $1`,
    [fromId, toId],
  );
  if (r.rowCount === 0) return;
  await client.query(
    `INSERT INTO ${INGREDIENTS}
       (menu_item_id, position, name, brand, purchase_quantity, purchase_unit,
        purchase_price, recipe_quantity, recipe_unit, loss_percent)
     SELECT $2, position, name, brand, purchase_quantity, purchase_unit,
            purchase_price, recipe_quantity, recipe_unit, loss_percent
     FROM ${INGREDIENTS} WHERE menu_item_id = $1 ORDER BY position, id`,
    [fromId, toId],
  );
};

module.exports = { find, save, copy, isAvailable };
