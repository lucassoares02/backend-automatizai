const pool = require("../db");

const DEFAULT_WEBHOOK_URL = "https://n8n.arbian.com.br/webhook/cardapio-digital";
// A extração é síncrona: uma chamada à IA por página, em sequência.
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const PACKAGE_VERSION = "arbian-menu-import/2";

// Basic Auth do webhook n8n (mesmas credenciais dos demais webhooks).
const _webhookAuthHeader = () => {
  const u = process.env.WEBHOOK_N8N_USER;
  const p = process.env.WEBHOOK_N8N_PASS;
  if (!u && !p) return null;
  return `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
};

const _error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// Encaminha o cardápio ao n8n como multipart/form-data: campos `company_id`,
// `source` ("file" | "url"), `url` (quando houver) e o binário em `file`.
// Devolve `{ status, pack }`: 200 = há itens; 422 = nada aproveitável (motivo em review.issues).
const sendToWebhook = async ({ companyId, url, file }) => {
  const form = new FormData();
  form.append("company_id", String(companyId));
  form.append("source", file ? "file" : "url");
  if (url) form.append("url", url);
  if (file) {
    form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  }

  const auth = _webhookAuthHeader();
  const res = await fetch(process.env.MENU_IMPORT_WEBHOOK_URL || DEFAULT_WEBHOOK_URL, {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const text = await res.text().catch(() => "");
  if (res.status !== 200 && res.status !== 422) throw new Error(`HTTP ${res.status}: ${text}`);

  let pack;
  try {
    pack = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: resposta não é JSON`);
  }
  validatePackage(pack, companyId);
  return { status: res.status, pack };
};

// O pacote tem contrato versionado e é sempre de uma única empresa.
const validatePackage = (pack, companyId) => {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    throw _error("INVALID_PACKAGE", "Pacote de importação inválido.");
  }
  if (pack.version !== PACKAGE_VERSION) {
    throw _error("UNSUPPORTED_VERSION", `Versão do pacote não suportada: ${pack.version}`);
  }
  if (Number(pack.company_id) !== Number(companyId)) {
    throw _error("COMPANY_MISMATCH", "O pacote pertence a outra empresa.");
  }
  if (!Array.isArray(pack.categories)) {
    throw _error("INVALID_PACKAGE", "Pacote de importação inválido.");
  }
};

// ─── Normalização ────────────────────────────────────────────────────────────

// Sem acento, minúsculas e espaços repetidos reduzidos a um (o banco não tem `unaccent`).
const normalizeName = (value) =>
  (value == null ? "" : String(value))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const _str = (value, max) => {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};

