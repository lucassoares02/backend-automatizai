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
    const { data, status } = await axios.post(tokenUrl, body.toString(), {
      headers: { ..._baseHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
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
      console.error("[iFood] ⚠️ Bloqueio da borda (Akamai). Verifique o User-Agent (IFOOD_USER_AGENT) e se o IP está liberado.");
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
    const { data, status } = await axios.get(url, {
      headers: { ..._baseHeaders(), Authorization: `Bearer ${accessToken}` },
      timeout: 30000,
    });
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
 * Consulta consolidada: detalhes do merchant + produtos + pedidos. Cada seção é
 * resiliente — uma falha isolada não derruba as demais (retorna erro por seção).
 */
const consult = async (companyId) => {
  const saved = await getSavedMerchant(companyId);
  if (!saved.merchantId) {
    throw Object.assign(new Error("Nenhum perfil iFood informado para esta empresa."), {
      status: 400,
      code: "NO_MERCHANT",
    });
  }
  const merchantId = saved.merchantId;

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
  fetchOrders,
  consult,
};
