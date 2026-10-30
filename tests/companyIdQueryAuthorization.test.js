process.env.JWT_SECRET = "test-secret";
process.env.N8N_API_KEY = "test-service-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const couponsService = require("../services/couponsService");
const promotionsService = require("../services/promotionsService");
const upsellService = require("../services/upsellService");
const campaignsService = require("../services/campaignsService");
const purchaseGoalsService = require("../services/purchaseGoalsService");
const productOptionsService = require("../services/productOptionsService");
const routes = require("../src/routes");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;
const OWN_RESOURCE = 100;
const OTHER_RESOURCE = 200;
const USER_ID = 99;
const ADMIN_ID = 98;

// Serviços simulados: cada chamada registra a empresa sobre a qual agiria.
const STUBS = [
  [couponsService, "findByCompany", (companyId) => companyId],
  [couponsService, "create", (data) => data.company_id],
  [couponsService, "update", (_id, data) => data.company_id],
  [couponsService, "toggleStatus", (_id, companyId) => companyId],
  [promotionsService, "findByCompany", (companyId) => companyId],
  [promotionsService, "create", (data) => data.company_id],
  [promotionsService, "update", (_id, data) => data.company_id],
  [promotionsService, "toggleStatus", (_id, companyId) => companyId],
  [promotionsService, "remove", (_id, companyId) => companyId],
  [upsellService, "findByCompany", (companyId) => companyId],
  [upsellService, "create", (data) => data.company_id],
  [upsellService, "update", (_id, data) => data.company_id],
  [upsellService, "toggleStatus", (_id, companyId) => companyId],
  [upsellService, "duplicate", (_id, companyId) => companyId],
  [upsellService, "remove", (_id, companyId) => companyId],
  [campaignsService, "find", (_id, companyId) => companyId],
  [campaignsService, "update", (_id, companyId) => companyId],
  [campaignsService, "remove", (_id, companyId) => companyId],
  [purchaseGoalsService, "remove", (_id, companyId) => companyId],
  [productOptionsService, "remove", (_id, companyId) => companyId],
];

let server;
let baseUrl;
let touchedCompanies = [];
const originals = [];
let originalQuery;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (sql.includes("FROM user_companies")) {
      return { rows: params[0] === USER_ID ? [{ company_id: OWN_COMPANY }] : [] };
    }
    if (sql.includes("is_system_admin")) {
      return { rows: [{ is_system_admin: params[0] === ADMIN_ID }] };
    }
    // Lookup do recurso: o id define a empresa dona.
    if (sql.includes("SELECT company_id FROM")) {
      if (Number(params[0]) === OWN_RESOURCE) return { rows: [{ company_id: OWN_COMPANY }] };
      if (Number(params[0]) === OTHER_RESOURCE) return { rows: [{ company_id: OTHER_COMPANY }] };
    }
    return { rows: [] };
  };

  for (const [service, method, companyOf] of STUBS) {
    originals.push([service, method, service[method]]);
    service[method] = async (...args) => {
      touchedCompanies.push(Number(companyOf(...args)));
      return {};
    };
  }

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
  for (const [service, method, original] of originals) service[method] = original;
  await new Promise((resolve) => server.close(resolve));
});

const userHeaders = (id = USER_ID) => ({
  Authorization: `Bearer ${generateToken({ id, email: "u@loja.com" })}`,
});

const send = async (method, path, body, headers = userHeaders()) => {
  touchedCompanies = [];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
};

const assertActedOn = (status, expectedStatus, company) => {
  assert.equal(status, expectedStatus);
  assert.deepEqual(touchedCompanies, [company]);
};

const assertDenied = (status) => {
  assert.equal(status, 403);
  assert.deepEqual(touchedCompanies, []);
};

