const axios = require("axios");

const pool = require("../db");
const { normalizePhone } = require("../helpers/phone");
const { tableExists } = require("../helpers/schema");

const DEFAULT_API_URL = "https://api.uber.com/v1";
const DEFAULT_OAUTH_URL = "https://login.uber.com/oauth/v2/token";
const DEFAULT_OAUTH_SCOPE = "eats.deliveries";
const DEFAULT_PREP_MINUTES = 20;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

let oauthTokenCache = null;
let oauthTokenRequest = null;

const serviceError = (status, message, code, details) =>
  Object.assign(new Error(message), {
    status,
    code,
    ...(details ? { details } : {}),
  });

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toE164 = (phone, label) => {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw serviceError(
      422,
      `O telefone ${label} precisa estar completo, com DDD.`,
      "UBER_DIRECT_INVALID_PHONE",
    );
  }
  return `+${normalized}`;
};

const buildAddressLine = (address) => {
  if (!address) return "";
  const zip = String(address.zip ?? address.zip_code ?? "").replace(/\D/g, "");
  const cityState = [address.city, address.state]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" - ");
  return [
    [address.street, address.number]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(", "),
    address.complement,
    address.neighborhood,
    cityState,
    zip,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" - ");
};

const normalizeAddress = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const includesAddressPart = (target, part) =>
  !part || ` ${target} `.includes(` ${part} `);

const findMatchingSavedAddress = (addresses, deliveryAddress, snapshot) => {
  const target = normalizeAddress(deliveryAddress);
  const snapshotStreet = normalizeAddress(snapshot?.street);
  const snapshotNumber = normalizeAddress(snapshot?.number);

  return (
    addresses.find((address) => {
      const street = normalizeAddress(address.street);
      const number = normalizeAddress(address.number);
      if (!street) return false;
      if (snapshotStreet) {
        return (
          street === snapshotStreet &&
          (!snapshotNumber || number === snapshotNumber)
        );
      }
      return target.includes(street) && includesAddressPart(target, number);
    }) || null
  );
};

const addMinutes = (date, minutes) =>
  new Date(date.getTime() + minutes * 60 * 1000);

const quoteTimeWindow = (prepMinutes, now = new Date()) => {
  const safePrep = Math.min(
    180,
    Math.max(
      5,
      Number.isFinite(Number(prepMinutes))
        ? Number(prepMinutes)
        : DEFAULT_PREP_MINUTES,
    ),
  );
  const pickupReady = addMinutes(now, safePrep);
  const pickupDeadline = addMinutes(pickupReady, 20);
  const dropoffReady = addMinutes(pickupDeadline, 5);
  const dropoffDeadline = addMinutes(dropoffReady, 15);
  return {
    pickup_ready_dt: pickupReady.toISOString(),
    pickup_deadline_dt: pickupDeadline.toISOString(),
    dropoff_ready_dt: dropoffReady.toISOString(),
    dropoff_deadline_dt: dropoffDeadline.toISOString(),
  };
};

const getOrderContext = async (orderId) => {
  const result = await pool.query(
    `SELECT
       o.id, o.company_id, o.client_id, o.delivery_address, o.delivery_type,
       o.subtotal, o.total,
       (to_jsonb(o)->>'delivery_lat')::numeric AS delivery_lat,
       (to_jsonb(o)->>'delivery_lng')::numeric AS delivery_lng,
       to_jsonb(o)->'delivery_address_snapshot' AS delivery_address_snapshot,
       c.name AS client_name, c.phone AS client_phone,
       (to_jsonb(c)->>'user_id')::bigint AS client_user_id,
       co.name AS company_name, co.phone AS company_phone,
       to_jsonb(co)->>'slug' AS company_slug,
       COALESCE((
         SELECT MAX(mi.prep_time_minutes)
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id = o.id
           AND mi.prep_time_minutes IS NOT NULL
           AND mi.prep_time_minutes > 0
       ), $2)::int AS prep_minutes
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     JOIN companies co ON co.id = o.company_id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId, DEFAULT_PREP_MINUTES],
  );
  return result.rows[0] || null;
};

const getCompanyAddress = async (companyId) => {
  const result = await pool.query(
    `SELECT street, number, complement, neighborhood, city, state, zip_code,
            latitude, longitude
     FROM company_addresses
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [companyId],
  );
  return result.rows[0] || null;
};

