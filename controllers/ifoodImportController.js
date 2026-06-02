const axios = require("axios");
const ifoodService = require("../services/ifoodImportService");
const categoriesService = require("../services/menu_categoriesService");
const itemsService = require("../services/menu_itemsService");
const optionsService = require("../services/productOptionsService");
const minio = require("../controllers/minioController");

// ─── Helpers ──────────────────────────────────────────────────────────────

const _norm = (s) => (s || "").toString().trim().toLowerCase();

const _extFromContentType = (ct) => {
  switch ((ct || "").toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
};

/**
 * Baixa a imagem externa e re-hospeda no MinIO (mesmo storage do upload manual),
 * devolvendo a URL final da plataforma. Retorna null em caso de falha — assim
 * o produto é criado sem imagem em vez de quebrar a importação.
 */
const _rehostImage = async (imageUrl) => {
  if (!imageUrl) return null;
  try {
    const resp = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 20000 });
    const buffer = Buffer.from(resp.data);
    if (!buffer.length) return null;
    const contentType = resp.headers["content-type"] || "image/jpeg";
    const ext = _extFromContentType(contentType);
    const filename = `menu_items/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { url } = await minio.uploadFile(buffer, filename, contentType);
    return url;
  } catch (error) {
    console.error("Falha ao re-hospedar imagem do iFood:", error.message);
    return null;
  }
};

/**
 * Cria os grupos de opções/adicionais do produto reutilizando o MESMO service
 * de "Opções e Adicionais" (product_option_groups / product_option_items).
 */
const _createOptions = async (companyId, productId, options) => {
  if (!Array.isArray(options) || options.length === 0) return;
  for (let i = 0; i < options.length; i++) {
    const g = options[i];
    if (!g || !Array.isArray(g.items) || g.items.length === 0) continue;
    try {
      await optionsService.create({
        company_id: companyId,
        product_id: productId,
        name: g.name || "Adicionais",
        type: g.type || "multiple",
        min_selection: g.min_selection ?? 0,
        max_selection: g.max_selection ?? 0,
        is_required: !!g.is_required,
        sort_order: i,
        items: g.items.map((it, j) => ({
          name: it.name,
          additional_price: it.additional_price ?? 0,
          sort_order: j,
          is_active: true,
        })),
      });
    } catch (e) {
      console.error("Falha ao criar grupo de opções:", g.name, e.message);
    }
  }
};

// ─── POST /ifood/import-preview ─────────────────────────────────────────────

const importPreview = async (req, res) => {
  const restaurantUrl = (req.body?.restaurantUrl || "").toString().trim();
  if (!restaurantUrl || !/^https?:\/\/.+ifood\.com\.br\//i.test(restaurantUrl)) {
    return res.status(400).json({ error: "INVALID_URL", message: "URL do iFood inválida." });
  }

  try {
    const dataset = await ifoodService.fetchIfoodMenu(restaurantUrl);
    const { restaurantName, items, restaurantsFound } = ifoodService.normalizeMenu(dataset);

    if (restaurantsFound === 0) {
      return res.status(404).json({ error: "INVALID_URL", message: "Não foi possível localizar esse restaurante." });
    }

    const categories = [...new Set(items.map((i) => i.section).filter(Boolean))];
    const withImage = items.filter((i) => !!i.imageUrl).length;

    return res.status(200).json({
      success: true,
      restaurantName: restaurantName || null,
      items,
      stats: {
        categories: categories.length,
        products: items.length,
        withImage,
      },
    });
  } catch (error) {
    if (error.code === "APIFY_FAILED") {
      console.error("Apify falhou:", error.detail);
      return res.status(502).json({ error: "APIFY_FAILED", message: "Falha ao consultar o cardápio." });
    }
    console.error("Erro no preview do iFood:", error);
    return res.status(500).json({ error: "UNKNOWN", message: "Erro inesperado ao consultar o cardápio." });
  }
};

// ─── POST /ifood/import ─────────────────────────────────────────────────────

const importMenu = async (req, res) => {
  const companyId = parseInt(req.body?.companyId, 10);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  // 'ignore' | 'update' — o que fazer com produtos já existentes (mesmo nome+categoria)
  const conflictStrategy = req.body?.conflictStrategy === "update" ? "update" : "ignore";

  if (!companyId || Number.isNaN(companyId)) {
    return res.status(400).json({ error: "INVALID_COMPANY", message: "Empresa inválida." });
  }
  if (items.length === 0) {
    return res.status(400).json({ error: "NO_ITEMS", message: "Nenhum produto para importar." });
  }

  const summary = { created: 0, updated: 0, skipped: 0, failed: 0, categoriesCreated: 0, failedNames: [] };

  try {
    // 1) Mapa de categorias existentes (nome → id), criando as que faltam
    //    via o MESMO service do cadastro manual (que já deduplica por nome).
    const existingCats = await categoriesService.findByCompany(companyId);
    const catMap = new Map();
    for (const c of existingCats) catMap.set(_norm(c.name), c.id);

    const neededCats = [...new Set(items.map((i) => (i.categoryName || "Outros").toString().trim()))];
    for (const name of neededCats) {
      const key = _norm(name);
      if (catMap.has(key)) continue;
      try {
        const created = await categoriesService.create({ name, companyId, sortOrder: 999, active: true });
        catMap.set(_norm(created.name), created.id);
        summary.categoriesCreated++;
      } catch (e) {
        console.error("Falha ao criar categoria:", name, e.message);
      }
    }

    // 2) Produtos existentes para deduplicação (nome + categoria)
    const existingItems = await itemsService.findByCompany(companyId);
    const existingByKey = new Map();
    for (const it of existingItems || []) {
      existingByKey.set(`${_norm(it.name)}|${it.category_id}`, it);
    }

    // 3) Cria/atualiza cada produto reutilizando os services de cardápio.
    for (const raw of items) {
      const name = (raw.name || "").toString().trim();
      if (!name) {
        summary.failed++;
        continue;
      }
      const categoryId = catMap.get(_norm(raw.categoryName || "Outros"));
      if (!categoryId) {
        summary.failed++;
        summary.failedNames.push(name);
        continue;
      }

      try {
        const dupKey = `${_norm(name)}|${categoryId}`;
        const existing = existingByKey.get(dupKey);

        if (existing && conflictStrategy === "ignore") {
          summary.skipped++;
          continue;
        }

        // Preço: usa o preço atual; se ausente, cai no original.
        const price = raw.price != null ? raw.price : raw.originalPrice ?? 0;
        const imageUrl = await _rehostImage(raw.imageUrl);

        if (existing && conflictStrategy === "update") {
          await itemsService.update({
            id: existing.id,
            company_id: companyId,
            category_id: categoryId,
            name,
            description: raw.description ?? null,
            price,
            available: existing.available ?? true,
            image_url: imageUrl || existing.image_url || null,
            featured: existing.featured ?? false,
            display_order: existing.display_order ?? null,
            prep_time_minutes: existing.prep_time_minutes ?? null,
            sku: existing.sku ?? null,
          });
          summary.updated++;
        } else {
          const created = await itemsService.create({
            company_id: companyId,
            category_id: categoryId,
            name,
            description: raw.description ?? null,
            price,
            available: true,
            image_url: imageUrl,
            featured: false,
            display_order: null,
            prep_time_minutes: null,
            sku: null,
          });
          // Importa opções/adicionais reaproveitando a estrutura existente.
          await _createOptions(companyId, created.id, raw.options);
          // registra para evitar duplicar dentro do mesmo lote
          existingByKey.set(dupKey, created);
          summary.created++;
        }
      } catch (e) {
        console.error("Falha ao importar produto:", name, e.message);
        summary.failed++;
        summary.failedNames.push(name);
      }
    }

    return res.status(200).json({ success: true, ...summary });
  } catch (error) {
    console.error("Erro na importação do iFood:", error);
    return res.status(500).json({ error: "IMPORT_FAILED", message: "Falha ao importar o cardápio.", ...summary });
  }
};

module.exports = { importPreview, importMenu };
