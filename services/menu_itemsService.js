const pool = require("../db");
const { columnExists, tableExists } = require("../helpers/schema");
const { normalizePreorder } = require("../helpers/preorder");
const technicalSheetService = require("./technicalSheetService");
const { normalizeServiceFields, normalizeImageUrls, normalizeIdList } = require("../helpers/serviceItem");

// Normaliza a lista de selos (restrições alimentares) do produto: só strings,
// trim, sem vazios nem duplicatas (case-insensitive). Retorna null quando vazia
// — mesma regra usada em companiessssService para companies.dietary_restrictions.
const normalizeDietaryRestrictions = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.length ? result : null;
};

const _hasStockColumns = async () => {
  const [unlimited, quantity, threshold] = await Promise.all([
    columnExists("menu_items", "stock_unlimited"),
    columnExists("menu_items", "stock_quantity"),
    columnExists("menu_items", "low_stock_threshold"),
  ]);
  return unlimited && quantity && threshold;
};

const _hasStockPayload = (data) =>
  Object.prototype.hasOwnProperty.call(data, "stock_unlimited") ||
  Object.prototype.hasOwnProperty.call(data, "stock_quantity") ||
  Object.prototype.hasOwnProperty.call(data, "low_stock_threshold");

const _hasPreorderColumns = async () => {
  const [preorderOnly, leadDays] = await Promise.all([
    columnExists("menu_items", "preorder_only"),
    columnExists("menu_items", "preorder_lead_days"),
  ]);
  return preorderOnly && leadDays;
};

const _hasPreorderPayload = (data) =>
  Object.prototype.hasOwnProperty.call(data, "preorder_only") ||
  Object.prototype.hasOwnProperty.call(data, "preorder_lead_days");

// Serviços (item_type/duração/intervalo/preço "a partir de"), galeria e
// profissionais habilitados — migration "Serviços com agendamento (Fase 1)" em
// DB_CHANGES_NEEDED.md. Até ela rodar, os campos são ignorados.
const _hasServiceColumns = async () => {
  const cols = await Promise.all(
    ["item_type", "duration_minutes", "buffer_minutes", "price_type"].map((c) => columnExists("menu_items", c)),
  );
  return cols.every(Boolean);
};

const _hasServicePayload = (data) =>
  ["item_type", "duration_minutes", "buffer_minutes", "price_type"].some((k) =>
    Object.prototype.hasOwnProperty.call(data, k),
  );

// Seleciona galeria e profissionais junto do item (subqueries), quando as
// tabelas existem. Usado pelas listagens do painel.
const _extrasSelect = async (alias = "mi") => {
  const [hasImages, hasProfessionals] = await Promise.all([
    tableExists("menu_item_images"),
    tableExists("professional_services"),
  ]);
  const images = hasImages
    ? `COALESCE((SELECT json_agg(json_build_object('id', img.id, 'url', img.url, 'position', img.position)
                                 ORDER BY img.position, img.id)
                 FROM menu_item_images img WHERE img.menu_item_id = ${alias}.id), '[]'::json) AS images`
    : `'[]'::json AS images`;
  const professionals = hasProfessionals
    ? `COALESCE((SELECT array_agg(ps.professional_id ORDER BY ps.professional_id)
                 FROM professional_services ps WHERE ps.menu_item_id = ${alias}.id), '{}'::int[]) AS professional_ids`
    : `'{}'::int[] AS professional_ids`;
  return `${images}, ${professionals}`;
};

// Substitui a galeria do item pela lista recebida (ordem = posição).
const _syncImages = async (client, itemId, urls) => {
  if (urls === null || !(await tableExists("menu_item_images"))) return;
  await client.query("DELETE FROM menu_item_images WHERE menu_item_id = $1", [itemId]);
  if (!urls.length) return;
  await client.query(
    `INSERT INTO menu_item_images (menu_item_id, url, position)
     SELECT $1, u.url, u.ord - 1 FROM unnest($2::text[]) WITH ORDINALITY AS u(url, ord)`,
    [itemId, urls],
  );
};

