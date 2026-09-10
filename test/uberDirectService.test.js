const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const { _private } = require("../services/uberDirectService");
const { requireAdminUser } = require("../src/middlewares/authorize");

test("monta o payload da cotação com loja, cliente e valor em centavos", () => {
  const payload = _private.buildQuotePayload({
    order: {
      company_id: 12,
      company_name: "Monchou",
      company_phone: "(27) 99987-6143",
      company_slug: "monchou",
      client_name: "Lucas Soares",
      client_phone: "27998219176",
      delivery_address: "Av. Copacabana, 540 - Civit II, Serra - ES, 29168-076",
      subtotal: "10.00",
      prep_minutes: 20,
    },
    companyAddress: {
      street: "R. Machado de Assis",
      number: "335",
      neighborhood: "Parque Res. Laranjeiras",
      city: "Serra",
      state: "ES",
      zip_code: "29165-490",
      latitude: -20.196466,
      longitude: -40.252067,
    },
    savedAddress: {
      latitude: -20.193202,
      longitude: -40.242989,
    },
    now: new Date("2026-09-10T15:00:00.000Z"),
  });

  assert.equal(payload.pickup_name, "Monchou");
  assert.equal(payload.pickup_phone_number, "+5527999876143");
  assert.equal(payload.dropoff_name, "Lucas Soares");
  assert.equal(payload.dropoff_phone_number, "+5527998219176");
  assert.equal(payload.manifest_total_value, 1000);
  assert.equal(payload.external_store_id, "monchou");
  assert.equal(payload.pickup_latitude, -20.196466);
  assert.equal(payload.dropoff_longitude, -40.242989);
  assert.equal(payload.pickup_ready_dt, "2026-09-10T15:20:00.000Z");
  assert.equal(payload.dropoff_deadline_dt, "2026-09-10T16:00:00.000Z");
});

test("usa o snapshot imutável do pedido para o endereço de destino", () => {
  const payload = _private.buildQuotePayload({
    order: {
      company_id: 5,
      company_name: "Loja",
      company_phone: "27999999999",
      client_name: "Cliente",
      client_phone: "27988888888",
      delivery_address: "endereço antigo",
      delivery_address_snapshot: {
        street: "Rua Nova",
        number: "10",
        neighborhood: "Centro",
        city: "Serra",
        state: "ES",
        zip: "29160000",
      },
      subtotal: 25.9,
      prep_minutes: 10,
    },
    companyAddress: {
      street: "Rua da Loja",
      number: "1",
      city: "Serra",
      state: "ES",
      zip_code: "29160001",
    },
    savedAddress: null,
    now: new Date("2026-09-10T12:00:00.000Z"),
  });

  assert.match(payload.dropoff_address, /Rua Nova, 10/);
  assert.equal(payload.manifest_total_value, 2590);
  assert.equal("dropoff_latitude" in payload, false);
});

test("não associa coordenadas de outro número da mesma rua", () => {
  const match = _private.findMatchingSavedAddress(
    [
      { street: "Av. Copacabana", number: "40", latitude: 1, longitude: 2 },
      { street: "Av. Copacabana", number: "540", latitude: 3, longitude: 4 },
    ],
    "Av. Copacabana, 540 - Civit II",
    null,
  );

  assert.equal(match.number, "540");
});

test("restringe a cotação ao usuário administrador", () => {
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  requireAdminUser({ user: { type: 0 } }, response, next);
  assert.equal(nextCalls, 1);

  requireAdminUser({ user: { type: 1 }, isService: false }, response, next);
  assert.equal(nextCalls, 1);
  assert.equal(response.statusCode, 403);
});

test("obtém e reutiliza o access token OAuth da Uber", async () => {
  const originalPost = axios.post;
  const previousEnv = {
    clientId: process.env.UBER_DIRECT_CLIENT_ID,
    clientSecret: process.env.UBER_DIRECT_CLIENT_SECRET,
    scope: process.env.UBER_DIRECT_OAUTH_SCOPE,
    url: process.env.UBER_DIRECT_OAUTH_URL,
  };
  let requests = 0;

  process.env.UBER_DIRECT_CLIENT_ID = "client-id";
  process.env.UBER_DIRECT_CLIENT_SECRET = "client-secret";
  process.env.UBER_DIRECT_OAUTH_SCOPE = "eats.deliveries";
  process.env.UBER_DIRECT_OAUTH_URL = "https://login.uber.com/oauth/v2/token";
  _private.clearOAuthTokenCache();
  axios.post = async (url, body, options) => {
    requests += 1;
    assert.equal(url, process.env.UBER_DIRECT_OAUTH_URL);
    assert.equal(
      options.headers["Content-Type"],
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(body);
    assert.equal(form.get("client_id"), "client-id");
    assert.equal(form.get("client_secret"), "client-secret");
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("scope"), "eats.deliveries");
    return { data: { access_token: "oauth-access-token", expires_in: 3600 } };
  };

  try {
    assert.equal(await _private.getOAuthToken(), "oauth-access-token");
    assert.equal(await _private.getOAuthToken(), "oauth-access-token");
    assert.equal(requests, 1);
  } finally {
    axios.post = originalPost;
    _private.clearOAuthTokenCache();
    for (const [key, value] of Object.entries({
      UBER_DIRECT_CLIENT_ID: previousEnv.clientId,
      UBER_DIRECT_CLIENT_SECRET: previousEnv.clientSecret,
      UBER_DIRECT_OAUTH_SCOPE: previousEnv.scope,
      UBER_DIRECT_OAUTH_URL: previousEnv.url,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
