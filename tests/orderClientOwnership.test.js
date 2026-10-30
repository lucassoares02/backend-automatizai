process.env.JWT_SECRET = "test-secret";
process.env.N8N_API_KEY = "test-service-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const routes = require("../src/routes");
const orderWebhookService = require("../services/orderWebhookService");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;
const USER_ID = 99;

const OWN_CLIENT = 500;
const OTHER_CLIENT = 600;
const OWN_PAYMENT = 700;
const OTHER_PAYMENT = 800;
const OWN_ITEM = 900;
const OTHER_ITEM = 950;
const OWN_ORDER = 300;

const OWNERS = {
  clients: { [OWN_CLIENT]: OWN_COMPANY, [OTHER_CLIENT]: OTHER_COMPANY },
  payment_methods: { [OWN_PAYMENT]: OWN_COMPANY, [OTHER_PAYMENT]: OTHER_COMPANY },
  menu_items: { [OWN_ITEM]: OWN_COMPANY, [OTHER_ITEM]: OTHER_COMPANY },
};

let server;
let baseUrl;
let originalQuery;
let originalConnect;
let originalFetch;
let writes = [];
let webhookCalls = [];
let clientLookups = [];
let appointmentRow = null;

const legacyOrderRow = (filtered) => ({
  id: OWN_ORDER,
  company_id: OWN_COMPANY,
  client_id: OTHER_CLIENT,
  client_name: filtered ? null : "Cliente de outra empresa",
  client_phone: filtered ? null : "5511600",
  items: [],
  total: 0,
});