for (const base of ["/coupons", "/promotions", "/upsell"]) {
  // create exige name em promoções; os demais campos ficam a cargo do serviço simulado.
  const createBody = (companyId) => ({ company_id: companyId, name: "Teste" });

  test(`GET ${base}/company/:id ignora company_id alheio na query`, async () => {
    const status = await send("GET", `${base}/company/${OWN_COMPANY}?company_id=${OTHER_COMPANY}`);
    assertActedOn(status, 200, OWN_COMPANY);
  });

  test(`GET ${base}/company/:id recusa empresa alheia na rota`, async () => {
    assertDenied(await send("GET", `${base}/company/${OTHER_COMPANY}?company_id=${OWN_COMPANY}`));
  });

  test(`POST ${base} ignora company_id alheio na query`, async () => {
    const status = await send("POST", `${base}?company_id=${OTHER_COMPANY}`, createBody(OWN_COMPANY));
    assertActedOn(status, 201, OWN_COMPANY);
  });

  test(`POST ${base} recusa empresa alheia no corpo`, async () => {
    assertDenied(await send("POST", `${base}?company_id=${OWN_COMPANY}`, createBody(OTHER_COMPANY)));
  });

  test(`PATCH ${base}/:id usa a empresa dona do recurso`, async () => {
    const path = `${base}/${OWN_RESOURCE}?company_id=${OTHER_COMPANY}`;
    assertActedOn(await send("PATCH", path, { company_id: OTHER_COMPANY }), 200, OWN_COMPANY);
  });

  test(`PATCH ${base}/:id funciona como o portal chama`, async () => {
    const status = await send("PATCH", `${base}/${OWN_RESOURCE}`, { company_id: OWN_COMPANY });
    assertActedOn(status, 200, OWN_COMPANY);
  });

  test(`PATCH ${base}/:id recusa recurso de outra empresa`, async () => {
    const path = `${base}/${OTHER_RESOURCE}?company_id=${OWN_COMPANY}`;
    assertDenied(await send("PATCH", path, { company_id: OWN_COMPANY }));
  });

  test(`PATCH ${base}/:id/status usa a empresa dona do recurso`, async () => {
    const path = `${base}/${OWN_RESOURCE}/status?company_id=${OTHER_COMPANY}`;
    const status = await send("PATCH", path, { company_id: OTHER_COMPANY, active: true });
    assertActedOn(status, 200, OWN_COMPANY);
  });

  test(`PATCH ${base}/:id/status recusa recurso de outra empresa`, async () => {
    const path = `${base}/${OTHER_RESOURCE}/status?company_id=${OWN_COMPANY}`;
    assertDenied(await send("PATCH", path, { company_id: OWN_COMPANY, active: true }));
  });

  test(`DELETE ${base}/:id recusa recurso de outra empresa`, async () => {
    assertDenied(await send("DELETE", `${base}/${OTHER_RESOURCE}?company_id=${OWN_COMPANY}`));
  });
}

for (const base of ["/promotions", "/upsell"]) {
  test(`DELETE ${base}/:id usa a empresa dona do recurso`, async () => {
    const status = await send("DELETE", `${base}/${OWN_RESOURCE}?company_id=${OTHER_COMPANY}`);
    assertActedOn(status, 200, OWN_COMPANY);
  });

  test(`DELETE ${base}/:id funciona como o portal chama`, async () => {
    const status = await send("DELETE", `${base}/${OWN_RESOURCE}?company_id=${OWN_COMPANY}`);
    assertActedOn(status, 200, OWN_COMPANY);
  });
}

test("POST /upsell/:id/duplicate usa a empresa dona do recurso", async () => {
  const path = `/upsell/${OWN_RESOURCE}/duplicate?company_id=${OTHER_COMPANY}`;
  assertActedOn(await send("POST", path, { company_id: OTHER_COMPANY }), 201, OWN_COMPANY);
});

test("POST /upsell/:id/duplicate recusa recurso de outra empresa", async () => {
  const path = `/upsell/${OTHER_RESOURCE}/duplicate?company_id=${OWN_COMPANY}`;
  assertDenied(await send("POST", path, { company_id: OWN_COMPANY }));
});

