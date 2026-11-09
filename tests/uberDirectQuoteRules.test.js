const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const pool = require("../db");

const uberDirectService = require("../services/uberDirectService");

const { _private } = uberDirectService;

const axiosError = (status, data, headers = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers },
  });

// ── Mapeamento de erros da Uber ─────────────────────────────────────────────

test("recusa de endereço da Uber (400) vira 422 com provider_code", () => {
  const error = _private.toQuoteError(
    axiosError(400, {
      code: "address_undeliverable",
      message: "The specified location is not in a deliverable area.",
    }),
  );
  assert.equal(error.status, 422);
  assert.equal(error.code, "UBER_DIRECT_QUOTE_REJECTED");
  assert.match(error.message, /fora da área atendida/);
  assert.equal(error.details.provider_status, 400);
  assert.equal(error.details.provider_code, "address_undeliverable");
  assert.match(error.details.provider_message, /deliverable area/);
});

test("422 da Uber com código desconhecido repassa a mensagem do provedor", () => {
  const error = _private.toQuoteError(
    axiosError(422, {
      code: "dropoff_deadline_too_early",
      message: "Dropoff deadline must be at least 20 minutes after ready",
    }),
  );
  assert.equal(error.status, 422);
  assert.equal(error.code, "UBER_DIRECT_QUOTE_REJECTED");
  assert.match(error.message, /recusou a cotação: Dropoff deadline/);
  assert.equal(error.details.provider_code, "dropoff_deadline_too_early");
});

test("429 da Uber vira 429 com retry_after_seconds", () => {
  const error = _private.toQuoteError(
    axiosError(429, { code: "rate_limit_exceeded" }, { "retry-after": "30" }),
  );
  assert.equal(error.status, 429);
  assert.equal(error.code, "UBER_DIRECT_RATE_LIMITED");
  assert.match(error.message, /instantes/);
  assert.equal(error.details.retry_after_seconds, 30);
});

test("timeout da chamada de cotação tem código próprio", () => {
  for (const code of ["ECONNABORTED", "ETIMEDOUT"]) {
    const error = _private.toQuoteError(
      Object.assign(new Error("timeout of 15000ms exceeded"), { code }),
    );
    assert.equal(error.status, 504);
    assert.equal(error.code, "UBER_DIRECT_TIMEOUT");
    assert.equal(error.details.stage, "quote");
  }
});

test("erro 5xx da Uber continua como 502", () => {
  const error = _private.toQuoteError(
    axiosError(503, { message: "Service Unavailable" }),
  );
  assert.equal(error.status, 502);
  assert.equal(error.code, "UBER_DIRECT_QUOTE_FAILED");
  assert.deepEqual(error.details, {
    provider_status: 503,
    provider_code: null,
  });
});

test("timeout na autenticação OAuth vira UBER_DIRECT_TIMEOUT", async () => {
  const originalPost = axios.post;
  const previousId = process.env.UBER_DIRECT_CLIENT_ID;
  const previousSecret = process.env.UBER_DIRECT_CLIENT_SECRET;
  process.env.UBER_DIRECT_CLIENT_ID = "client-id";
  process.env.UBER_DIRECT_CLIENT_SECRET = "client-secret";
  _private.clearOAuthTokenCache();
  axios.post = async () => {
    throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  };
  try {
    await assert.rejects(_private.getOAuthToken(), (error) => {
      assert.equal(error.status, 504);
      assert.equal(error.code, "UBER_DIRECT_TIMEOUT");
      assert.equal(error.details.stage, "auth");
      return true;
    });
  } finally {
    axios.post = originalPost;
    _private.clearOAuthTokenCache();
    restoreEnv("UBER_DIRECT_CLIENT_ID", previousId);
    restoreEnv("UBER_DIRECT_CLIENT_SECRET", previousSecret);
  }
});

// ── Regras do pedido ────────────────────────────────────────────────────────