// Banco simulado: as respostas respeitam o filtro de empresa só quando ele está no
// SQL enviado. Assim um JOIN sem filtro devolve o cliente alheio, como no banco real.
const fakeQuery = async (sql, params = []) => {
  if (sql.includes("FROM user_companies")) {
    return { rows: params[0] === USER_ID ? [{ company_id: OWN_COMPANY }] : [] };
  }
  if (sql.includes("is_system_admin")) return { rows: [{ is_system_admin: false }] };
  if (sql.includes("to_regclass")) return { rows: [{ name: params[0] }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };

  if (/^SELECT company_id FROM orders WHERE id = \$1/.test(sql)) {
    return { rows: [{ company_id: OWN_COMPANY }] };
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

  // Preço autoritativo do upsert, sempre restrito à empresa.
  if (sql.includes("SELECT id, name, price FROM menu_items")) {
    const rows = params[1]
      .filter((id) => OWNERS.menu_items[id] === params[0])
      .map((id) => ({ id, name: `Item ${id}`, price: 10 }));
    return { rows };
  }

  // Consultas do webhook de WhatsApp: pedido legado com cliente de outra empresa.
  if (sql.includes("JOIN clients cli ON cli.id = o.client_id")) {
    const filtered = sql.includes("cli.company_id = o.company_id");
    clientLookups.push({ filtered });
    return { rows: filtered ? [] : [legacyOrderRow(false)] };
  }

  // Leitura de pedido (listagens e detalhe): só traz o cliente se for da mesma empresa.
  // Vem antes de appointments porque o SELECT do pedido tem subquery nessa tabela.
  if (sql.includes("FROM orders o") && sql.includes("clients c ON c.id = o.client_id")) {
    return { rows: [legacyOrderRow(sql.includes("c.company_id = o.company_id"))] };
  }

  if (sql.includes("FROM appointments a")) return { rows: appointmentRow ? [appointmentRow] : [] };

  if (sql.includes("FROM orders WHERE id = $1 FOR UPDATE")) {
    return { rows: [{ id: OWN_ORDER, company_id: OWN_COMPANY, delivery_fee: 0, discount: 0 }] };
  }

  if (sql.includes("SUM(subtotal)")) return { rows: [{ subtotal: 10 }] };

  if (sql.startsWith("INSERT INTO orders")) {
    writes.push({ sql, params });
    return { rows: [{ id: OWN_ORDER }] };
  }
  if (sql.includes("INSERT INTO order_items")) {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("UPDATE order_items") || sql.startsWith("UPDATE orders")) {
    writes.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
};

test.before(async () => {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  originalFetch = globalThis.fetch;

  pool.query = fakeQuery;
  pool.connect = async () => ({ query: fakeQuery, release() {} });
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
  await new Promise((resolve) => server.close(resolve));
});

const send = async (method, path, body, headers) => {
  writes = [];
  webhookCalls = [];
  clientLookups = [];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(headers || { Authorization: `Bearer ${generateToken({ id: USER_ID, email: "u@loja.com" })}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const SERVICE_HEADERS = { "x-api-key": process.env.N8N_API_KEY };

const orderItem = (extra) => ({
  menu_item_id: OWN_ITEM,
  name: "Item",
  quantity: 1,
  unit_price: 10,
  subtotal: 10,
  ...extra,
});

const orderBody = (extra) => ({
  company_id: OWN_COMPANY,
  client_id: OWN_CLIENT,
  items: [orderItem()],
  ...extra,
});

const upsertBody = (extra) => ({
  company_id: OWN_COMPANY,
  client_id: OWN_CLIENT,
  items: [{ id: OWN_ITEM, quantity: 1 }],
  ...extra,
});

// Pedido recusado não grava nada nem aciona o webhook de WhatsApp.
const assertRejected = async (res) => {
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, "string");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, []);
  assert.deepEqual(webhookCalls, []);
};

const orderInsert = () => writes.find((w) => w.sql.startsWith("INSERT INTO orders"));
const itemInsert = () => writes.find((w) => w.sql.includes("INSERT INTO order_items"));

const createCases = [
  ["client_id de outra empresa", { client_id: OTHER_CLIENT }],
  ["client_id inexistente", { client_id: 123456 }],
  ["client_id inválido", { client_id: "abc" }],
  ["client_id numérico em string de outra empresa", { client_id: String(OTHER_CLIENT) }],
  ["payment_method_id de outra empresa", { payment_method_id: OTHER_PAYMENT }],
  ["payment_method_id inexistente", { payment_method_id: 123456 }],
  ["menu_item_id de outra empresa", { items: [orderItem(), orderItem({ menu_item_id: OTHER_ITEM })] }],
  ["menu_item_id inexistente", { items: [orderItem({ menu_item_id: 123456 })] }],
];

for (const [name, extra] of createCases) {
  test(`POST /orders recusa ${name}`, async () => {
    await assertRejected(await send("POST", "/orders", orderBody(extra)));
  });
}

test("POST /orders recusa cliente de outra empresa também para a API key de serviço", async () => {
  const res = await send("POST", "/orders", orderBody({ client_id: OTHER_CLIENT }), SERVICE_HEADERS);
  await assertRejected(res);
});

test("POST /orders aceita cliente, forma de pagamento e produto da empresa", async () => {
  const res = await send("POST", "/orders", orderBody({ payment_method_id: OWN_PAYMENT }));
  assert.equal(res.status, 201);
  const { params } = orderInsert();
  assert.equal(params[1], OWN_CLIENT);
  assert.ok(params.includes(OWN_PAYMENT));
  assert.equal(itemInsert().params[1], OWN_ITEM);
});

test("POST /orders aceita pedido sem forma de pagamento e item sem produto vinculado", async () => {
  const res = await send("POST", "/orders", orderBody({ items: [orderItem({ menu_item_id: null })] }));
  assert.equal(res.status, 201);
  assert.equal(itemInsert().params[1], null);
});

test("POST /orders aceita ids em string e grava o número conferido", async () => {
  const res = await send(
    "POST",
    "/orders",
    orderBody({
      client_id: String(OWN_CLIENT),
      payment_method_id: String(OWN_PAYMENT),
      items: [orderItem({ menu_item_id: String(OWN_ITEM) })],
    }),
  );
  assert.equal(res.status, 201);
  const { params } = orderInsert();
  assert.equal(params[1], OWN_CLIENT);
  assert.ok(params.includes(OWN_PAYMENT));
  assert.equal(itemInsert().params[1], OWN_ITEM);
});

const upsertCases = [
  ["client_id de outra empresa", { client_id: OTHER_CLIENT }],
  ["client_id inexistente", { client_id: 123456 }],
  ["produto de outra empresa", { items: [{ id: OTHER_ITEM, quantity: 1 }] }],
];

for (const [name, extra] of upsertCases) {
  test(`POST /orders/upsert recusa ${name} ao criar`, async () => {
    await assertRejected(await send("POST", "/orders/upsert", upsertBody(extra)));
  });
}

test("POST /orders/upsert recusa cliente de outra empresa também para a API key de serviço", async () => {
  const res = await send("POST", "/orders/upsert", upsertBody({ client_id: OTHER_CLIENT }), SERVICE_HEADERS);
  await assertRejected(res);
});

test("POST /orders/upsert cria pedido com cliente da empresa", async () => {
  const res = await send("POST", "/orders/upsert", upsertBody());
  assert.equal(res.status, 201);
  assert.equal(orderInsert().params[1], OWN_CLIENT);
});

test("POST /orders/upsert na edição não grava o client_id do corpo", async () => {
  const res = await send("POST", "/orders/upsert", upsertBody({ order: OWN_ORDER, client_id: OTHER_CLIENT }));
  assert.equal(res.status, 200);
  assert.equal(orderInsert(), undefined);
  for (const { params } of writes) assert.ok(!params.includes(OTHER_CLIENT));
});

for (const path of [`/orders/company/${OWN_COMPANY}`, `/orders/today/${OWN_COMPANY}`]) {
  test(`GET ${path} não expõe cliente de outra empresa em pedido legado`, async () => {
    const res = await send("GET", path);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, OWN_ORDER);
    assert.equal(res.body[0].client_name, null);
    assert.equal(res.body[0].client_phone, null);
  });
}

test("GET /orders/:id não expõe cliente de outra empresa em pedido legado", async () => {
  const res = await send("GET", `/orders/${OWN_ORDER}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.client_name, null);
  assert.equal(res.body.client_phone, null);
});

const webhookCases = [
  ["pedido aguardando", () => orderWebhookService.notifyAwaitingOrder(OWN_ORDER)],
  ["mudança de status", () => orderWebhookService.notifyStatusChange({ id: OWN_ORDER, company_id: OWN_COMPANY }, 2)],
  [
    "lembrete de agendamento",
    () => {
      appointmentRow = { id: 1, starts_at: new Date().toISOString(), timezone: "America/Sao_Paulo" };
      return orderWebhookService.sendAppointmentReminder(OWN_ORDER, "24h").finally(() => {
        appointmentRow = null;
      });
    },
  ],
];

for (const [name, run] of webhookCases) {
  test(`webhook de ${name} não envia WhatsApp a cliente de outra empresa`, async () => {
    webhookCalls = [];
    clientLookups = [];
    await run();
    assert.ok(clientLookups.length > 0, "a consulta do cliente deveria ter sido feita");
    assert.ok(clientLookups.every((lookup) => lookup.filtered));
    assert.deepEqual(webhookCalls, []);
  });
}
