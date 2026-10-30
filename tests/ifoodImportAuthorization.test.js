process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const categoriesService = require("../services/menu_categoriesService");
const itemsService = require("../services/menu_itemsService");
const ifoodService = require("../services/ifoodImportService");
const routes = require("../src/routes");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;

let server;
let baseUrl;
let touchedCompanies = [];
let apifyCalls = 0;
const originals = {};

test.before(async () => {
  originals.query = pool.query;
  originals.findCategories = categoriesService.findByCompany;
  originals.findItems = itemsService.findByCompany;
  originals.fetchMenu = ifoodService.fetchIfoodMenu;
  originals.normalizeMenu = ifoodService.normalizeMenu;

  pool.query = async (sql) => {
    if (sql.includes("FROM user_companies")) return { rows: [{ company_id: OWN_COMPANY }] };
    return { rows: [] };
  };
  categoriesService.findByCompany = async (companyId) => {
    touchedCompanies.push(companyId);
    return [];
  };
  itemsService.findByCompany = async () => [];
  ifoodService.fetchIfoodMenu = async () => {
    apifyCalls++;
    return [];
  };
  ifoodService.normalizeMenu = () => ({ restaurantName: "Loja", items: [], restaurantsFound: 1 });

  const app = express();
  app.use(express.json());
  app.use(routes);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  pool.query = originals.query;
  categoriesService.findByCompany = originals.findCategories;
  itemsService.findByCompany = originals.findItems;
  ifoodService.fetchIfoodMenu = originals.fetchMenu;
  ifoodService.normalizeMenu = originals.normalizeMenu;
  await new Promise((resolve) => server.close(resolve));
});

const post = (path, body, { auth = true } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${generateToken({ id: 99, email: "u@loja.com" })}` } : {}),
    },
    body: JSON.stringify(body),
  });

const importBody = (body) => ({ items: [{ name: "X" }], ...body });

test("POST /ifood/import recusa empresa de outro usuário", async () => {
  touchedCompanies = [];
  const res = await post("/ifood/import", importBody({ companyId: OTHER_COMPANY }));
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});

test("POST /ifood/import não aceita company_id próprio junto de companyId alheio", async () => {
  touchedCompanies = [];
  const res = await post("/ifood/import", importBody({ company_id: OWN_COMPANY, companyId: OTHER_COMPANY }));
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});

test("POST /ifood/import não confunde a empresa autorizada com a gravada", async () => {
  touchedCompanies = [];
  // Number("1e1") === 10 (empresa do usuário), mas parseInt("1e1", 10) === 1.
  const res = await post("/ifood/import", importBody({ companyId: "1e1" }));
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});

test("POST /ifood/import exige autenticação", async () => {
  const res = await post("/ifood/import", importBody({ companyId: OWN_COMPANY }), { auth: false });
  assert.equal(res.status, 401);
});

test("POST /ifood/import aceita a própria empresa", async () => {
  touchedCompanies = [];
  const res = await post("/ifood/import", importBody({ companyId: OWN_COMPANY }));
  assert.equal(res.status, 200);
  assert.deepEqual(touchedCompanies, [OWN_COMPANY]);
});

test("POST /ifood/import-preview limita as execuções na Apify", async () => {
  apifyCalls = 0;
  const url = "https://www.ifood.com.br/delivery/loja";
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await post("/ifood/import-preview", { restaurantUrl: url });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  assert.equal(apifyCalls, 10);
});
