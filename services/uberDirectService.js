const axios = require("axios");

const pool = require("../db");
const { normalizePhone } = require("../helpers/phone");
const { tableExists } = require("../helpers/schema");

const DEFAULT_API_URL = "https://api.uber.com/v1";
const DEFAULT_OAUTH_URL = "https://login.uber.com/oauth/v2/token";
const DEFAULT_OAUTH_SCOPE = "eats.deliveries";
const DEFAULT_PREP_MINUTES = 20;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
// Folga antes da coleta quando o pedido ainda não começou a ser preparado
// (aceite + início do preparo).
const PICKUP_BUFFER_MINUTES = 50;
// Folga curta quando o preparo já começou ou o pedido já está pronto.
const READY_PICKUP_BUFFER_MINUTES = 10;

// Status do pedido (ver ordersService/orderStatusNotificationService).
const STATUS_PREPARING = 3;
const STATUS_READY = new Set([4, 8]); // Em Entrega, Pronto
const STATUS_FINAL = new Set([5, 6, 7, 9]); // Entregue, Cancelado, Rejeitado, Retirado

const TIMEOUT_ERROR_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);
const isTimeoutError = (error) =>
  !error?.response && TIMEOUT_ERROR_CODES.has(error?.code);

// Mensagens amigáveis para recusas conhecidas da Uber (4xx).
const PROVIDER_REJECTION_MESSAGES = {
  address_undeliverable:
    "O endereço de entrega está fora da área atendida pela Uber Direct.",
  address_undeliverable_limited_couriers:
    "No momento não há entregadores da Uber Direct disponíveis para este endereço.",
  unknown_location:
    "A Uber Direct não conseguiu localizar um dos endereços do pedido.",
  invalid_params:
    "A Uber Direct recusou os dados enviados para a cotação.",
};

let oauthTokenCache = null;
let oauthTokenRequest = null;

const serviceError = (status, message, code, details) =>
  Object.assign(new Error(message), {
    isUberDirectServiceError: true,
    status,
    code,
    ...(details ? { details } : {}),
  });

const isServiceError = (error) =>
  error?.isUberDirectServiceError === true;

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

const formatZip = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
};

// Formato estruturado da Uber: string JSON com street_address[], city, state,
// zip_code e country. Só é montado quando há rua e cidade; senão retorna null
// e o chamador usa o texto livre.
const buildStructuredAddress = (address) => {
  if (!address) return null;
  const clean = (value) => String(value ?? "").trim();
  const line1 = [clean(address.street), clean(address.number)]
    .filter(Boolean)
    .join(", ");
  const city = clean(address.city);
  if (!clean(address.street) || !city) return null;
  const line2 = [clean(address.complement), clean(address.neighborhood)]
    .filter(Boolean)
    .join(" - ");
  return JSON.stringify({
    street_address: [line1, line2].filter(Boolean),
    city,
    state: clean(address.state).toUpperCase(),
    zip_code: formatZip(address.zip ?? address.zip_code),
    country: "BR",
  });
};

// UBER_DIRECT_ADDRESS_FORMAT=text força o texto livre (útil na homologação);
// o padrão é o formato estruturado, com fallback para texto quando faltam
// partes do endereço.
const addressFormat = () =>
  String(process.env.UBER_DIRECT_ADDRESS_FORMAT || "structured")
    .trim()
    .toLowerCase() === "text"
    ? "text"
    : "structured";

const resolveAddress = (structuredSource, text, format) => {
  const structured =
    format === "structured" ? buildStructuredAddress(structuredSource) : null;
  return structured
    ? { value: structured, text, format: "structured" }
    : { value: text, text, format: "text" };
};

