process.env.JWT_SECRET = "test-secret";
process.env.N8N_API_KEY = "test-service-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const routes = require("../src/routes");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;
const USER_ID = 99;

const OWN_CLIENT = 500;
const OTHER_CLIENT = 600;
const OWN_CATEGORY = 700;
const OTHER_CATEGORY = 800;
const DELETED_CATEGORY = 899;
const OWN_ITEM = 900;
const OTHER_ITEM = 950;
const OWN_COUPON = 100;
const OWN_CAMPAIGN = 300;

const OWNERS = {
  clients: { [OWN_CLIENT]: OWN_COMPANY, [OTHER_CLIENT]: OTHER_COMPANY },
  menu_categories: { [OWN_CATEGORY]: OWN_COMPANY, [OTHER_CATEGORY]: OTHER_COMPANY },
  menu_items: { [OWN_ITEM]: OWN_COMPANY, [OTHER_ITEM]: OTHER_COMPANY },
};

const clientRow = (id) => ({
  id,
  client_id: id,
  campaign_client_id: id,
  name: `Cliente ${id}`,
  phone: `5511${id}`,
  company_id: OWNERS.clients[id],
});

let server;
let baseUrl;
let originalQuery;
let originalConnect;
let originalFetch;
let writes = [];
let webhookPayloads = [];

// Banco simulado: as respostas respeitam o filtro de empresa só quando ele está no
// SQL enviado. Assim um JOIN sem filtro devolve o cliente alheio, como no banco real.
const fakeQuery = async (sql, params = []) => {
  if (sql.includes("FROM user_companies")) {
    return { rows: params[0] === USER_ID ? [{ company_id: OWN_COMPANY }] : [] };
  }
  if (sql.includes("is_system_admin")) return { rows: [{ is_system_admin: false }] };
  if (sql.includes("to_regclass")) return { rows: [{ name: params[0] }], rowCount: 1 };
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };

  // Lookup do recurso nas rotas por id.
  if (/^SELECT company_id FROM (coupons|campaigns) WHERE id = \$1/.test(sql)) {
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

  // Listagem de cupons: cupom legado apontando para cliente de outra empresa.
  if (sql.includes("FROM coupons c LEFT JOIN clients cl")) {
    const visible = !sql.includes("cl.company_id = c.company_id");
    return {
      rows: [
        {
          id: OWN_COUPON,
          company_id: OWN_COMPANY,
          client_id: OTHER_CLIENT,
          client_name: visible ? clientRow(OTHER_CLIENT).name : null,
          client_phone: visible ? clientRow(OTHER_CLIENT).phone : null,
        },
      ],
    };
  }

  // Histórico de uso: resgate legado vinculado a cliente de outra empresa.
  if (sql.includes("FROM coupon_redemptions r")) {
    const visible = !sql.includes("c.company_id = cp.company_id");
    return {
      rows: [
        {
          id: 1,
          client_id: OTHER_CLIENT,
          client_name: visible ? clientRow(OTHER_CLIENT).name : null,
          client_phone: visible ? clientRow(OTHER_CLIENT).phone : null,
        },
      ],
    };
  }

  if (sql.startsWith("INSERT INTO coupons") || sql.startsWith("UPDATE coupons")) {
    writes.push({ sql, params });
    return { rows: [{ id: OWN_COUPON, company_id: OWN_COMPANY }], rowCount: 1 };
  }

  // Detalhe da campanha: a lista de clientes vem de uma subquery com JOIN.
  if (sql.includes("FROM campaigns ca") && sql.includes("WHERE ca.id = $1 AND ca.company_id = $2")) {
    const filtered = sql.includes("c.company_id = ca.company_id");
    const ids = filtered ? [OWN_CLIENT] : [OWN_CLIENT, OTHER_CLIENT];
    return {
      rows: [{ id: OWN_CAMPAIGN, company_id: OWN_COMPANY, products: [], clients: ids.map(clientRow) }],
    };
  }

  // Campanha legada com público selecionado misturando as duas empresas.
  if (sql.includes("FROM campaign_clients cc") && sql.includes("JOIN clients c")) {
    const ids = [OWN_CLIENT, OTHER_CLIENT];
    const filtered = sql.includes("c.company_id = $2");
    const rows = ids
      .filter((id) => !filtered || OWNERS.clients[id] === params[1])
      .map(clientRow);
    return { rows };
  }

  if (sql.includes("FROM campaigns ca JOIN companies comp")) {
    return {
      rows: [
        {
          id: OWN_CAMPAIGN,
          company_id: OWN_COMPANY,
          company_name: "Loja",
          audience_type: "selected",
          title: "Promo",
        },
      ],
    };
  }

  if (sql.startsWith("SELECT * FROM campaigns WHERE id = $1 AND company_id = $2")) {
    return { rows: [{ id: OWN_CAMPAIGN, company_id: OWN_COMPANY, status: "scheduled", audience_type: "selected", title: "Promo" }] };
  }

  if (sql.startsWith("INSERT INTO campaigns")) {
    return { rows: [{ id: OWN_CAMPAIGN, company_id: OWN_COMPANY }] };
  }

  if (sql.startsWith("INSERT INTO campaign_clients")) {
    writes.push({ sql, params });
    return { rows: [] };
  }

  return { rows: [] };
};