// Sincroniza os profissionais habilitados no serviço preservando preço/duração
// próprios de quem continua. Só aceita profissionais da mesma empresa.
const _syncProfessionals = async (client, itemId, companyId, ids) => {
  if (ids === null || !(await tableExists("professional_services"))) return;
  await client.query(
    "DELETE FROM professional_services WHERE menu_item_id = $1 AND NOT (professional_id = ANY($2::int[]))",
    [itemId, ids],
  );
  if (!ids.length) return;
  await client.query(
    `INSERT INTO professional_services (professional_id, menu_item_id)
     SELECT p.id, $1 FROM professionals p
     WHERE p.company_id = $2 AND p.id = ANY($3::int[])
     ON CONFLICT (professional_id, menu_item_id) DO NOTHING`,
    [itemId, companyId, ids],
  );
};

// A capa (image_url) acompanha a 1ª foto da galeria quando ela é enviada.
const _resolveCover = (image_url, urls) => {
  if (urls && urls.length) return urls[0];
  if (urls && !urls.length) return null;
  return image_url ?? null;
};

const _withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const normalizeStock = ({ stock_unlimited, stock_quantity, low_stock_threshold }) => {
  const unlimited = stock_unlimited !== false;
  if (unlimited) {
    return {
      stockUnlimited: true,
      stockQuantity: null,
      lowStockThreshold: null,
    };
  }

  const quantity = Number(stock_quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 2147483647) {
    throw Object.assign(
      new Error("Informe uma quantidade de estoque inteira e igual ou maior que zero."),
      { status: 400 },
    );
  }

  let threshold = null;
  if (low_stock_threshold !== null && low_stock_threshold !== undefined && low_stock_threshold !== "") {
    threshold = Number(low_stock_threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 2147483647) {
      throw Object.assign(
        new Error("O alerta de últimas unidades deve ser um número inteiro maior que zero."),
        { status: 400 },
      );
    }
  }

  return {
    stockUnlimited: false,
    stockQuantity: quantity,
    lowStockThreshold: threshold,
  };
};

const findAll = async () => {
  // Exclui produtos removidos logicamente (soft delete).
  const result = await pool.query("SELECT * FROM menu_items WHERE deleted_at IS NULL ORDER BY id");
  return result.rows;
};

const find = async (id) => {
  const extras = await _extrasSelect();
  const result = await pool.query(`SELECT mi.*, ${extras} FROM menu_items mi WHERE mi.id = $1`, [id]);
  return result.rows[0] || null;
};

const findByCompany = async (id) => {
  const extras = await _extrasSelect();
  const result = await pool.query(
    `SELECT mi.*, mc.name AS category_name, ${extras}
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.company_id = $1 AND mi.deleted_at IS NULL
     ORDER BY
       CASE
         WHEN mi.available = false THEN 2
         WHEN mi.featured = true THEN 0
         ELSE 1
       END,
       COALESCE(mi.display_order, mi.id) DESC`,
    [id],
  );
  return result.rows || null;
};