const getSavedClientAddresses = async (userId) => {
  if (!userId || !(await tableExists("user_addresses"))) return [];
  const result = await pool.query(
    `SELECT street, number, complement, neighborhood, city, state, zip,
            latitude, longitude
     FROM user_addresses
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return result.rows;
};

const appendCoordinates = (payload, prefix, source) => {
  const latitude = toNumber(source?.latitude ?? source?.lat);
  const longitude = toNumber(source?.longitude ?? source?.lng);
  if (latitude !== null && longitude !== null) {
    payload[`${prefix}_latitude`] = latitude;
    payload[`${prefix}_longitude`] = longitude;
  }
};

const buildQuotePayload = ({ order, companyAddress, savedAddress, now }) => {
  const pickupAddress = buildAddressLine(companyAddress);
  const snapshot = order.delivery_address_snapshot;
  const dropoffAddress =
    buildAddressLine(snapshot) || String(order.delivery_address ?? "").trim();

  if (!pickupAddress) {
    throw serviceError(
      422,
      "Cadastre o endereço do estabelecimento antes de solicitar a cotação.",
      "UBER_DIRECT_PICKUP_ADDRESS_MISSING",
    );
  }
  if (!dropoffAddress) {
    throw serviceError(
      422,
      "O pedido não possui um endereço de entrega válido.",
      "UBER_DIRECT_DROPOFF_ADDRESS_MISSING",
    );
  }

  const productValue = toNumber(order.subtotal) ?? toNumber(order.total) ?? 0;
  const payload = {
    pickup_address: pickupAddress,
    pickup_name: String(order.company_name ?? "Estabelecimento").trim(),
    pickup_phone_number: toE164(order.company_phone, "do estabelecimento"),
    ...quoteTimeWindow(order.prep_minutes, now),
    dropoff_address: dropoffAddress,
    dropoff_name: String(order.client_name ?? "Cliente").trim(),
    dropoff_phone_number: toE164(order.client_phone, "do cliente"),
    manifest_total_value: Math.max(0, Math.round(productValue * 100)),
    external_store_id: String(
      order.company_slug || `company-${order.company_id}`,
    ).slice(0, 64),
  };

  appendCoordinates(payload, "pickup", companyAddress);
  appendCoordinates(
    payload,
    "dropoff",
    toNumber(order.delivery_lat) !== null &&
      toNumber(order.delivery_lng) !== null
      ? { latitude: order.delivery_lat, longitude: order.delivery_lng }
      : savedAddress,
  );

  return payload;
};

const normalizeQuote = (data) => ({
  id: data?.id ?? null,
  fee: toNumber(data?.fee),
  currency: String(data?.currency ?? "BRL").toUpperCase(),
  created_at: data?.created ?? null,
  expires_at: data?.expires ?? null,
  dropoff_eta: data?.dropoff_eta ?? null,
  duration_minutes: toNumber(data?.duration),
  pickup_duration_minutes: toNumber(data?.pickup_duration),
});

const clearOAuthTokenCache = () => {
  oauthTokenCache = null;
};

const requestOAuthToken = async () => {
  const clientId = String(process.env.UBER_DIRECT_CLIENT_ID ?? "").trim();
  const clientSecret = String(
    process.env.UBER_DIRECT_CLIENT_SECRET ?? "",
  ).trim();
  const scope = String(
    process.env.UBER_DIRECT_OAUTH_SCOPE || DEFAULT_OAUTH_SCOPE,
  ).trim();
  const oauthUrl = String(
    process.env.UBER_DIRECT_OAUTH_URL || DEFAULT_OAUTH_URL,
  ).trim();

  if (!clientId || !clientSecret) {
    throw serviceError(
      503,
      "A autenticação da Uber Direct ainda não foi configurada.",
      "UBER_DIRECT_AUTH_NOT_CONFIGURED",
    );
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope,
  });

  try {
    const response = await axios.post(oauthUrl, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });
    const accessToken = String(response.data?.access_token ?? "").trim();
    if (!accessToken) {
      throw serviceError(
        502,
        "A Uber não retornou um token de acesso válido.",
        "UBER_DIRECT_AUTH_INVALID_RESPONSE",
      );
    }
    const expiresInSeconds = Math.max(
      60,
      toNumber(response.data?.expires_in) ?? 300,
    );
    oauthTokenCache = {
      accessToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
    return accessToken;
  } catch (error) {
    if (error.status) throw error;
    const providerData = error.response?.data;
    const providerMessage =
      providerData?.error_description || providerData?.message || null;
    throw serviceError(
      502,
      providerMessage
        ? `Não foi possível autenticar na Uber Direct: ${providerMessage}`
        : "Não foi possível autenticar na Uber Direct.",
      "UBER_DIRECT_AUTH_FAILED",
    );
  }
};

const getOAuthToken = async ({ forceRefresh = false } = {}) => {
  if (
    !forceRefresh &&
    oauthTokenCache?.accessToken &&
    oauthTokenCache.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()
  ) {
    return oauthTokenCache.accessToken;
  }
  if (oauthTokenRequest) return oauthTokenRequest;

  if (forceRefresh) clearOAuthTokenCache();
  oauthTokenRequest = requestOAuthToken();
  try {
    return await oauthTokenRequest;
  } finally {
    oauthTokenRequest = null;
  }
};

const requestDeliveryQuote = (url, payload, token) =>
  axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

const createDeliveryQuote = async (orderId) => {
  const customerId = String(process.env.UBER_DIRECT_CUSTOMER_ID ?? "").trim();
  if (!customerId) {
    throw serviceError(
      503,
      "O identificador de cliente da Uber Direct ainda não foi configurado.",
      "UBER_DIRECT_NOT_CONFIGURED",
    );
  }

  const order = await getOrderContext(orderId);
  if (!order) {
    throw serviceError(404, "Pedido não encontrado.", "ORDER_NOT_FOUND");
  }
  if (order.delivery_type === false) {
    throw serviceError(
      422,
      "Pedidos para retirada não podem ser cotados para entrega.",
      "UBER_DIRECT_PICKUP_ORDER",
    );
  }

  const companyAddress = await getCompanyAddress(order.company_id);
  const savedAddresses = await getSavedClientAddresses(order.client_user_id);
  const savedAddress = findMatchingSavedAddress(
    savedAddresses,
    order.delivery_address,
    order.delivery_address_snapshot,
  );
  const payload = buildQuotePayload({ order, companyAddress, savedAddress });
  const baseUrl = String(
    process.env.UBER_DIRECT_API_URL || DEFAULT_API_URL,
  ).replace(/\/+$/, "");
  const url = `${baseUrl}/customers/${encodeURIComponent(customerId)}/delivery_quotes`;

  try {
    let token = await getOAuthToken();
    let response;
    try {
      response = await requestDeliveryQuote(url, payload, token);
    } catch (error) {
      // O token pode ter sido revogado antes do expires_in. Em um 401, descarta
      // o cache, autentica novamente e repete a cotação uma única vez.
      if (error.response?.status !== 401) throw error;
      token = await getOAuthToken({ forceRefresh: true });
      response = await requestDeliveryQuote(url, payload, token);
    }
    const quote = normalizeQuote(response.data);
    if (quote.fee === null) {
      throw serviceError(
        502,
        "A Uber Direct respondeu sem o valor da cotação.",
        "UBER_DIRECT_INVALID_RESPONSE",
      );
    }
    return {
      provider: "uber_direct",
      quote,
      pickup: {
        address: payload.pickup_address,
        ready_at: payload.pickup_ready_dt,
        deadline_at: payload.pickup_deadline_dt,
      },
      dropoff: {
        address: payload.dropoff_address,
        ready_at: payload.dropoff_ready_dt,
        deadline_at: payload.dropoff_deadline_dt,
      },
    };
  } catch (error) {
    if (error.status) throw error;
    const providerData = error.response?.data;
    const providerMessage =
      providerData?.message ||
      (typeof providerData?.error === "string"
        ? providerData.error
        : providerData?.error?.message) ||
      providerData?.code ||
      null;
    throw serviceError(
      502,
      providerMessage
        ? `A Uber Direct não conseguiu gerar a cotação: ${providerMessage}`
        : "Não foi possível obter a cotação da Uber Direct. Tente novamente.",
      "UBER_DIRECT_QUOTE_FAILED",
    );
  }
};

module.exports = {
  createDeliveryQuote,
  _private: {
    buildAddressLine,
    buildQuotePayload,
    findMatchingSavedAddress,
    clearOAuthTokenCache,
    getOAuthToken,
    normalizeQuote,
    quoteTimeWindow,
  },
};