const _int = (value, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(value);
  if (value == null || value === "" || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
};

const _money = (value) => {
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (value == null || value === "" || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
};

const _isHttpUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const _isEmpty = (value) => value == null || String(value).trim() === "";

const _time = (value) => {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
};

// Próximo SKU livre: `208`, `208-2`, `208-3`… (mesma regra do extrator).
const resolveSku = (sku, taken) => {
  const base = _str(sku, 90);
  if (!base) return null;
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${i}`;
  taken.add(candidate);
  return candidate;
};

// ─── Dados da loja (só campos vazios) ───────────────────────────────────────

const COMPANY_FIELDS = [
  { key: "description", max: 500 },
  { key: "phone", max: 16, strict: true },
  { key: "cuisine_type", max: 100 },
  { key: "logo_url", url: true },
];

const _cleanCompanyValue = (field, raw) => {
  const value = _str(raw);
  if (!value) return null;
  if (field.url && !_isHttpUrl(value)) return null;
  // Telefone truncado ficaria errado: descarta.
  if (field.strict && value.length > field.max) return null;
  return field.max ? value.slice(0, field.max) : value;
};

const _cleanAddress = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const address = {
    street: _str(raw.street, 255),
    number: _str(raw.number, 20),
    complement: _str(raw.complement, 100),
    neighborhood: _str(raw.neighborhood, 100),
    city: _str(raw.city, 100),
    state: _str(raw.state, 20),
    zip_code: _str(raw.zip_code, 10),
  };
  return address.street && address.city && address.state ? address : null;
};

const _cleanOpeningHours = (list) =>
  (Array.isArray(list) ? list : [])
    .map((h) => ({
      weekday: _int(h?.weekday, { min: 1, max: 7 }),
      opens_at: _time(h?.opens_at),
      closes_at: _time(h?.closes_at),
    }))
    .filter((h) => h.weekday && h.opens_at && h.closes_at);

const _cleanAdditionalInfo = (list) =>
  (Array.isArray(list) ? list : [])
    .map((i) => ({
      title: _str(i?.title, 150),
      content: _str(i?.content),
      trigger_keywords: _str(i?.trigger_keywords),
    }))
    .filter((i) => i.title && i.content);

/**
 * Decide o que do bloco `company` entra e o que é ignorado por já existir.
 * Usado na prévia (pool) e na gravação (client da transação).
 */
const planCompany = async (db, companyId, company) => {
  const c = company && typeof company === "object" ? company : {};
  const { rows } = await db.query(
    "SELECT description, phone, cuisine_type, logo_url FROM companies WHERE id = $1",
    [companyId],
  );
  const current = rows[0] || {};

  const fields = COMPANY_FIELDS.map((field) => {
    const value = _cleanCompanyValue(field, c[field.key]);
    if (!value) return null;
    return { key: field.key, value, apply: _isEmpty(current[field.key]) };
  }).filter(Boolean);

  const addressCount = await db.query("SELECT COUNT(*)::int AS n FROM company_addresses WHERE company_id = $1", [companyId]);
  const address = _cleanAddress(c.address);
  const hasAddressInput = c.address && typeof c.address === "object";
  const addressPlan = !hasAddressInput
    ? null
    : { value: address, apply: Boolean(address) && addressCount.rows[0].n === 0, reason: !address ? "incomplete" : addressCount.rows[0].n > 0 ? "exists" : null };

  const hoursCount = await db.query("SELECT COUNT(*)::int AS n FROM company_opening_hours WHERE company_id = $1", [companyId]);
  const hours = _cleanOpeningHours(c.opening_hours);
  const hoursPlan = hours.length ? { value: hours, apply: hoursCount.rows[0].n === 0 } : null;

  const existingTitles = await db.query("SELECT title FROM additional_info WHERE company_id = $1", [companyId]);
  const titles = new Set(existingTitles.rows.map((r) => normalizeName(r.title)));
  const additionalInfo = _cleanAdditionalInfo(c.additional_info).map((info) => {
    const key = normalizeName(info.title);
    const apply = !titles.has(key);
    titles.add(key); // repetido dentro do pacote também é pulado
    return { ...info, apply };
  });

  return { fields, address: addressPlan, opening_hours: hoursPlan, additional_info: additionalInfo };
};

// Contexto para a prévia: o que entra da loja e se já há cardápio (reimportação duplica).
const buildPreviewContext = async (companyId, pack) => {
  const company = await planCompany(pool, companyId, pack.company);
  const items = await pool.query(
    "SELECT COUNT(*)::int AS n FROM menu_items WHERE company_id = $1 AND deleted_at IS NULL",
    [companyId],
  );
  return { company, existing_items: items.rows[0].n };
};

// ─── Gravação ───────────────────────────────────────────────────────────────

const OPTION_TYPES = ["single", "multiple", "quantity"];

const _cleanGroup = (raw, index) => {
  const name = _str(raw?.name, 120);
  const options = (Array.isArray(raw?.options) ? raw.options : [])
    .map((o, i) => ({
      name: _str(o?.name, 120),
      additional_price: _money(o?.additional_price) ?? 0,
      sort_order: _int(o?.sort_order, { min: 0 }) ?? i + 1,
      image_url: _isHttpUrl(o?.image_url) ? String(o.image_url).slice(0, 1000) : null,
    }))
    .filter((o) => o.name);
  if (!name || options.length === 0) return null;

  const type = OPTION_TYPES.includes(raw?.type) ? raw.type : "single";
  let min = _int(raw?.min_selection, { min: 0 }) ?? 0;
  let max = _int(raw?.max_selection, { min: 1 }) ?? (type === "single" ? 1 : Math.max(1, options.length));
  if (min > max) min = max;
  return {
    name,
    type,
    min_selection: min,
    max_selection: max,
    is_required: raw?.is_required === true || min > 0,
    sort_order: _int(raw?.sort_order, { min: 0 }) ?? index + 1,
    options,
  };
};

/**
 * Grava o pacote (já conferido pelo dono) numa única transação, na ordem:
 * selos → categorias → produtos → fotos → opções → dados da loja.
 * Qualquer erro faz ROLLBACK: o cardápio nunca entra pela metade.
 */
const applyPackage = async (companyId, pack, { applyCompany = true } = {}) => {
  validatePackage(pack, companyId);

  // Validação antes de abrir a transação: produto precisa de nome e preço.
  const categories = pack.categories
    .map((cat, ci) => ({
      ref: cat?.ref ?? null,
      name: _str(cat?.name, 100),
      sort_order: _int(cat?.sort_order, { min: 0 }) ?? ci + 1,
      items: Array.isArray(cat?.items) ? cat.items : [],
    }))
    .filter((cat) => cat.items.length > 0);

  for (const cat of categories) {
    if (!cat.name) throw _error("CATEGORY_NAME_MISSING", "Há uma categoria sem nome.", { status: 400, ref: cat.ref });
    for (const item of cat.items) {
      if (!_str(item?.name)) throw _error("ITEM_NAME_MISSING", `Há um produto sem nome em "${cat.name}".`, { status: 400, ref: item?.ref ?? null });
      const price = _money(item?.price);
      if (price == null || price < 0) {
        throw _error("PRICE_MISSING", `"${_str(item.name)}" está sem preço.`, { status: 400, ref: item?.ref ?? null });
      }
    }
  }
  if (categories.length === 0) throw _error("NO_ITEMS", "Nenhum produto para importar.", { status: 400 });

  const summary = {
    categories_created: 0,
    categories_reused: 0,
    items_created: 0,
    images_created: 0,
    option_groups_created: 0,
    option_items_created: 0,
    selos_created: [],
    company_fields: [],
    address_created: false,
    opening_hours_created: 0,
    additional_info_created: 0,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Selos: usa o nome exato da loja; os novos entram como selos personalizados.
    const companyRow = await client.query(
      "SELECT dietary_restrictions, custom_dietary_restrictions FROM companies WHERE id = $1 FOR UPDATE",
      [companyId],
    );
    if (companyRow.rowCount === 0) throw _error("COMPANY_NOT_FOUND", "Empresa não encontrada.", { status: 404 });
    const dietary = [...(companyRow.rows[0].dietary_restrictions || [])];
    const custom = [...(companyRow.rows[0].custom_dietary_restrictions || [])];
    const selos = new Map();
    for (const name of [...dietary, ...custom]) {
      if (!selos.has(normalizeName(name))) selos.set(normalizeName(name), name);
    }
    const resolveSelo = (raw) => {
      const name = _str(raw, 60);
      if (!name) return null;
      const key = normalizeName(name);
      if (!selos.has(key)) {
        selos.set(key, name);
        custom.push(name);
        // A loja lista como ativos os selos marcados; o personalizado novo já entra marcado.
        dietary.push(name);
        summary.selos_created.push(name);
      }
      return selos.get(key);
    };
    (Array.isArray(pack.dietary_restrictions) ? pack.dietary_restrictions : []).forEach(resolveSelo);

    // 2) Categorias: reusa a ativa de mesmo nome normalizado; a nova vai para o fim.
    const existingCats = await client.query(
      "SELECT id, name FROM menu_categories WHERE company_id = $1 AND active = true ORDER BY id",
      [companyId],
    );
    const catIds = new Map();
    const reused = new Set();
    for (const row of existingCats.rows) {
      const key = normalizeName(row.name);
      if (!catIds.has(key)) {
        catIds.set(key, row.id);
        reused.add(row.id);
      }
    }
    const maxSort = await client.query(
      "SELECT COALESCE(MAX(sort_order), 0)::int AS n FROM menu_categories WHERE company_id = $1",
      [companyId],
    );

    const skus = new Set(
      (await client.query("SELECT sku FROM menu_items WHERE company_id = $1 AND sku IS NOT NULL", [companyId])).rows.map((r) => r.sku),
    );
    const displayBase = new Map();
    const usedReused = new Set();

    for (const cat of categories) {
      const key = normalizeName(cat.name);
      let categoryId = catIds.get(key);
      if (!categoryId) {
        const created = await client.query(
          "INSERT INTO menu_categories (company_id, name, sort_order, active) VALUES ($1, $2, $3, true) RETURNING id",
          [companyId, cat.name, maxSort.rows[0].n + cat.sort_order],
        );
        categoryId = created.rows[0].id;
        catIds.set(key, categoryId);
        displayBase.set(categoryId, 0);
        summary.categories_created++;
      } else if (reused.has(categoryId) && !usedReused.has(categoryId)) {
        usedReused.add(categoryId);
        summary.categories_reused++;
      }

      // Em categoria já existente, os novos ficam depois dos atuais.
      if (!displayBase.has(categoryId)) {
        const maxDisplay = await client.query(
          "SELECT COALESCE(MAX(display_order), 0)::int AS n FROM menu_items WHERE company_id = $1 AND category_id = $2",
          [companyId, categoryId],
        );
        displayBase.set(categoryId, maxDisplay.rows[0].n);
      }

      // 3) Produtos, fotos e opções.
      for (let ii = 0; ii < cat.items.length; ii++) {
        const item = cat.items[ii];
        const preorderLead = _int(item.preorder_lead_days, { min: 1, max: 365 });
        const preorderOnly = item.preorder_only === true && preorderLead != null;
        const itemSelos = [
          ...new Set((Array.isArray(item.dietary_restrictions) ? item.dietary_restrictions : []).map(resolveSelo).filter(Boolean)),
        ];

        const inserted = await client.query(
          `INSERT INTO menu_items
             (company_id, category_id, name, description, price, price_type, sku, display_order,
              item_type, available, featured, prep_time_minutes, preorder_only, preorder_lead_days,
              dietary_restrictions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'product', $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [
            companyId,
            categoryId,
            _str(item.name, 150),
            _str(item.description),
            _money(item.price),
            item.price_type === "from" ? "from" : "fixed",
            resolveSku(item.sku, skus),
            displayBase.get(categoryId) + (_int(item.display_order, { min: 0 }) ?? ii + 1),
            item.available !== false,
            item.featured === true,
            _int(item.prep_time_minutes, { min: 1, max: 1440 }),
            preorderOnly,
            preorderOnly ? preorderLead : null,
            itemSelos.length ? itemSelos : null,
          ],
        );
        const itemId = inserted.rows[0].id;
        summary.items_created++;

        const images = (Array.isArray(item.images) ? item.images : [])
          .map((img) => (typeof img === "string" ? img : img?.url))
          .filter(_isHttpUrl);
        for (let pi = 0; pi < images.length; pi++) {
          await client.query("INSERT INTO menu_item_images (menu_item_id, url, position) VALUES ($1, $2, $3)", [itemId, images[pi], pi]);
          summary.images_created++;
        }

        const groups = (Array.isArray(item.option_groups) ? item.option_groups : []).map(_cleanGroup).filter(Boolean);
        for (const group of groups) {
          const g = await client.query(
            `INSERT INTO product_option_groups
               (company_id, product_id, name, type, min_selection, max_selection, is_required, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [companyId, itemId, group.name, group.type, group.min_selection, group.max_selection, group.is_required, group.sort_order],
          );
          summary.option_groups_created++;
          for (const option of group.options) {
            await client.query(
              `INSERT INTO product_option_items (group_id, name, additional_price, sort_order, image_url, is_active)
               VALUES ($1, $2, $3, $4, $5, true)`,
              [g.rows[0].id, option.name, option.additional_price, option.sort_order, option.image_url],
            );
            summary.option_items_created++;
          }
        }
      }
    }

    if (summary.selos_created.length) {
      await client.query(
        "UPDATE companies SET dietary_restrictions = $2, custom_dietary_restrictions = $3 WHERE id = $1",
        [companyId, dietary, custom],
      );
    }

    // 4) Dados da loja: só o que está vazio.
    if (applyCompany) {
      const plan = await planCompany(client, companyId, pack.company);
      for (const field of plan.fields.filter((f) => f.apply)) {
        // Nome de coluna vem da lista fixa COMPANY_FIELDS, nunca do pacote.
        await client.query(`UPDATE companies SET ${field.key} = $2 WHERE id = $1`, [companyId, field.value]);
        summary.company_fields.push(field.key);
      }
      if (plan.address?.apply) {
        const a = plan.address.value;
        await client.query(
          `INSERT INTO company_addresses (company_id, street, number, complement, neighborhood, city, state, zip_code, is_main)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [companyId, a.street, a.number, a.complement, a.neighborhood, a.city, a.state, a.zip_code],
        );
        summary.address_created = true;
      }
      if (plan.opening_hours?.apply) {
        for (const h of plan.opening_hours.value) {
          await client.query(
            "INSERT INTO company_opening_hours (company_id, weekday, opens_at, closes_at, is_closed) VALUES ($1, $2, $3, $4, false)",
            [companyId, h.weekday, h.opens_at, h.closes_at],
          );
          summary.opening_hours_created++;
        }
      }
      for (const info of plan.additional_info.filter((i) => i.apply)) {
        await client.query(
          `INSERT INTO additional_info (company_id, title, content, category, trigger_keywords, visibility)
           VALUES ($1, $2, $3, NULL, $4, 'public')`,
          [companyId, info.title, info.content, info.trigger_keywords],
        );
        summary.additional_info_created++;
      }
    }

    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  PACKAGE_VERSION,
  sendToWebhook,
  validatePackage,
  normalizeName,
  resolveSku,
  planCompany,
  buildPreviewContext,
  applyPackage,
};
