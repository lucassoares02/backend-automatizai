const axios = require("axios");

// Actor da Apify que faz a inteligência do restaurante iFood.
const APIFY_ACTOR = process.env.APIFY_ACTOR || "";
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const APIFY_URL = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

// Converte preços vindos em número ou string ("R$ 12,90", "12.90") para Number.
const _toNumber = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v)
    .replace(/[^\d.,-]/g, "")
    .trim();
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // formato pt-BR "1.234,56"
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const _str = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

// Limpa o nome de uma categoria: mantém só letras (incl. acentuadas) e números,
// remove qualquer caractere especial (>>, <<, |, -, etc.), colapsa espaços e
// aplica Title Case → "Açaí Especial".
const _sanitizeCategory = (v) => {
  let s = (v == null ? "" : String(v))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "Outros";
  s = s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return s || "Outros";
};

// Extrai grupos de opções/adicionais/complementos de um item, de forma
// tolerante a variações de estrutura do retorno da Apify. Normaliza para o
// formato que o cadastro de "Opções e Adicionais" utiliza.
const _GROUP_KEYS = [
  "optionGroups",
  "complementGroups",
  "complements",
  "garnishCategories",
  "choices",
  "customizations",
  "additionalGroups",
  "modifierGroups",
  "options",
];
const _ITEM_KEYS = ["items", "options", "garnishItems", "garnishes", "choices", "complements", "modifiers", "additionalItems"];

const _extractOptions = (raw) => {
  if (!raw || typeof raw !== "object") return [];
  const groups = [];
  for (const gk of _GROUP_KEYS) {
    const arr = raw[gk];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    for (const g of arr) {
      if (!g || typeof g !== "object") continue;
      const name = _str(g.name || g.title || g.label || g.category);
      let itemsArr = null;
      for (const ik of _ITEM_KEYS) {
        if (Array.isArray(g[ik]) && g[ik].length) {
          itemsArr = g[ik];
          break;
        }
      }
      if (!Array.isArray(itemsArr)) continue;

      const items = [];
      for (const it of itemsArr) {
        if (!it || typeof it !== "object") continue;
        const iName = _str(it.name || it.title || it.description || it.label);
        if (!iName) continue;
        items.push({
          name: iName,
          additional_price: _toNumber(it.price ?? it.unitPrice ?? it.additionalPrice ?? it.value) ?? 0,
        });
      }
      if (items.length === 0) continue;

      const min = _toNumber(g.min ?? g.minQuantity ?? g.minSelection ?? g.min_selection) ?? 0;
      const max = _toNumber(g.max ?? g.maxQuantity ?? g.maxSelection ?? g.max_selection) ?? 0;
      const type = max != null && max <= 1 && max !== 0 ? "single" : "multiple";
      groups.push({
        name: name || "Adicionais",
        type,
        min_selection: Math.max(0, Math.round(min)),
        max_selection: Math.max(0, Math.round(max)),
        is_required: g.required === true || g.isRequired === true || min > 0,
        items,
      });
    }
    // não dá break: alguns atores usam mais de uma chave simultânea
  }
  return groups;
};

// Empurra um item normalizado para [out], ignorando entradas sem nome.
const _pushItem = (out, section, raw) => {
  if (!raw || typeof raw !== "object") return;
  const name = _str(raw.name || raw.title || raw.productName);
  if (!name) return;
  out.push({
    section: _sanitizeCategory(section),
    name,
    details: _str(raw.details || raw.description || raw.detail),
    price: _toNumber(raw.price ?? raw.unitPrice ?? raw.value ?? raw.currentPrice),
    originalPrice: _toNumber(raw.originalPrice ?? raw.original_price ?? raw.oldPrice ?? raw.unitOriginalPrice),
    imageUrl: _str(raw.imageUrl || raw.image || raw.logoUrl || raw.photo || raw.picture),
    options: _extractOptions(raw),
  });
};

/**
 * Normaliza a resposta do dataset da Apify para uma lista plana de itens
 * { section, name, details, price, originalPrice, imageUrl }.
 * É tolerante a variações de estrutura (menu como array de seções, itens
 * planos com campo `section`, etc.).
 */
const normalizeMenu = (dataset) => {
  const restaurants = Array.isArray(dataset) ? dataset : dataset ? [dataset] : [];
  const out = [];
  let restaurantName = null;

  for (const r of restaurants) {
    if (!r || typeof r !== "object") continue;
    restaurantName = restaurantName || _str(r.name || r.restaurantName || r.title);

    const menu = r.menu || r.menuItems || r.categories || r.sections || r.menus || [];
    const list = Array.isArray(menu) ? menu : [];

    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const children = entry.items || entry.products || entry.dishes || entry.menuItems || null;
      const sectionName = entry.section || entry.category || entry.name || entry.title || "Outros";
      if (Array.isArray(children)) {
        for (const it of children) _pushItem(out, sectionName, it);
      } else {
        _pushItem(out, entry.section || entry.category || "Outros", entry);
      }
    }

    // Fallback: alguns atores entregam itens planos em r.items com campo section.
    if (Array.isArray(r.items)) {
      for (const it of r.items) _pushItem(out, it.section || it.category || "Outros", it);
    }
  }

  return { restaurantName, items: out, restaurantsFound: restaurants.length };
};

/**
 * Consome a Apify de forma síncrona e devolve o dataset cru.
 * Lança um erro com `code` para o controller mapear a resposta.
 */
const fetchIfoodMenu = async (restaurantUrl) => {
  try {
    const { data } = await axios.post(
      APIFY_URL,
      {
        restaurantUrls: [restaurantUrl],
        includeMenu: true,
        includeReviews: false,
        maxMenuItems: 500,
        downloadImages: false,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 180000,
      },
    );
    return data;
  } catch (error) {
    const err = new Error("Falha ao consultar a Apify");
    err.code = "APIFY_FAILED";
    err.detail = error.response?.data || error.message;
    throw err;
  }
};

module.exports = { fetchIfoodMenu, normalizeMenu, _toNumber };