const quotableOrder = (overrides = {}) => ({
  id: 1,
  status: 2,
  delivery_type: true,
  delivery_address: "Rua A, 10 - Serra - ES",
  client_record_id: 7,
  ...overrides,
});

test("bloqueia cotação de pedidos em status final", () => {
  for (const status of [5, 6, 7, 9]) {
    assert.throws(
      () => _private.assertQuotableOrder(quotableOrder({ status })),
      (error) => {
        assert.equal(error.status, 422);
        assert.equal(error.code, "UBER_DIRECT_ORDER_FINALIZED");
        assert.equal(error.details.order_status, status);
        return true;
      },
    );
  }
  for (const status of [1, 2, 3, 4, 8, 10, null]) {
    assert.doesNotThrow(() =>
      _private.assertQuotableOrder(quotableOrder({ status })),
    );
  }
});

test("pedido inexistente continua 404", () => {
  assert.throws(
    () => _private.assertQuotableOrder(null),
    (error) => error.status === 404 && error.code === "ORDER_NOT_FOUND",
  );
});

test("pedido de retirada continua bloqueado", () => {
  assert.throws(
    () => _private.assertQuotableOrder(quotableOrder({ delivery_type: false })),
    (error) => error.code === "UBER_DIRECT_PICKUP_ORDER",
  );
});

test("delivery_type NULL só segue como entrega se houver endereço", () => {
  assert.doesNotThrow(() =>
    _private.assertQuotableOrder(quotableOrder({ delivery_type: null })),
  );
  assert.doesNotThrow(() =>
    _private.assertQuotableOrder(
      quotableOrder({
        delivery_type: null,
        delivery_address: "",
        delivery_address_snapshot: { street: "Rua Nova", number: "10" },
      }),
    ),
  );
  assert.throws(
    () =>
      _private.assertQuotableOrder(
        quotableOrder({ delivery_type: null, delivery_address: "  " }),
      ),
    (error) =>
      error.status === 422 &&
      error.code === "UBER_DIRECT_DELIVERY_TYPE_UNDEFINED",
  );
});

test("cliente removido responde 422 em vez de pedido não encontrado", () => {
  assert.throws(
    () => _private.assertQuotableOrder(quotableOrder({ client_record_id: null })),
    (error) => error.status === 422 && error.code === "UBER_DIRECT_CLIENT_MISSING",
  );
});

test("carrega o pedido com LEFT JOIN em clients, status e tempo em preparo", async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    assert.match(sql, /LEFT JOIN clients c ON c\.id = o\.client_id/);
    assert.match(sql, /o\.status/);
    assert.match(sql, /c\.id AS client_record_id/);
    assert.match(sql, /h\.status = '3'/);
    assert.match(sql, /AS preparing_elapsed_minutes/);
    return { rows: [] };
  };
  try {
    assert.equal(await _private.getOrderContext(1), null);
  } finally {
    pool.query = originalQuery;
  }
});

// ── Janela de horários ──────────────────────────────────────────────────────

test("pedido ainda não iniciado soma preparo e folga padrão", () => {
  assert.deepEqual(_private.pickupLeadTime({ status: 2, prep_minutes: 20 }), {
    prepMinutes: 20,
    bufferMinutes: 50,
    minPrepMinutes: 5,
  });
});

test("pedido pronto ou em entrega não soma preparo", () => {
  for (const status of [4, 8]) {
    const lead = _private.pickupLeadTime({ status, prep_minutes: 40 });
    assert.equal(lead.prepMinutes, 0);
    assert.equal(lead.bufferMinutes, 10);
  }
  const now = new Date("2026-09-10T15:00:00.000Z");
  const { prepMinutes, ...options } = _private.pickupLeadTime({
    status: 8,
    prep_minutes: 40,
  });
  const window = _private.quoteTimeWindow(prepMinutes, now, options);
  assert.equal(window.pickup_ready_dt, "2026-09-10T15:10:00.000Z");
  assert.equal(window.pickup_deadline_dt, "2026-09-10T15:30:00.000Z");
  assert.equal(window.dropoff_deadline_dt, "2026-09-10T16:05:00.000Z");
});