test.before(async () => {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  originalFetch = globalThis.fetch;

  pool.query = fakeQuery;
  pool.connect = async () => ({ query: fakeQuery, release() {} });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("alerta-promo")) {
      webhookPayloads.push(JSON.parse(options.body));
      return { ok: true, text: async () => "" };
    }
    return originalFetch(url, options);
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

const send = async (method, path, body) => {
  writes = [];
  webhookPayloads = [];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${generateToken({ id: USER_ID, email: "u@loja.com" })}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const couponBody = (extra) => ({
  company_id: OWN_COMPANY,
  code: "PROMO10",
  discount_type: "percent",
  discount_value: 10,
  ...extra,
});

const assertRejected = (res) => {
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, "string");
  assert.deepEqual(writes, []);
};

const couponCases = [
  ["client_id de outra empresa", { client_id: OTHER_CLIENT }],
  ["client_id inexistente", { client_id: 123456 }],
  ["client_id inválido", { client_id: "abc" }],
  ["category_ids de outra empresa", { category_ids: [OWN_CATEGORY, OTHER_CATEGORY] }],
  ["menu_item_ids de outra empresa", { menu_item_ids: [OWN_ITEM, OTHER_ITEM] }],
];

for (const [label, extra] of couponCases) {
  test(`POST /coupons recusa ${label}`, async () => {
    assertRejected(await send("POST", "/coupons", couponBody(extra)));
  });

  test(`PATCH /coupons/:id recusa ${label}`, async () => {
    assertRejected(await send("PATCH", `/coupons/${OWN_COUPON}`, couponBody(extra)));
  });
}

const ownCouponIds = {
  client_id: OWN_CLIENT,
  category_ids: [OWN_CATEGORY],
  menu_item_ids: [OWN_ITEM],
};

test("POST /coupons grava ids da própria empresa", async () => {
  const res = await send("POST", "/coupons", couponBody(ownCouponIds));
  assert.equal(res.status, 201);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].params.includes(OWN_CLIENT));
});

test("PATCH /coupons/:id grava ids da própria empresa", async () => {
  const res = await send("PATCH", `/coupons/${OWN_COUPON}`, couponBody(ownCouponIds));
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
});

test("POST /coupons sem vínculo não consulta dono nem recusa", async () => {
  const res = await send("POST", "/coupons", couponBody());
  assert.equal(res.status, 201);
});

// Categoria é apagada de verdade e o id continua no cupom. O portal reenvia esse id
// ao editar e não mostra a categoria para o usuário tirar: recusar travaria a edição.
test("PATCH /coupons/:id aceita categoria já apagada no cupom", async () => {
  const body = couponBody({ category_ids: [OWN_CATEGORY, DELETED_CATEGORY] });
  const res = await send("PATCH", `/coupons/${OWN_COUPON}`, body);
  assert.equal(res.status, 200);
});

test("GET /coupons/company/:id não expõe cliente de outra empresa", async () => {
  const res = await send("GET", `/coupons/company/${OWN_COMPANY}`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].client_name, null);
  assert.equal(res.body[0].client_phone, null);
});

test("GET /coupons/:id/redemptions não expõe cliente de outra empresa", async () => {
  const res = await send("GET", `/coupons/${OWN_COUPON}/redemptions`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].client_name, null);
  assert.equal(res.body[0].client_phone, null);
});

const campaignBody = (clientIds) => ({
  company_id: OWN_COMPANY,
  title: "Promo",
  audience_type: "selected",
  schedule_type: "scheduled",
  scheduled_date: "2099-01-01",
  client_ids: clientIds,
});

test("POST /campaigns recusa client_ids de outra empresa", async () => {
  assertRejected(await send("POST", "/campaigns", campaignBody([OWN_CLIENT, OTHER_CLIENT])));
});

test("POST /campaigns recusa client_ids inexistente", async () => {
  assertRejected(await send("POST", "/campaigns", campaignBody([123456])));
});

test("POST /campaigns com público selecionado de outra empresa não dispara nada", async () => {
  const body = { ...campaignBody([OTHER_CLIENT]), schedule_type: "now" };
  assertRejected(await send("POST", "/campaigns", body));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(webhookPayloads, []);
});

test("PATCH /campaigns/:id recusa client_ids de outra empresa", async () => {
  const res = await send("PATCH", `/campaigns/${OWN_CAMPAIGN}`, campaignBody([OWN_CLIENT, OTHER_CLIENT]));
  assertRejected(res);
});

test("POST /campaigns grava client_ids da própria empresa", async () => {
  const res = await send("POST", "/campaigns", campaignBody([OWN_CLIENT]));
  assert.equal(res.status, 201);
  assert.deepEqual(writes.map((w) => w.params[1]), [OWN_CLIENT]);
});

test("PATCH /campaigns/:id grava client_ids da própria empresa", async () => {
  const res = await send("PATCH", `/campaigns/${OWN_CAMPAIGN}`, campaignBody([OWN_CLIENT]));
  assert.equal(res.status, 200);
  assert.deepEqual(writes.map((w) => w.params[1]), [OWN_CLIENT]);
});

test("POST /campaigns ignora client_ids quando o público não é selecionado", async () => {
  const body = { ...campaignBody([OTHER_CLIENT]), audience_type: "all" };
  const res = await send("POST", "/campaigns", body);
  assert.equal(res.status, 201);
  assert.deepEqual(writes, []);
});

test("GET /campaigns/:id não expõe cliente de outra empresa", async () => {
  const res = await send("GET", `/campaigns/${OWN_CAMPAIGN}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.clients.map((c) => c.client_id), [OWN_CLIENT]);
});

test("POST /campaigns/:id/dispatch só envia para clientes da empresa", async () => {
  const res = await send("POST", `/campaigns/${OWN_CAMPAIGN}/dispatch`);
  assert.equal(res.status, 200);
  assert.equal(res.body.clients_count, 1);
  assert.equal(webhookPayloads.length, 1);
  assert.deepEqual(webhookPayloads[0].clients.map((c) => c.client_id), [OWN_CLIENT]);
});