const create = async (data) => {
  const { company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku, dietary_restrictions } = data;
  // Só grava os selos se a coluna já existir (migration em DB_CHANGES_NEEDED.md).
  const [hasSelos, hasStock, hasPreorder, hasService] = await Promise.all([
    columnExists("menu_items", "dietary_restrictions"),
    _hasStockColumns(),
    _hasPreorderColumns(),
    _hasServiceColumns(),
  ]);
  const service = normalizeServiceFields(data);
  const isService = hasService && service.itemType === "service";
  const imageUrls = normalizeImageUrls(data.images);
  const professionalIds = isService ? normalizeIdList(data.professional_ids) : null;
  // Serviço não tem preparo, SKU, estoque nem encomenda.
  const cols = ["company_id", "category_id", "name", "description", "price", "available", "image_url", "featured", "display_order", "prep_time_minutes", "sku"];
  const vals = [
    company_id, category_id, name, description, price, available,
    _resolveCover(image_url, imageUrls), featured ?? false, display_order ?? null,
    isService ? null : prep_time_minutes ?? null,
    isService ? null : sku ?? null,
  ];
  if (hasSelos) {
    cols.push("dietary_restrictions");
    vals.push(normalizeDietaryRestrictions(dietary_restrictions));
  }
  if (hasStock) {
    const stock = normalizeStock(isService ? { stock_unlimited: true } : data);
    cols.push("stock_unlimited", "stock_quantity", "low_stock_threshold");
    vals.push(stock.stockUnlimited, stock.stockQuantity, stock.lowStockThreshold);
  }
  if (hasPreorder) {
    const preorder = normalizePreorder(isService ? {} : data);
    cols.push("preorder_only", "preorder_lead_days");
    vals.push(preorder.preorderOnly, preorder.preorderLeadDays);
  }
  if (hasService) {
    cols.push("item_type", "duration_minutes", "buffer_minutes", "price_type");
    vals.push(service.itemType, service.durationMinutes, service.bufferMinutes, service.priceType);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  const created = await _withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO menu_items (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      vals,
    );
    const row = result.rows[0];
    await _syncImages(client, row.id, imageUrls);
    await _syncProfessionals(client, row.id, row.company_id, professionalIds);
    return row;
  });
  return (await find(created.id)) || created;
};

const update = async (data) => {
  const { id, company_id, category_id, name, description, price, available, image_url, featured, display_order, prep_time_minutes, sku, dietary_restrictions } = data;
  const [hasSelos, hasStock, hasPreorder, hasService] = await Promise.all([
    columnExists("menu_items", "dietary_restrictions"),
    _hasStockColumns(),
    _hasPreorderColumns(),
    _hasServiceColumns(),
  ]);
  // Clientes antigos não enviam item_type: nesse caso o tipo atual é mantido.
  const updatesService = hasService && _hasServicePayload(data);
  let currentType = "product";
  if (hasService && !updatesService) {
    const cur = await pool.query("SELECT item_type FROM menu_items WHERE id = $1", [id]);
    currentType = cur.rows[0]?.item_type || "product";
  }
  const service = updatesService ? normalizeServiceFields(data) : null;
  const isService = updatesService ? service.itemType === "service" : currentType === "service";
  const imageUrls = normalizeImageUrls(data.images);
  // Ao virar produto, remove os vínculos com profissionais.
  const professionalIds = isService ? normalizeIdList(data.professional_ids) : updatesService ? [] : null;

  const sets = ["company_id = $2", "category_id = $3", "name = $4", "description = $5", "price = $6", "available = $7", "image_url = $8", "featured = $9", "display_order = $10", "prep_time_minutes = $11", "sku = $12"];
  const vals = [
    id, company_id, category_id, name, description, price, available,
    _resolveCover(image_url, imageUrls), featured ?? false, display_order ?? null,
    isService ? null : prep_time_minutes ?? null,
    isService ? null : sku ?? null,
  ];
  if (hasSelos) {
    sets.push(`dietary_restrictions = $${vals.length + 1}`);
    vals.push(normalizeDietaryRestrictions(dietary_restrictions));
  }
  // Clientes antigos ainda podem enviar o modelo sem estes campos. Nesse caso,
  // preservamos o estoque já configurado em vez de convertê-lo em ilimitado.
  if (hasStock && (isService || _hasStockPayload(data))) {
    const stock = normalizeStock(isService ? { stock_unlimited: true } : data);
    sets.push(`stock_unlimited = $${vals.length + 1}`);
    vals.push(stock.stockUnlimited);
    sets.push(`stock_quantity = $${vals.length + 1}`);
    vals.push(stock.stockQuantity);
    sets.push(`low_stock_threshold = $${vals.length + 1}`);
    vals.push(stock.lowStockThreshold);
  }
  // Integrações e importadores antigos não enviam estes campos; nesses casos,
  // preserva a configuração atual do produto.
  if (hasPreorder && (isService || _hasPreorderPayload(data))) {
    const preorder = normalizePreorder(isService ? {} : data);
    sets.push(`preorder_only = $${vals.length + 1}`);
    vals.push(preorder.preorderOnly);
    sets.push(`preorder_lead_days = $${vals.length + 1}`);
    vals.push(preorder.preorderLeadDays);
  }
  if (updatesService) {
    for (const [col, value] of [
      ["item_type", service.itemType],
      ["duration_minutes", service.durationMinutes],
      ["buffer_minutes", service.bufferMinutes],
      ["price_type", service.priceType],
    ]) {
      sets.push(`${col} = $${vals.length + 1}`);
      vals.push(value);
    }
  }
  const updated = await _withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE menu_items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals,
    );
    const row = result.rows[0];
    if (!row) return null;
    await _syncImages(client, row.id, imageUrls);
    await _syncProfessionals(client, row.id, row.company_id, professionalIds);
    return row;
  });
  if (!updated) return null;
  return (await find(updated.id)) || updated;
};

