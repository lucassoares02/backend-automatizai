const axios = require("axios");
const pool = require("../db");

// ─── Configuração ──────────────────────────────────────────────────────────────
// Credenciais de NÍVEL DE APLICAÇÃO (um único app iFood para toda a plataforma).
// O merchant (loja) é identificado por empresa em companies.ifood_merchant_id.
const IFOOD_BASE_URL = (process.env.IFOOD_API_URL || "https://merchant-api.ifood.com.br").replace(/\/$/, "");
const IFOOD_CLIENT_ID = process.env.IFOOD_CLIENT_ID || "";
const IFOOD_CLIENT_SECRET = process.env.IFOOD_CLIENT_SECRET || "";
// A borda (Akamai/Cloudflare) do iFood bloqueia requisições sem User-Agent OU com
// UA que "parece bot" (padrão "+http"). Usamos um UA de NAVEGADOR real, que passa
// pelo bot-management do Cloudflare. Pode ser sobrescrito por IFOOD_USER_AGENT.
const IFOOD_USER_AGENT =
  process.env.IFOOD_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Headers comuns a todas as chamadas. O User-Agent de navegador + Accept-Language
// são o que evita o bloqueio de bot-management (Akamai/Cloudflare) do iFood.
const _baseHeaders = () => ({
  "User-Agent": IFOOD_USER_AGENT,
  Accept: "application/json",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
});

