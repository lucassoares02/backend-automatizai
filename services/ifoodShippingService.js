const axios = require("axios");

const ifoodService = require("./ifoodService");
const { _private: uberDirect } = require("./uberDirectService");

// ─── iFood Entrega (módulo Shipping) ────────────────────────────────────────────
// Usa a logística do iFood para entregar pedidos feitos FORA do iFood (os
// produtos são do Arbian; só o entregador é do iFood). Por enquanto apenas
// COTA o valor via deliveryAvailabilities — nenhum pedido é registrado no iFood.
// A origem da corrida é o endereço cadastrado do merchant no iFood; aqui só
// enviamos as coordenadas de destino (cliente).

const MAPS_KEY = process.env.GOOGLE_API_KEY;

// Mensagens amigáveis para os códigos de erro documentados do deliveryAvailabilities.
const PROVIDER_ERROR_MESSAGES = {
  DeliveryDistanceTooHigh: "O endereço do cliente está fora do raio de entrega do iFood (máx. 10 km).",
  OffOpeningHours: "A loja está fora do horário de funcionamento no iFood.",
  MerchantEasyDeliveryDisabled:
    "A loja não tem o iFood Entrega habilitado para pedidos de outros canais.",
  OriginNotFound: "O endereço da loja não está habilitado para o iFood Entrega.",
  BadRequestMerchant: "A loja está indisponível para entregas no iFood no momento.",
  MerchantStatusAvailability: "A loja está indisponível para entregas no iFood no momento.",
  ServiceAreaMismatch: "O endereço do cliente não é atendido pelo iFood Entrega.",
  HighDemand: "Sem entregadores disponíveis no iFood no momento (alta demanda).",
  UnavailableFleet: "Sem entregadores disponíveis no iFood no momento.",
};

const serviceError = (status, message, code, details) =>
  Object.assign(new Error(message), {
    isIfoodShippingServiceError: true,
    status,
    code,
    ...(details ? { details } : {}),
  });

const isServiceError = (error) => error?.isIfoodShippingServiceError === true;

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toCoords = (source) => {
  const latitude = toNumber(source?.latitude ?? source?.lat);
  const longitude = toNumber(source?.longitude ?? source?.lng);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
};

const geocodeAddress = async (addressLine) => {
  if (!MAPS_KEY || !addressLine) return null;
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: addressLine, key: MAPS_KEY, language: "pt-BR", region: "br" },
      timeout: 10000,
    });
    return toCoords(data?.results?.[0]?.geometry?.location);
  } catch (_) {
    return null;
  }
};

// Destino da corrida: coordenadas gravadas no pedido → endereço salvo do
// cliente que bate com o pedido → geocode do endereço em texto.
const resolveDropoff = async (order) => {
  const address =
    uberDirect.buildAddressLine(order.delivery_address_snapshot) ||
    String(order.delivery_address ?? "").trim();
  if (!address) {
    throw serviceError(
      422,
      "O pedido não possui um endereço de entrega válido.",
      "IFOOD_SHIPPING_DROPOFF_ADDRESS_MISSING",
    );
  }

  let coords = toCoords({ latitude: order.delivery_lat, longitude: order.delivery_lng });
  if (!coords) {
    const savedAddresses = await uberDirect.getSavedClientAddresses(order.client_user_id);
    const savedAddress = uberDirect.findMatchingSavedAddress(
      savedAddresses,
      order.delivery_address,
      order.delivery_address_snapshot,
    );
    coords = toCoords(savedAddress);
  }
  if (!coords) coords = await geocodeAddress(address);
  if (!coords) {
    throw serviceError(
      422,
      "Não foi possível localizar as coordenadas do endereço de entrega.",
      "IFOOD_SHIPPING_DROPOFF_COORDS_MISSING",
    );
  }
  return { address, ...coords };
};