const remove = async (id) => {
  // Soft delete: o produto pode ter pedidos (FK em order_items), então não pode
  // ser apagado. Marca deleted_at — some do catálogo e do cardápio, mas continua
  // disponível para histórico/relatórios. Idempotente (só marca se ainda ativo).
  const result = await pool.query(
    "UPDATE menu_items SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *",
    [id],
  );
  return result.rows[0];
};

// Colunas que a cópia não herda: identidade, remoção lógica e SKU (único por
// empresa). Nome e disponibilidade recebem valores próprios no INSERT.
const _DUPLICATE_SKIP = new Set(["id", "deleted_at", "sku", "name", "available"]);

// Duplica o item com galeria, adicionais (grupos + opções) e profissionais.
// A cópia nasce desativada e com " (cópia)" no nome, para ser revisada antes
// de aparecer no cardápio público. Retorna null se o item não existir.
const duplicate = async (id) => {
  const created = await _withTransaction(async (client) => {
    const src = await client.query(
      "SELECT * FROM menu_items WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    const source = src.rows[0];
    if (!source) return null;

    const cols = Object.keys(source).filter((c) => !_DUPLICATE_SKIP.has(c)).map((c) => `"${c}"`);
    const result = await client.query(
      `INSERT INTO menu_items (name, available, ${cols.join(", ")})
       SELECT LEFT(name || ' (cópia)', 150), false, ${cols.join(", ")}
       FROM menu_items WHERE id = $1
       RETURNING *`,
      [id],
    );
    const row = result.rows[0];

    if (await tableExists("menu_item_images")) {
      await client.query(
        `INSERT INTO menu_item_images (menu_item_id, url, position)
         SELECT $2, url, position FROM menu_item_images WHERE menu_item_id = $1 ORDER BY position, id`,
        [id, row.id],
      );
    }
    if (await tableExists("professional_services")) {
      await client.query(
        `INSERT INTO professional_services (professional_id, menu_item_id, price_override, duration_override)
         SELECT professional_id, $2, price_override, duration_override
         FROM professional_services WHERE menu_item_id = $1`,
        [id, row.id],
      );
    }
    if (await tableExists("product_option_groups")) {
      const groups = await client.query(
        "SELECT * FROM product_option_groups WHERE product_id = $1 ORDER BY sort_order, id",
        [id],
      );
      for (const g of groups.rows) {
        const ng = await client.query(
          `INSERT INTO product_option_groups
             (company_id, product_id, name, type, min_selection, max_selection, is_required, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [row.company_id, row.id, g.name, g.type, g.min_selection, g.max_selection, g.is_required, g.sort_order],
        );
        await client.query(
          `INSERT INTO product_option_items (group_id, name, additional_price, sort_order, is_active, image_url)
           SELECT $2, name, additional_price, sort_order, is_active, image_url
           FROM product_option_items WHERE group_id = $1 ORDER BY sort_order, id`,
          [g.id, ng.rows[0].id],
        );
      }
    }
    await technicalSheetService.copy(client, id, row.id);
    return row;
  });
  if (!created) return null;
  return (await find(created.id)) || created;
};

module.exports = { findAll, find, findByCompany, create, update, remove, duplicate };
