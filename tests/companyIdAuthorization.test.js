process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const { authorizeCompanyBody, authorizeCompanyParam } = require("../src/middlewares/authorize");
const ifoodService = require("../services/ifoodService");
const menuImportService = require("../services/menuImportService");
const addressService = require("../services/company_addressService");
const routes = require("../src/routes");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;

let server;
let baseUrl;
let touchedCompanies = [];
const originals = {};

test.before(async () => {
  originals.query = pool.query;
  originals.saveMerchant = ifoodService.saveMerchant;
  originals.sendToWebhook = menuImportService.sendToWebhook;
  originals.saveForCompany = addressService.saveForCompany;

  pool.query = async (sql) => {
    if (sql.includes("FROM user_companies")) return { rows: [{ company_id: OWN_COMPANY }] };
    return { rows: [] };
  };
  ifoodService.saveMerchant = async (companyId) => {
    touchedCompanies.push(companyId);
    return {};
  };
  menuImportService.sendToWebhook = async ({ companyId }) => {
    touchedCompanies.push(companyId);
  };
  addressService.saveForCompany = async ({ company_id }) => {
    touchedCompanies.push(company_id);
    return {};
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
  pool.query = originals.query;
  ifoodService.saveMerchant = originals.saveMerchant;
  menuImportService.sendToWebhook = originals.sendToWebhook;
  addressService.saveForCompany = originals.saveForCompany;
  await new Promise((resolve) => server.close(resolve));
});

const authHeader = () => ({ Authorization: `Bearer ${generateToken({ id: 99, email: "u@loja.com" })}` });

const sendJson = (method, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });

const sendMenuImport = (companyId) => {
  const form = new FormData();
  form.append("company_id", companyId);
  form.append("url", "https://loja.com/cardapio");
  return fetch(`${baseUrl}/menu-import`, { method: "POST", headers: authHeader(), body: form });
};

const runMiddleware = (middleware, req) => {
  let status = null;
  let passed = false;
  const res = {
    status(code) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
  };
  middleware({ userCompanies: [OWN_COMPANY], ...req }, res, () => {
    passed = true;
  });
  return { status, passed };
};

// Os id em string e em array têm Number(valor) === 10 (empresa do usuário), mas
// parseInt lê "1e1" e "1.0e1" como 1 e "0xA" e "0b1010" como 0.
const NON_CANONICAL_IDS = ["1e1", "1.0e1", "0xA", "0b1010", "10.0", " 10", "10 ", "+10", [OWN_COMPANY], ["10"], true, 10.5, 1e21];

for (const value of NON_CANONICAL_IDS) {
  const label = JSON.stringify(value);

  test(`authorizeCompanyBody recusa o id não canônico ${label}`, () => {
    const { status, passed } = runMiddleware(authorizeCompanyBody(), { body: { company_id: value } });
    assert.equal(passed, false);
    assert.equal(status, 403);
  });

  test(`authorizeCompanyParam recusa o id não canônico ${label}`, () => {
    const { status, passed } = runMiddleware(authorizeCompanyParam("id"), { params: { id: value } });
    assert.equal(passed, false);
    assert.equal(status, 403);
  });
}

test("autorização aceita o id da própria empresa como número ou string de dígitos", () => {
  for (const value of [OWN_COMPANY, String(OWN_COMPANY), "010"]) {
    assert.equal(runMiddleware(authorizeCompanyBody(), { body: { company_id: value } }).passed, true);
    assert.equal(runMiddleware(authorizeCompanyParam("id"), { params: { id: value } }).passed, true);
  }
});

test("autorização recusa o id canônico de outra empresa", () => {
  const { status, passed } = runMiddleware(authorizeCompanyBody(), { body: { company_id: OTHER_COMPANY } });
  assert.equal(passed, false);
  assert.equal(status, 403);
});

test("admin do sistema e serviço continuam liberados", () => {
  const body = { company_id: OTHER_COMPANY };
  assert.equal(runMiddleware(authorizeCompanyBody(), { body, isSystemAdmin: true }).passed, true);
  assert.equal(runMiddleware(authorizeCompanyBody(), { body, isService: true }).passed, true);
});

test('POST /ifood/merchant recusa company_id "1e1"', async () => {
  touchedCompanies = [];
  const res = await sendJson("POST", "/ifood/merchant", { company_id: "1e1", merchant_id: "abc" });
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});

test("POST /ifood/merchant grava na empresa autorizada", async () => {
  touchedCompanies = [];
  const res = await sendJson("POST", "/ifood/merchant", { company_id: OWN_COMPANY, merchant_id: "abc" });
  assert.equal(res.status, 200);
  assert.deepEqual(touchedCompanies, [OWN_COMPANY]);
});

test("POST /ifood/merchant não aceita company_id próprio junto de companyId alheio", async () => {
  touchedCompanies = [];
  const res = await sendJson("POST", "/ifood/merchant", {
    company_id: OWN_COMPANY,
    companyId: OTHER_COMPANY,
    merchant_id: "abc",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(touchedCompanies, [OWN_COMPANY]);
});

test("POST /ifood/merchant recusa companyId alheio junto de company_id nulo", async () => {
  touchedCompanies = [];
  const res = await sendJson("POST", "/ifood/merchant", {
    company_id: null,
    companyId: OTHER_COMPANY,
    merchant_id: "abc",
  });
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});

test('POST /menu-import recusa company_id "1e1"', async () => {
  touchedCompanies = [];
  const res = await sendMenuImport("1e1");
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});

test("POST /menu-import envia para a empresa autorizada", async () => {
  touchedCompanies = [];
  const res = await sendMenuImport(String(OWN_COMPANY));
  assert.equal(res.status, 200);
  assert.deepEqual(touchedCompanies, [OWN_COMPANY]);
});

test('PATCH /company/address recusa company_id "1e1"', async () => {
  touchedCompanies = [];
  const res = await sendJson("PATCH", "/company/address", { company_id: "1e1" });
  assert.equal(res.status, 403);
  assert.deepEqual(touchedCompanies, []);
});