// Mascara o secret em logs (mostra só os últimos 4 caracteres).
const _mask = (v) => (v ? `${"*".repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : "(vazio)");

// Proxy opcional para as chamadas ao iFood. A borda Akamai do iFood bloqueia IPs
// de datacenter/fora do Brasil (HTTP 403 "Access Denied"). Definir um proxy com
// IP brasileiro/residencial resolve sem migrar o servidor inteiro.
// Ex.: IFOOD_PROXY_URL=http://user:pass@host:porta
const IFOOD_PROXY = process.env.IFOOD_PROXY_URL || process.env.IFOOD_HTTPS_PROXY || "";
let _proxyAgent = null;
const _getProxyAgent = () => {
  if (!IFOOD_PROXY) return undefined;
  if (!_proxyAgent) {
    // Compatível com v5 (module.exports = classe) e v6+ (named export).
    const mod = require("https-proxy-agent");
    const HttpsProxyAgent = mod.HttpsProxyAgent || mod;
    _proxyAgent = new HttpsProxyAgent(IFOOD_PROXY);
    console.log(`[iFood] Usando proxy de saída para as chamadas ao iFood.`);
  }
  return _proxyAgent;
};

// Config axios comum: aplica o proxy agent quando configurado. `proxy: false`
// desliga o tratamento nativo do axios para que o httpsAgent seja usado.
const _axiosCfg = (extra = {}) => {
  const agent = _getProxyAgent();
  return agent ? { ...extra, httpsAgent: agent, proxy: false } : extra;
};

const _assertConfigured = () => {
  if (!IFOOD_CLIENT_ID || !IFOOD_CLIENT_SECRET) {
    throw Object.assign(new Error("Integração iFood não configurada (IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET ausentes)."), {
      status: 503,
      code: "IFOOD_NOT_CONFIGURED",
    });
  }
};

// ─── Token de aplicação (client_credentials) — cacheado em memória ─────────────
let _token = null; // { accessToken, expiresAt }

/**
 * Obtém (e cacheia) o access token do app via grant client_credentials.
 * O token é renovado automaticamente 60s antes de expirar.
 */
const getAccessToken = async () => {
  _assertConfigured();
  const now = Date.now();
  if (_token && _token.expiresAt - 60_000 > now) {
    console.log("[iFood] token em cache reutilizado.");
    return _token.accessToken;
  }

  const tokenUrl = `${IFOOD_BASE_URL}/authentication/v1.0/oauth/token`;
  console.log(`[iFood] Solicitando token → POST ${tokenUrl}`);
  console.log(`[iFood]   clientId=${IFOOD_CLIENT_ID || "(vazio)"} clientSecret=${_mask(IFOOD_CLIENT_SECRET)} UA="${IFOOD_USER_AGENT}"`);

  try {
    const body = new URLSearchParams({
      grantType: "client_credentials",
      clientId: IFOOD_CLIENT_ID,
      clientSecret: IFOOD_CLIENT_SECRET,
    });
    const { data, status } = await axios.post(
      tokenUrl,
      body.toString(),
      _axiosCfg({
        headers: { ..._baseHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 20000,
      }),
    );
    const accessToken = data?.accessToken || data?.access_token;
    const expiresIn = Number(data?.expiresIn || data?.expires_in || 3600);
    if (!accessToken) throw new Error("Resposta de token sem accessToken.");
    _token = { accessToken, expiresAt: now + expiresIn * 1000 };
    console.log(`[iFood] Token obtido (HTTP ${status}); expira em ${expiresIn}s.`);
    return accessToken;
  } catch (error) {
    const status = error.response?.status;
    const raw = error.response?.data ?? error.message;
    const snippet = typeof raw === "string" ? raw.slice(0, 400) : JSON.stringify(raw).slice(0, 400);
    console.error(`[iFood] FALHA no token (HTTP ${status ?? "s/ status"}): ${snippet}`);
    if (typeof raw === "string" && /access denied/i.test(raw)) {
      console.error(
        "[iFood] ⚠️ Bloqueio da borda Akamai (HTTP 403). Com o User-Agent de navegador já correto, " +
          "a causa é o IP de saída do servidor (datacenter/fora do BR). Configure IFOOD_PROXY_URL com um " +
          "proxy de IP brasileiro, ou rode a API a partir de um IP no Brasil.",
      );
    }
    const err = new Error("Falha ao autenticar no iFood.");
    err.code = "IFOOD_AUTH_FAILED";
    err.status = 502;
    err.detail = snippet;
    throw err;
  }
};

// Cliente axios autenticado (Bearer) para as APIs do iFood.
const _authGet = async (path) => {
  const accessToken = await getAccessToken();
  const url = `${IFOOD_BASE_URL}${path}`;
  console.log(`[iFood] GET ${url}`);
  try {
    const { data, status } = await axios.get(
      url,
      _axiosCfg({
        headers: { ..._baseHeaders(), Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      }),
    );
    console.log(`[iFood]   ← HTTP ${status} (${Array.isArray(data) ? data.length + " itens" : "objeto"})`);
    return data;
  } catch (error) {
    const status = error.response?.status;
    const raw = error.response?.data ?? error.message;
    const snippet = typeof raw === "string" ? raw.slice(0, 400) : JSON.stringify(raw).slice(0, 400);
    console.error(`[iFood]   ← FALHA GET ${path} (HTTP ${status ?? "s/ status"}): ${snippet}`);
    throw error;
  }
};

// ─── Persistência (companies) ───────────────────────────────────────────────────

/**
 * Perfil iFood salvo da empresa (merchant id + nome cacheado + data de conexão).
 */
const getSavedMerchant = async (companyId) => {
  const r = await pool.query(
    `SELECT id, name, ifood_merchant_id, ifood_merchant_name, ifood_connected_at
     FROM companies WHERE id = $1`,
    [companyId],
  );
  const row = r.rows[0];
  if (!row) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  return {
    companyId: row.id,
    merchantId: row.ifood_merchant_id || null,
    merchantName: row.ifood_merchant_name || null,
    connectedAt: row.ifood_connected_at || null,
    connected: !!row.ifood_merchant_id,
  };
};

/**
 * Salva/atualiza o merchant id informado pelo comerciante. Passar null/"" limpa
 * a conexão (desvincula o perfil).
 */
const saveMerchant = async (companyId, merchantId) => {
  const clean = (merchantId || "").toString().trim();
  if (clean) {
    await pool.query(
      `UPDATE companies
       SET ifood_merchant_id = $2, ifood_connected_at = NOW()
       WHERE id = $1`,
      [companyId, clean],
    );
  } else {
    await pool.query(
      `UPDATE companies
       SET ifood_merchant_id = NULL, ifood_merchant_name = NULL, ifood_connected_at = NULL
       WHERE id = $1`,
      [companyId],
    );
  }
  return getSavedMerchant(companyId);
};

const _cacheMerchantName = async (companyId, name) => {
  if (!name) return;
  await pool.query("UPDATE companies SET ifood_merchant_name = $2 WHERE id = $1", [companyId, name]);
};

const _resolveMerchantId = async (companyId, requestedMerchantId = null) => {
  const saved = await getSavedMerchant(companyId);
  const merchantId = (requestedMerchantId || saved.merchantId || "").toString().trim();
  if (!merchantId) {
    throw Object.assign(new Error("Nenhum perfil iFood informado para esta empresa."), {
      status: 400,
      code: "NO_MERCHANT",
    });
  }
  return merchantId;
};

const _priceValue = (price) => {
  if (price == null) return null;
  if (typeof price === "object") return price.value ?? null;
  return price;
};

const _resourceId = (resource) => {
  if (resource == null) return null;
  if (typeof resource !== "object") return resource.toString();
  return (resource.id || resource.optionId || resource.optionGroupId || "").toString() || null;
};

/**
 * Transforma o retorno `flat` do catálogo em um contrato simples para o Portal.
 * O iFood devolve item, produtos, grupos e opções em coleções relacionadas por
 * ids; aqui as opções já ficam aninhadas em seus respectivos grupos.
 */
const normalizeProductDetails = (payload) => {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload || {};
  const item = data.item && typeof data.item === "object" ? data.item : {};
  const products = Array.isArray(data.products) ? data.products : [];
  const optionGroups = Array.isArray(data.optionGroups) ? data.optionGroups : [];
  const options = Array.isArray(data.options) ? data.options : [];
  const productsById = new Map(products.map((product) => [_resourceId(product), product]));
  const groupsById = new Map(optionGroups.map((group) => [_resourceId(group), group]));
  const optionsById = new Map(options.map((option) => [_resourceId(option), option]));
  const mainProduct = productsById.get(_resourceId(item.productId)) || products[0] || {};
  const groupReferences = Array.isArray(mainProduct.optionGroups)
    ? mainProduct.optionGroups
    : Array.isArray(item.optionGroups)
      ? item.optionGroups
      : [];
  const selectedGroups = groupReferences.length ? groupReferences : optionGroups;

  const normalizedGroups = selectedGroups.map((reference) => {
    const groupId = _resourceId(reference);
    const group = groupsById.get(groupId) || (typeof reference === "object" ? reference : {});
    const nestedOptions = Array.isArray(group.options) ? group.options : [];
    const optionIds = Array.isArray(group.optionIds) ? group.optionIds.map(_resourceId).filter(Boolean) : [];
    let selectedOptions = optionIds.map((id) => optionsById.get(id)).filter(Boolean);
    if (!selectedOptions.length && nestedOptions.length) selectedOptions = nestedOptions;
    if (!selectedOptions.length) {
      selectedOptions = options.filter((option) => {
        const optionGroupId = _resourceId(option.optionGroupId || option.groupId);
        return optionGroupId && optionGroupId === groupId;
      });
    }
    if (!selectedOptions.length && selectedGroups.length === 1) selectedOptions = options;

    const minimum = Number(reference?.min ?? reference?.minimum ?? group?.min ?? group?.minimum ?? 0);
    const maximum = Number(reference?.max ?? reference?.maximum ?? group?.max ?? group?.maximum ?? 0);

    return {
      id: groupId,
      name: group?.name || "Complementos",
      status: group?.status || null,
      type: group?.optionGroupType || group?.type || null,
      min: Number.isFinite(minimum) ? minimum : 0,
      max: Number.isFinite(maximum) ? maximum : 0,
      options: selectedOptions.map((option) => {
        const optionProduct = productsById.get(_resourceId(option?.productId)) || {};
        return {
          id: _resourceId(option),
          productId: _resourceId(option?.productId),
          name: optionProduct?.name || option?.name || "Complemento",
          description: optionProduct?.description || option?.description || null,
          price: _priceValue(option?.price),
          status: option?.status || optionProduct?.status || null,
          externalCode: option?.externalCode || optionProduct?.externalCode || null,
          imageUrl: optionProduct?.imagePath || optionProduct?.imageUrl || optionProduct?.image || null,
        };
      }),
    };
  });

  return {
    id: _resourceId(item) || null,
    productId: _resourceId(item.productId),
    name: mainProduct?.name || item?.name || null,
    description: mainProduct?.description || item?.description || null,
    imageUrl: mainProduct?.imagePath || mainProduct?.imageUrl || mainProduct?.image || item?.imagePath || null,
    type: item?.type || null,
    status: item?.status || null,
    categoryId: _resourceId(item.categoryId),
    externalCode: item?.externalCode || mainProduct?.externalCode || null,
    price: _priceValue(item?.price),
    originalPrice: item?.price && typeof item.price === "object" ? item.price.originalValue ?? null : null,
    optionGroups: normalizedGroups,
  };
};

// ─── Consultas à API do iFood ───────────────────────────────────────────────────

/**
 * Detalhes do merchant (nome, nome fantasia, endereço, telefone...). Cacheia o
 * nome retornado em companies.ifood_merchant_name.
 */
const fetchMerchantDetails = async (companyId, merchantId) => {
  const data = await _authGet(`/merchant/v1.0/merchants/${encodeURIComponent(merchantId)}`);
  const name = data?.name || data?.corporateName || null;
  if (name) await _cacheMerchantName(companyId, name);
  return {
    id: data?.id || merchantId,
    name: data?.name || null,
    corporateName: data?.corporateName || null,
    phone: data?.phones?.[0] || data?.phone || null,
    address: data?.address || null,
    status: data?.status || null,
    raw: data || null,
  };
};

/**
 * Catálogo/produtos do merchant. Percorre os catálogos e suas categorias
 * (includeItems=true) e devolve uma lista plana de produtos.
 */
const fetchProducts = async (merchantId) => {
  const catalogs = await _authGet(`/catalog/v2.0/merchants/${encodeURIComponent(merchantId)}/catalogs`);
  const catalogList = Array.isArray(catalogs) ? catalogs : [];
  const products = [];

  for (const cat of catalogList) {
    const catalogId = cat?.catalogId || cat?.id || cat?.groupId;
    if (!catalogId) continue;
    let categories = [];
    try {
      categories = await _authGet(
        `/catalog/v2.0/merchants/${encodeURIComponent(merchantId)}/catalogs/${encodeURIComponent(catalogId)}/categories?includeItems=true`,
      );
    } catch (_) {
      continue;
    }
    for (const category of Array.isArray(categories) ? categories : []) {
      const categoryName = category?.name || "Outros";
      for (const item of Array.isArray(category?.items) ? category.items : []) {
        products.push({
          id: item?.id || item?.itemId || null,
          name: item?.name || null,
          description: item?.description || null,
          price: item?.price?.value ?? item?.price ?? null,
          imageUrl: item?.imagePath || item?.image || null,
          status: item?.status || null,
          category: categoryName,
        });
      }
    }
  }
  return products;
};

/**
 * Carrega um único item no formato `flat`, incluindo grupos e complementos.
 * É chamado sob demanda quando o comerciante abre os detalhes no Portal.
 */
const fetchProductDetails = async (companyId, itemId, requestedMerchantId = null) => {
  const merchantId = await _resolveMerchantId(companyId, requestedMerchantId);
  const raw = await _authGet(
    `/catalog/v2.0/merchants/${encodeURIComponent(merchantId)}/items/${encodeURIComponent(itemId)}/flat`,
  );
  return {
    merchantId,
    itemId,
    product: normalizeProductDetails(raw),
  };
};

/**
 * Pedidos recentes do merchant via polling de eventos. Para cada evento de
 * pedido, hidrata os detalhes (até `limit` pedidos).
 */
const fetchOrders = async (merchantId, limit = 20) => {
  let events = [];
  try {
    events = await _authGet(`/order/v1.0/events:polling?types=PLACED,CONFIRMED,CANCELLED`);
  } catch (_) {
    events = [];
  }
  const list = Array.isArray(events) ? events : [];
  const seen = new Set();
  const orderIds = [];
  for (const ev of list) {
    const orderId = ev?.orderId;
    if (!orderId || seen.has(orderId)) continue;
    // Filtra pelo merchant quando o evento traz merchantId.
    if (ev?.merchantId && ev.merchantId !== merchantId) continue;
    seen.add(orderId);
    orderIds.push(orderId);
    if (orderIds.length >= limit) break;
  }

  const orders = [];
  for (const orderId of orderIds) {
    try {
      const o = await _authGet(`/order/v1.0/orders/${encodeURIComponent(orderId)}`);
      orders.push({
        id: o?.id || orderId,
        displayId: o?.displayId || null,
        status: o?.status || null,
        createdAt: o?.createdAt || null,
        total: o?.total?.orderAmount ?? o?.total ?? null,
        customerName: o?.customer?.name || null,
        itemsCount: Array.isArray(o?.items) ? o.items.length : null,
      });
    } catch (_) {
      orders.push({ id: orderId, status: "UNKNOWN" });
    }
  }
  return orders;
};

/**
 * Consulta consolidada: detalhes do merchant + produtos + pedidos. O merchant
 * informado na requisição tem prioridade; quando ausente, usa o perfil salvo.
 * Cada seção é resiliente — uma falha isolada não derruba as demais.
 */
const consult = async (companyId, requestedMerchantId = null) => {
  const merchantId = await _resolveMerchantId(companyId, requestedMerchantId);

  const result = { merchantId, merchant: null, products: [], orders: [], errors: {} };

  try {
    result.merchant = await fetchMerchantDetails(companyId, merchantId);
  } catch (e) {
    result.errors.merchant = e.detail || e.message;
  }
  try {
    result.products = await fetchProducts(merchantId);
  } catch (e) {
    result.errors.products = e.response?.data || e.message;
  }
  try {
    result.orders = await fetchOrders(merchantId);
  } catch (e) {
    result.errors.orders = e.response?.data || e.message;
  }

  result.stats = {
    products: result.products.length,
    orders: result.orders.length,
  };
  return result;
};

module.exports = {
  getAccessToken,
  getSavedMerchant,
  saveMerchant,
  fetchMerchantDetails,
  fetchProducts,
  fetchProductDetails,
  fetchOrders,
  consult,
  _private: { normalizeProductDetails },
};