// O iFood devolve o tempo de entrega em segundos.
const secondsToMinutes = (value) => {
  const seconds = toNumber(value);
  return seconds === null ? null : Math.round(seconds / 60);
};

const normalizeAvailability = (data) => {
  const quote = data?.quote && typeof data.quote === "object" ? data.quote : {};
  const deliveryTime =
    data?.deliveryTime && typeof data.deliveryTime === "object" ? data.deliveryTime : {};
  return {
    id: data?.id ?? null,
    fee: toNumber(quote.netValue) ?? toNumber(quote.grossValue),
    gross_value: toNumber(quote.grossValue),
    discount: toNumber(quote.discount),
    raise: toNumber(quote.raise),
    currency: "BRL",
    created_at: data?.createdAt ?? null,
    expires_at: data?.expirationAt ?? null,
    distance_meters: toNumber(data?.distance),
    min_minutes: secondsToMinutes(deliveryTime.min),
    max_minutes: secondsToMinutes(deliveryTime.max),
  };
};

const providerError = (error) => {
  const status = error.response?.status ?? null;
  const data = error.response?.data;
  const providerCode =
    (typeof data?.error === "object" ? data.error?.code : data?.error) || data?.code || null;
  const providerMessage =
    (typeof data?.error === "object" ? data.error?.message : null) || data?.message || null;

  if (status === 401 || status === 403) {
    return serviceError(
      502,
      "O app da plataforma não tem permissão de iFood Entrega para esta loja no iFood.",
      "IFOOD_SHIPPING_FORBIDDEN",
      { provider_status: status, provider_code: providerCode },
    );
  }
  const friendly = providerCode ? PROVIDER_ERROR_MESSAGES[providerCode] : null;
  return serviceError(
    friendly ? 422 : 502,
    friendly ||
      (providerMessage
        ? `O iFood não conseguiu gerar a cotação: ${providerMessage}`
        : "Não foi possível obter a cotação do iFood Entrega. Tente novamente."),
    "IFOOD_SHIPPING_QUOTE_FAILED",
    { provider_status: status, provider_code: providerCode },
  );
};

const createDeliveryQuote = async (orderId) => {
  const order = await uberDirect.getOrderContext(orderId);
  if (!order) {
    throw serviceError(404, "Pedido não encontrado.", "ORDER_NOT_FOUND");
  }
  if (order.delivery_type === false) {
    throw serviceError(
      422,
      "Pedidos para retirada não podem ser cotados para entrega.",
      "IFOOD_SHIPPING_PICKUP_ORDER",
    );
  }

  const merchant = await ifoodService.getSavedMerchant(order.company_id);
  if (!merchant.merchantId) {
    throw serviceError(
      422,
      "Esta empresa não tem um perfil iFood conectado. Informe o merchant em Negócios → iFood.",
      "IFOOD_SHIPPING_NO_MERCHANT",
    );
  }

  const dropoff = await resolveDropoff(order);
  const path =
    `/shipping/v1.0/merchants/${encodeURIComponent(merchant.merchantId)}/deliveryAvailabilities` +
    `?latitude=${dropoff.latitude}&longitude=${dropoff.longitude}`;

  let data;
  try {
    data = await ifoodService.authGet(path);
  } catch (error) {
    if (isServiceError(error) || error.code === "IFOOD_NOT_CONFIGURED" || error.code === "IFOOD_AUTH_FAILED") {
      throw error;
    }
    throw providerError(error);
  }

  const quote = normalizeAvailability(data);
  if (quote.fee === null) {
    throw serviceError(
      502,
      "O iFood respondeu sem o valor da cotação.",
      "IFOOD_SHIPPING_INVALID_RESPONSE",
    );
  }
  return {
    provider: "ifood",
    merchant: { id: merchant.merchantId, name: merchant.merchantName },
    quote,
    dropoff,
  };
};

module.exports = {
  createDeliveryQuote,
  _private: { normalizeAvailability, providerError, resolveDropoff },
};