const buildQuoteAddresses = ({ order, companyAddress, format = addressFormat() }) => {
  const snapshot = order.delivery_address_snapshot;
  const pickupText = buildAddressLine(companyAddress);
  const dropoffText =
    buildAddressLine(snapshot) || String(order.delivery_address ?? "").trim();
  return {
    pickup: resolveAddress(companyAddress, pickupText, format),
    dropoff: resolveAddress(snapshot, dropoffText, format),
  };
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

const quoteTimeWindow = (
  prepMinutes,
  now = new Date(),
  { bufferMinutes = PICKUP_BUFFER_MINUTES, minPrepMinutes = 5 } = {},
) => {
  const safePrep = Math.min(
    180,
    Math.max(
      minPrepMinutes,
      Number.isFinite(Number(prepMinutes))
        ? Number(prepMinutes)
        : DEFAULT_PREP_MINUTES,
    ),
  );
  // Além do tempo de preparo, adiciona uma folga antes do courier retirar.
  const pickupReady = addMinutes(now, safePrep + bufferMinutes);
  const pickupDeadline = addMinutes(pickupReady, 20);
  // O destinatário já precisa estar apto a receber antes do limite de coleta.
  // A Uber rejeita dropoff_ready_dt posterior a pickup_deadline_dt com
  // `dropoff_ready_after_pickup_deadline`.
  const dropoffReady = pickupReady;
  // A Uber Direct exige que o dropoff_deadline seja pelo menos 20 min após o
  // dropoff_ready (erro dropoff_deadline_too_early). Mantemos o prazo final que
  // já era usado, 35 min após o limite de coleta, sem encurtar a entrega.
  const dropoffDeadline = addMinutes(pickupDeadline, 35);
  return {
    pickup_ready_dt: pickupReady.toISOString(),
    pickup_deadline_dt: pickupDeadline.toISOString(),
    dropoff_ready_dt: dropoffReady.toISOString(),
    dropoff_deadline_dt: dropoffDeadline.toISOString(),
  };
};

// Quanto falta para o pedido ficar pronto, conforme o status atual:
// - pronto/em entrega: nada de preparo, só a folga curta;
// - em preparo: desconta o tempo desde que entrou em preparo;
// - demais (aguardando, confirmado, aguardando pagamento): preparo inteiro
//   mais a folga padrão.
const pickupLeadTime = (order) => {
  const status = toNumber(order?.status);
  const prep = toNumber(order?.prep_minutes) ?? DEFAULT_PREP_MINUTES;
  if (STATUS_READY.has(status)) {
    return {
      prepMinutes: 0,
      bufferMinutes: READY_PICKUP_BUFFER_MINUTES,
      minPrepMinutes: 0,
    };
  }
  if (status === STATUS_PREPARING) {
    const elapsed = toNumber(order?.preparing_elapsed_minutes);
    return {
      prepMinutes: elapsed === null ? prep : Math.max(0, prep - elapsed),
      bufferMinutes: READY_PICKUP_BUFFER_MINUTES,
      minPrepMinutes: 0,
    };
  }
  return {
    prepMinutes: prep,
    bufferMinutes: PICKUP_BUFFER_MINUTES,
    minPrepMinutes: 5,
  };
};

const hasDeliveryAddress = (order) =>
  Boolean(
    buildAddressLine(order?.delivery_address_snapshot) ||
      String(order?.delivery_address ?? "").trim(),
  );

// Regras de negócio que impedem a cotação, antes de chamar a Uber.
const assertQuotableOrder = (order) => {
  if (!order) {
    throw serviceError(404, "Pedido não encontrado.", "ORDER_NOT_FOUND");
  }
  const status = toNumber(order.status);
  if (STATUS_FINAL.has(status)) {
    throw serviceError(
      422,
      "Pedidos finalizados ou cancelados não podem ser cotados para entrega.",
      "UBER_DIRECT_ORDER_FINALIZED",
      { order_status: status },
    );
  }
  if (order.delivery_type === false) {
    throw serviceError(
      422,
      "Pedidos para retirada não podem ser cotados para entrega.",
      "UBER_DIRECT_PICKUP_ORDER",
    );
  }
  // delivery_type NULL (pedido antigo ou criado sem o tipo): só segue como
  // entrega se o pedido tiver endereço de destino.
  if (
    (order.delivery_type === null || order.delivery_type === undefined) &&
    !hasDeliveryAddress(order)
  ) {
    throw serviceError(
      422,
      "O pedido não informa se é entrega ou retirada e não possui endereço de entrega.",
      "UBER_DIRECT_DELIVERY_TYPE_UNDEFINED",
    );
  }
  if (order.client_record_id === null) {
    throw serviceError(
      422,
      "O cliente deste pedido foi removido. Cadastre o cliente novamente para cotar a entrega.",
      "UBER_DIRECT_CLIENT_MISSING",
    );
  }
};

const getOrderContext = async (orderId) => {
  const result = await pool.query(
    `SELECT
       o.id, o.company_id, o.client_id, o.delivery_address, o.delivery_type,
       o.status, o.subtotal, o.total,
       (to_jsonb(o)->>'delivery_lat')::numeric AS delivery_lat,
       (to_jsonb(o)->>'delivery_lng')::numeric AS delivery_lng,
       to_jsonb(o)->'delivery_address_snapshot' AS delivery_address_snapshot,
       c.id AS client_record_id,
       c.name AS client_name, c.phone AS client_phone,
       to_jsonb(c)->>'user_id' AS client_user_id,
       co.name AS company_name, co.phone AS company_phone,
       to_jsonb(co)->>'slug' AS company_slug,
       COALESCE((
         SELECT MAX(mi.prep_time_minutes)
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id = o.id
           AND mi.prep_time_minutes IS NOT NULL
           AND mi.prep_time_minutes > 0
       ), $2)::int AS prep_minutes,
       (
         SELECT FLOOR(
           EXTRACT(EPOCH FROM (LOCALTIMESTAMP - h.created_at)) / 60
         )::int
         FROM order_status_history h
         WHERE h.order_id = o.id AND h.status = '3'
         ORDER BY h.created_at DESC
         LIMIT 1
       ) AS preparing_elapsed_minutes
     FROM orders o
     LEFT JOIN clients c ON c.id = o.client_id
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

const buildQuotePayload = ({
  order,
  companyAddress,
  savedAddress,
  now,
  format = addressFormat(),
}) => {
  const addresses = buildQuoteAddresses({ order, companyAddress, format });
  const pickupAddress = addresses.pickup.value;
  const dropoffAddress = addresses.dropoff.value;

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
    ...(() => {
      const { prepMinutes, ...options } = pickupLeadTime(order);
      return quoteTimeWindow(prepMinutes, now, options);
    })(),
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

const formatMoney = (amount, currency) => {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency })
      .format(amount)
      .replace(/ /g, " ");
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

const minutesUntil = (isoDate, now) => {
  const time = isoDate ? new Date(isoDate).getTime() : NaN;
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((time - now.getTime()) / 60000));
};

const hasCoordinates = (payload, prefix) =>
  payload[`${prefix}_latitude`] !== undefined &&
  payload[`${prefix}_longitude`] !== undefined;

// Bloco identificável da Uber na cotação: o valor em reais e os prazos já
// interpretados, para quem consome a resposta não precisar converter centavos
// nem cruzar quote/pickup/dropoff.
const buildUberSummary = ({ quote, payload, addresses, now = new Date() }) => {
  const feeAmount = quote.fee / 100;
  return {
    provider: "uber_direct",
    provider_name: "Uber Direct",
    quote_id: quote.id,
    fee_cents: quote.fee,
    fee_amount: feeAmount,
    fee_formatted: formatMoney(feeAmount, quote.currency),
    currency: quote.currency,
    created_at: quote.created_at,
    expires_at: quote.expires_at,
    expires_in_minutes: minutesUntil(quote.expires_at, now),
    estimated_delivery_at: quote.dropoff_eta,
    delivery_duration_minutes: quote.duration_minutes,
    pickup_duration_minutes: quote.pickup_duration_minutes,
    pickup: {
      name: payload.pickup_name,
      address: addresses?.pickup.text ?? payload.pickup_address,
      address_format: addresses?.pickup.format ?? "text",
      ready_at: payload.pickup_ready_dt,
      deadline_at: payload.pickup_deadline_dt,
      uses_coordinates: hasCoordinates(payload, "pickup"),
    },
    dropoff: {
      name: payload.dropoff_name,
      address: addresses?.dropoff.text ?? payload.dropoff_address,
      address_format: addresses?.dropoff.format ?? "text",
      ready_at: payload.dropoff_ready_dt,
      deadline_at: payload.dropoff_deadline_dt,
      uses_coordinates: hasCoordinates(payload, "dropoff"),
    },
    // Só cotação: nenhuma corrida é criada na Uber por esta rota.
    delivery_requested: false,
  };
};

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
    if (isServiceError(error)) throw error;
    if (isTimeoutError(error)) {
      throw serviceError(
        504,
        "A autenticação da Uber Direct demorou para responder. Tente novamente em instantes.",
        "UBER_DIRECT_TIMEOUT",
        { stage: "auth" },
      );
    }
    const providerData = error.response?.data;
    const providerMessage =
      providerData?.error_description || providerData?.message || null;
    throw serviceError(
      502,
      providerMessage
        ? `Não foi possível autenticar na Uber Direct: ${providerMessage}`
        : "Não foi possível autenticar na Uber Direct.",
      "UBER_DIRECT_AUTH_FAILED",
      {
        provider_status: error.response?.status ?? null,
        provider_code:
          (typeof providerData?.error === "string" && providerData.error) ||
          providerData?.code ||
          null,
      },
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

// Converte a falha da chamada de cotação em um erro do serviço com status HTTP
// coerente: recusa da Uber (4xx) → 422, limite de requisições → 429,
// timeout → 504 e o restante → 502.
const toQuoteError = (error) => {
  if (isServiceError(error)) return error;
  if (isTimeoutError(error)) {
    return serviceError(
      504,
      "A Uber Direct demorou para responder. Tente novamente em instantes.",
      "UBER_DIRECT_TIMEOUT",
      { stage: "quote" },
    );
  }
  const providerData = error.response?.data;
  const providerCode =
    providerData?.code ||
    (typeof providerData?.error === "string" ? providerData.error : null) ||
    providerData?.error?.code ||
    null;
  const providerMessage =
    providerData?.message ||
    (typeof providerData?.error === "string"
      ? providerData.error
      : providerData?.error?.message) ||
    providerData?.code ||
    null;
  const providerStatus = error.response?.status ?? null;
  const details = {
    provider_status: providerStatus,
    provider_code: providerCode,
  };
  if (providerStatus === 429) {
    const retryAfter = toNumber(error.response?.headers?.["retry-after"]);
    return serviceError(
      429,
      "A Uber Direct está recebendo muitas cotações agora. Tente novamente em instantes.",
      "UBER_DIRECT_RATE_LIMITED",
      { ...details, retry_after_seconds: retryAfter },
    );
  }
  if (providerStatus === 400 || providerStatus === 422) {
    return serviceError(
      422,
      PROVIDER_REJECTION_MESSAGES[providerCode] ||
        (providerMessage
          ? `A Uber Direct recusou a cotação: ${providerMessage}`
          : "A Uber Direct recusou a cotação."),
      "UBER_DIRECT_QUOTE_REJECTED",
      { ...details, provider_message: providerMessage },
    );
  }
  return serviceError(
    502,
    providerMessage
      ? `A Uber Direct não conseguiu gerar a cotação: ${providerMessage}`
      : "Não foi possível obter a cotação da Uber Direct. Tente novamente.",
    "UBER_DIRECT_QUOTE_FAILED",
    details,
  );
};

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
  assertQuotableOrder(order);

  const companyAddress = await getCompanyAddress(order.company_id);
  const savedAddresses = await getSavedClientAddresses(order.client_user_id);
  const savedAddress = findMatchingSavedAddress(
    savedAddresses,
    order.delivery_address,
    order.delivery_address_snapshot,
  );
  const format = addressFormat();
  const payload = buildQuotePayload({
    order,
    companyAddress,
    savedAddress,
    format,
  });
  const addresses = buildQuoteAddresses({ order, companyAddress, format });
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
        address: addresses.pickup.text,
        ready_at: payload.pickup_ready_dt,
        deadline_at: payload.pickup_deadline_dt,
      },
      dropoff: {
        address: addresses.dropoff.text,
        ready_at: payload.dropoff_ready_dt,
        deadline_at: payload.dropoff_deadline_dt,
      },
      uber: buildUberSummary({ quote, payload, addresses }),
    };
  } catch (error) {
    throw toQuoteError(error);
  }
};

module.exports = {
  createDeliveryQuote,
  _private: {
    buildAddressLine,
    buildQuotePayload,
    buildQuoteAddresses,
    buildStructuredAddress,
    buildUberSummary,
    assertQuotableOrder,
    findMatchingSavedAddress,
    clearOAuthTokenCache,
    getCompanyAddress,
    getOrderContext,
    getSavedClientAddresses,
    getOAuthToken,
    normalizeQuote,
    pickupLeadTime,
    quoteTimeWindow,
    toQuoteError,
  },
};
