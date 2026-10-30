process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const routes = require("../src/routes");
const pagarmeService = require("../services/pagarmeService");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;
const CUSTOMER_ID = 77;

const OWN_CLIENT = 500;
const OTHER_USER_CLIENT = 501;
const OTHER_CLIENT = 600;
const OWN_PAYMENT = 700;
const OTHER_PAYMENT = 800;
const OWN_ITEM = 900;
const OWN_ORDER = 300;

const CLIENTS = {
  [OWN_CLIENT]: { company_id: OWN_COMPANY, user_id: CUSTOMER_ID },
  [OTHER_USER_CLIENT]: { company_id: OWN_COMPANY, user_id: 78 },
  [OTHER_CLIENT]: { company_id: OTHER_COMPANY, user_id: CUSTOMER_ID },
};
const PAYMENTS = { [OWN_PAYMENT]: OWN_COMPANY, [OTHER_PAYMENT]: OTHER_COMPANY };

const OWNERS = {
  clients: Object.fromEntries(Object.entries(CLIENTS).map(([id, c]) => [id, c.company_id])),
  payment_methods: PAYMENTS,
};

let server;
let baseUrl;
let originalQuery;
let originalConnect;
let originalFetch;
let originalReady;
let originalSession;
let writes = [];
let webhookCalls = [];