test("pedido em preparo desconta o tempo já decorrido", () => {
  assert.equal(
    _private.pickupLeadTime({
      status: 3,
      prep_minutes: 30,
      preparing_elapsed_minutes: 12,
    }).prepMinutes,
    18,
  );
  assert.equal(
    _private.pickupLeadTime({
      status: 3,
      prep_minutes: 30,
      preparing_elapsed_minutes: 45,
    }).prepMinutes,
    0,
  );
  // Sem histórico do início do preparo, assume o preparo inteiro.
  assert.equal(
    _private.pickupLeadTime({ status: 3, prep_minutes: 30 }).prepMinutes,
    30,
  );
});

test("payload de pedido pronto usa a janela curta", () => {
  const payload = _private.buildQuotePayload({
    order: baseOrder({ status: 8, prep_minutes: 40 }),
    companyAddress: companyAddress(),
    now: new Date("2026-09-10T15:00:00.000Z"),
  });
  assert.equal(payload.pickup_ready_dt, "2026-09-10T15:10:00.000Z");
  assert.ok(
    new Date(payload.dropoff_ready_dt) <= new Date(payload.pickup_deadline_dt),
  );
});

// ── Formato do endereço ─────────────────────────────────────────────────────

test("monta o endereço estruturado da Uber com country BR", () => {
  const structured = JSON.parse(
    _private.buildStructuredAddress(companyAddress()),
  );
  assert.deepEqual(structured, {
    street_address: [
      "R. Machado de Assis, 335",
      "Loja 2 - Parque Res. Laranjeiras",
    ],
    city: "Serra",
    state: "ES",
    zip_code: "29165-490",
    country: "BR",
  });
  assert.equal(_private.buildStructuredAddress({ street: "Rua A" }), null);
});

test("usa estruturado quando possível e texto livre como fallback", () => {
  const addresses = _private.buildQuoteAddresses({
    order: baseOrder(),
    companyAddress: companyAddress(),
    format: "structured",
  });
  assert.equal(addresses.pickup.format, "structured");
  assert.equal(JSON.parse(addresses.pickup.value).country, "BR");
  assert.match(addresses.pickup.text, /R\. Machado de Assis, 335/);
  // Pedido antigo, só com texto livre: não há como estruturar.
  assert.equal(addresses.dropoff.format, "text");
  assert.equal(addresses.dropoff.value, "Av. Copacabana, 540 - Serra - ES");

  const textOnly = _private.buildQuoteAddresses({
    order: baseOrder(),
    companyAddress: companyAddress(),
    format: "text",
  });
  assert.equal(textOnly.pickup.format, "text");
  assert.equal(textOnly.pickup.value, textOnly.pickup.text);
});

// ── Fluxo completo ──────────────────────────────────────────────────────────