test("GET /campaigns/:id usa a empresa dona do recurso", async () => {
  const status = await send("GET", `/campaigns/${OWN_RESOURCE}?company_id=${OTHER_COMPANY}`);
  assertActedOn(status, 200, OWN_COMPANY);
});

test("GET /campaigns/:id não depende de company_id na query", async () => {
  assertActedOn(await send("GET", `/campaigns/${OWN_RESOURCE}`), 200, OWN_COMPANY);
});

test("GET /campaigns/:id recusa recurso de outra empresa", async () => {
  assertDenied(await send("GET", `/campaigns/${OTHER_RESOURCE}?company_id=${OWN_COMPANY}`));
});

test("PATCH /campaigns/:id usa a empresa dona do recurso", async () => {
  const status = await send("PATCH", `/campaigns/${OWN_RESOURCE}`, { company_id: OTHER_COMPANY });
  assertActedOn(status, 200, OWN_COMPANY);
});

test("DELETE /campaigns/:id usa a empresa dona do recurso", async () => {
  const status = await send("DELETE", `/campaigns/${OWN_RESOURCE}?company_id=${OTHER_COMPANY}`);
  assertActedOn(status, 200, OWN_COMPANY);
});

test("DELETE /campaigns/:id recusa recurso de outra empresa", async () => {
  assertDenied(await send("DELETE", `/campaigns/${OTHER_RESOURCE}?company_id=${OWN_COMPANY}`));
});

test("DELETE /purchase-goals/:id usa a empresa dona do recurso", async () => {
  const status = await send("DELETE", `/purchase-goals/${OWN_RESOURCE}?company_id=${OTHER_COMPANY}`);
  assertActedOn(status, 200, OWN_COMPANY);
});

test("DELETE /purchase-goals/:id recusa recurso de outra empresa", async () => {
  assertDenied(await send("DELETE", `/purchase-goals/${OTHER_RESOURCE}?company_id=${OWN_COMPANY}`));
});

test("DELETE /product-options/:id usa a empresa dona do grupo", async () => {
  const status = await send("DELETE", `/product-options/${OWN_RESOURCE}?company_id=${OTHER_COMPANY}`);
  assertActedOn(status, 200, OWN_COMPANY);
});

test("DELETE /product-options/:id recusa grupo de outra empresa, mesmo informando a empresa dona", async () => {
  assertDenied(await send("DELETE", `/product-options/${OTHER_RESOURCE}?company_id=${OTHER_COMPANY}`));
});

test("admin do sistema age na empresa dona do recurso", async () => {
  const path = `/coupons/${OTHER_RESOURCE}/status?company_id=${OWN_COMPANY}`;
  const status = await send("PATCH", path, { active: true }, userHeaders(ADMIN_ID));
  assertActedOn(status, 200, OTHER_COMPANY);
});

test("principal de serviço informa a empresa nas rotas por id", async () => {
  const headers = { "x-api-key": process.env.N8N_API_KEY };
  const path = `/coupons/${OWN_RESOURCE}/status?company_id=${OTHER_COMPANY}`;
  assertActedOn(await send("PATCH", path, { active: true }, headers), 200, OTHER_COMPANY);
});

test("principal de serviço usa o parâmetro de rota na listagem", async () => {
  const headers = { "x-api-key": process.env.N8N_API_KEY };
  const status = await send("GET", `/coupons/company/${OWN_COMPANY}`, undefined, headers);
  assertActedOn(status, 200, OWN_COMPANY);
});

test("recurso inexistente devolve 404 sem chegar ao serviço", async () => {
  const status = await send("PATCH", `/coupons/999?company_id=${OWN_COMPANY}`, { active: true });
  assert.equal(status, 404);
  assert.deepEqual(touchedCompanies, []);
});