const fakeQuery = async (sql, params = []) => {
  if (sql.includes("to_regclass")) return { rows: [{ name: params[0] }], rowCount: 1 };
  // Só as colunas exigidas pelo agendamento; as opcionais do pedido ficam de fora do INSERT.
  if (sql.includes("information_schema.columns")) {
    const exists = params[0] === "menu_items" && ["item_type", "duration_minutes"].includes(params[1]);
    return exists ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // Conferência de dono dos ids informados.
  const owners = sql.match(/^SELECT id, company_id FROM (\w+) WHERE id = ANY/);
  if (owners) {
    const table = OWNERS[owners[1]];
    const rows = params[0]
      .filter((id) => table[id] !== undefined)
      .map((id) => ({ id, company_id: table[id] }));
    return { rows };
  }

  // Dono do cliente: com login também compara o usuário.
  if (sql.includes("FROM clients") && sql.includes("company_id = $2")) {
    const row = CLIENTS[params[0]];
    const matches = row && row.company_id === params[1] && (params[2] === undefined || row.user_id === params[2]);
    return { rows: matches ? [{ "?column?": 1 }] : [] };
  }

  if (sql.includes("FROM payment_methods WHERE id = $1 AND company_id = $2")) {
    return { rows: PAYMENTS[params[0]] === params[1] ? [{ "?column?": 1 }] : [] };
  }

  if (sql.includes("accepts_delivery, accepts_pickup")) {
    return { rows: [{ accepts_delivery: true, accepts_pickup: true }] };
  }

  if (sql.includes("SELECT id, price") && sql.includes("FROM menu_items")) {
    return { rows: params[1].filter((id) => id === OWN_ITEM).map((id) => ({ id, price: 10 })) };
  }

  if (sql.includes("INSERT INTO orders")) {
    writes.push({ sql, params });
    return {
      rows: [
        {
          id: OWN_ORDER,
          uuid: "11111111-1111-1111-1111-111111111111",
          company_id: params[0],
          client_id: params[1],
          payment_method_id: params[7],
          payment_provider: params[12],
        },
      ],
    };
  }
  if (sql.includes("INSERT INTO order_items")) {
    writes.push({ sql, params });
    return { rows: [{ id: 1 }], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

test.before(async () => {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  originalFetch = globalThis.fetch;
  originalReady = pagarmeService.isPaymentInfrastructureReady;
  originalSession = pagarmeService.createPublicPaymentSession;

  pool.query = fakeQuery;
  pool.connect = async () => ({ query: fakeQuery, release() {} });
  pagarmeService.isPaymentInfrastructureReady = async () => true;
  pagarmeService.createPublicPaymentSession = () => ({ payment_session_token: "token" });
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, options);
    webhookCalls.push(String(url));
    return { ok: true, text: async () => "" };
  };

  const app = express();
  app.use(express.json());
  app.use(routes);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  pool.query = originalQuery;
  pool.connect = originalConnect;
  globalThis.fetch = originalFetch;
  pagarmeService.isPaymentInfrastructureReady = originalReady;
  pagarmeService.createPublicPaymentSession = originalSession;
  await new Promise((resolve) => server.close(resolve));
});

const post = async (path, body, headers) => {
  writes = [];
  webhookCalls = [];
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const CUSTOMER_HEADERS = () => ({
  Authorization: `Bearer ${generateToken({ id: CUSTOMER_ID, scope: "customer", aud: "customer" })}`,
});

const orderBody = (extra) => ({
  company_id: OWN_COMPANY,
  client_id: OWN_CLIENT,
  delivery_type: "pickup",
  items: [{ menu_item_id: OWN_ITEM, name: "Item", quantity: 1 }],
  ...extra,
});

// Pedido recusado não grava nada nem aciona o webhook de WhatsApp.
const assertRefused = async (res, status = 400) => {
  assert.equal(res.status, status);
  assert.equal(typeof res.body.error, "string");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, []);
  assert.deepEqual(webhookCalls, []);
};

const orderInsert = () => writes.find((w) => w.sql.includes("INSERT INTO orders"));

const refusedCases = [
  ["client_id de outra empresa", { client_id: OTHER_CLIENT }],
  ["client_id de outra empresa em string", { client_id: String(OTHER_CLIENT) }],
  ["client_id inexistente", { client_id: 123456 }],
  ["client_id inválido", { client_id: "abc" }],
  ["payment_method_id de outra empresa", { payment_method_id: OTHER_PAYMENT }],
  ["payment_method_id de outra empresa em string", { payment_method_id: String(OTHER_PAYMENT) }],
  ["payment_method_id inexistente", { payment_method_id: 123456 }],
  ["payment_method_id inválido", { payment_method_id: "abc" }],
  ["id reservado do pagamento online", { payment_method_id: -778 }],
  [
    "payment_method_id de outra empresa em pagamento online",
    { payment_method_id: OTHER_PAYMENT, payment_provider: "pagarme", online_payment_method: "pix" },
  ],
];

for (const [name, extra] of refusedCases) {
  test(`POST /public/orders sem login recusa ${name}`, async () => {
    await assertRefused(await post("/public/orders", orderBody(extra)));
  });
}

test("POST /public/orders com login recusa cliente de outra empresa", async () => {
  const res = await post("/public/orders", orderBody({ client_id: OTHER_CLIENT }), CUSTOMER_HEADERS());
  await assertRefused(res);
});

test("POST /public/orders com login recusa forma de pagamento de outra empresa", async () => {
  const res = await post("/public/orders", orderBody({ payment_method_id: OTHER_PAYMENT }), CUSTOMER_HEADERS());
  await assertRefused(res);
});

test("POST /public/orders com login continua recusando cliente de outro usuário da empresa", async () => {
  const res = await post("/public/orders", orderBody({ client_id: OTHER_USER_CLIENT }), CUSTOMER_HEADERS());
  await assertRefused(res, 403);
});

test("POST /public/orders sem login aceita cliente e forma de pagamento da empresa", async () => {
  const res = await post("/public/orders", orderBody({ payment_method_id: OWN_PAYMENT }));
  assert.equal(res.status, 201);
  const { params } = orderInsert();
  assert.equal(params[1], OWN_CLIENT);
  assert.equal(params[7], OWN_PAYMENT);
});

test("POST /public/orders com login aceita cliente do próprio usuário", async () => {
  const res = await post("/public/orders", orderBody({ payment_method_id: OWN_PAYMENT }), CUSTOMER_HEADERS());
  assert.equal(res.status, 201);
  assert.equal(orderInsert().params[1], OWN_CLIENT);
});

test("POST /public/orders aceita ids em string e grava o número conferido", async () => {
  const res = await post(
    "/public/orders",
    orderBody({ client_id: String(OWN_CLIENT), payment_method_id: String(OWN_PAYMENT) }),
  );
  assert.equal(res.status, 201);
  const { params } = orderInsert();
  assert.equal(params[1], OWN_CLIENT);
  assert.equal(params[7], OWN_PAYMENT);
});

// Formato enviado pelo cardápio público: online sem forma de pagamento cadastrada.
test("POST /public/orders aceita pagamento online sem payment_method_id", async () => {
  const res = await post(
    "/public/orders",
    orderBody({ payment_provider: "pagarme", online_payment_method: "pix" }),
  );
  assert.equal(res.status, 201);
  const { params } = orderInsert();
  assert.equal(params[7], null);
  assert.equal(params[12], "pagarme");
});

const bookingBody = (extra) => ({
  company_id: OWN_COMPANY,
  client_id: OWN_CLIENT,
  payment_method_id: OWN_PAYMENT,
  booking: {
    menu_item_id: OWN_ITEM,
    professional_id: "any",
    starts_at: new Date(Date.now() + 86400000).toISOString(),
  },
  ...extra,
});

test("POST /public/bookings recusa cliente de outra empresa", async () => {
  const res = await post("/public/bookings", bookingBody({ client_id: OTHER_CLIENT }));
  await assertRefused(res, 403);
});

test("POST /public/bookings recusa forma de pagamento de outra empresa", async () => {
  const res = await post("/public/bookings", bookingBody({ payment_method_id: OTHER_PAYMENT }));
  await assertRefused(res);
});