test("cotação envia endereço estruturado e mantém a resposta compatível", async () => {
  const originalQuery = pool.query;
  const originalPost = axios.post;
  const previous = saveEnv();
  Object.assign(process.env, {
    UBER_DIRECT_CUSTOMER_ID: "cust-1",
    UBER_DIRECT_CLIENT_ID: "client-id",
    UBER_DIRECT_CLIENT_SECRET: "client-secret",
  });
  delete process.env.UBER_DIRECT_ADDRESS_FORMAT;
  _private.clearOAuthTokenCache();

  pool.query = async (sql) => {
    if (/FROM orders o/.test(sql)) {
      return {
        rows: [
          baseOrder({
            status: 3,
            prep_minutes: 30,
            preparing_elapsed_minutes: 10,
            delivery_address_snapshot: {
              street: "Av. Copacabana",
              number: "540",
              neighborhood: "Civit II",
              city: "Serra",
              state: "ES",
              zip: "29168076",
            },
          }),
        ],
      };
    }
    if (/FROM company_addresses/.test(sql)) return { rows: [companyAddress()] };
    return { rows: [] };
  };
  let quotePayload;
  axios.post = async (url, body) => {
    if (url.includes("oauth")) {
      return { data: { access_token: "token", expires_in: 3600 } };
    }
    quotePayload = body;
    return {
      data: {
        id: "dqt_1",
        fee: 1500,
        currency: "brl",
        expires: new Date(Date.now() + 15 * 60000).toISOString(),
        duration: 25,
        pickup_duration: 6,
      },
    };
  };

  try {
    const result = await uberDirectService.createDeliveryQuote(1);
    assert.equal(JSON.parse(quotePayload.pickup_address).country, "BR");
    assert.deepEqual(JSON.parse(quotePayload.dropoff_address).street_address, [
      "Av. Copacabana, 540",
      "Civit II",
    ]);
    // Resposta continua com texto legível nos campos que o portal já usa.
    assert.equal(result.provider, "uber_direct");
    assert.equal(result.quote.fee, 1500);
    assert.match(result.pickup.address, /^R\. Machado de Assis, 335/);
    assert.match(result.dropoff.address, /^Av\. Copacabana, 540/);
    assert.equal(result.uber.pickup.address, result.pickup.address);
    assert.equal(result.uber.pickup.address_format, "structured");
    assert.equal(result.uber.dropoff.address_format, "structured");
    assert.equal(result.uber.fee_formatted, "R$ 15,00");
    // Em preparo há 10 de 30 min: coleta em 20 + 10 min de folga.
    const leadMinutes =
      (new Date(quotePayload.pickup_ready_dt).getTime() - Date.now()) / 60000;
    assert.ok(leadMinutes > 29 && leadMinutes <= 30, `lead ${leadMinutes}`);
  } finally {
    pool.query = originalQuery;
    axios.post = originalPost;
    _private.clearOAuthTokenCache();
    restoreAllEnv(previous);
  }
});

test("cotação de pedido cancelado não chama a Uber", async () => {
  const originalQuery = pool.query;
  const originalPost = axios.post;
  const previous = saveEnv();
  process.env.UBER_DIRECT_CUSTOMER_ID = "cust-1";
  pool.query = async () => ({ rows: [baseOrder({ status: 6 })] });
  axios.post = async () => {
    throw new Error("não deveria chamar a Uber");
  };
  try {
    await assert.rejects(
      uberDirectService.createDeliveryQuote(1),
      (error) => error.code === "UBER_DIRECT_ORDER_FINALIZED",
    );
  } finally {
    pool.query = originalQuery;
    axios.post = originalPost;
    restoreAllEnv(previous);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function baseOrder(overrides = {}) {
  return {
    id: 1,
    company_id: 12,
    client_id: 7,
    client_record_id: 7,
    status: 2,
    delivery_type: true,
    company_name: "Monchou",
    company_phone: "27999876143",
    company_slug: "monchou",
    client_name: "Lucas Soares",
    client_phone: "27998219176",
    delivery_address: "Av. Copacabana, 540 - Serra - ES",
    subtotal: "10.00",
    prep_minutes: 20,
    ...overrides,
  };
}

function companyAddress() {
  return {
    street: "R. Machado de Assis",
    number: "335",
    complement: "Loja 2",
    neighborhood: "Parque Res. Laranjeiras",
    city: "Serra",
    state: "es",
    zip_code: "29165490",
    latitude: -20.196466,
    longitude: -40.252067,
  };
}

const ENV_KEYS = [
  "UBER_DIRECT_CUSTOMER_ID",
  "UBER_DIRECT_CLIENT_ID",
  "UBER_DIRECT_CLIENT_SECRET",
  "UBER_DIRECT_ADDRESS_FORMAT",
];

function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreAllEnv(saved) {
  for (const [key, value] of Object.entries(saved)) restoreEnv(key, value);
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
