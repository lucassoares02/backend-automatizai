process.env.JWT_SECRET = "test-secret";
process.env.N8N_API_KEY = "test-service-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pool = require("../db");
const { generateToken } = require("../helpers/jwt");
const menuCategoriesService = require("../services/menu_categoriesService");
const menuItemsService = require("../services/menu_itemsService");
const paymentMethodsService = require("../services/payment_methodsService");
const additionalInfoService = require("../services/additional_infoService");
const openingHoursService = require("../services/company_opening_hoursService");
const companiessssService = require("../services/companiessssService");
const companyAddressService = require("../services/company_addressService");
const userService = require("../services/userService");
const productOptionsService = require("../services/productOptionsService");
const connectionsService = require("../services/connectionsService");
const identityService = require("../services/identityService");
const evolution = require("../services/evolutionService");
const n8n = require("../services/n8nService");
const minio = require("../controllers/minioController");
const routes = require("../src/routes");

const OWN_COMPANY = 10;
const OTHER_COMPANY = 1;
const OWN_ID = 100;
const OTHER_ID = 200;
const MISSING_ID = 300;
const OWN_INSTANCE = "loja-propria";
const OTHER_INSTANCE = "loja-alheia";
const USER_ID = 99;
const ADMIN_ID = 98;

// Toda chamada a um serviço simulado fica aqui. Recusa correta = lista vazia.
let calls = [];

const record = (name, result) => async (...args) => {
  calls.push({ name, args });
  return result;
};

const STUBS = [
  [menuCategoriesService, "create", { id: 1 }],
  [menuCategoriesService, "update", { id: 1 }],
  [menuCategoriesService, "remove", { id: 1 }],
  [menuCategoriesService, "findByCompany", []],
  [menuItemsService, "create", { id: 1 }],
  [menuItemsService, "update", { id: 1 }],
  [menuItemsService, "remove", { id: 1 }],
  [menuItemsService, "findByCompany", []],
  [paymentMethodsService, "create", { id: 1 }],
  [paymentMethodsService, "update", { id: 1 }],
  [paymentMethodsService, "remove", { id: 1 }],
  [paymentMethodsService, "findByCompany", []],
  [additionalInfoService, "create", { id: 1 }],
  [additionalInfoService, "update", { id: 1 }],
  [additionalInfoService, "remove", { id: 1 }],
  [additionalInfoService, "findAll", []],
  [openingHoursService, "create", { id: 1 }],
  [openingHoursService, "update", { id: 1 }],
  [openingHoursService, "remove", { id: 1 }],
  [openingHoursService, "findByCompany", []],
  [companiessssService, "create", { id: 1 }],
  [companiessssService, "update", { id: 1 }],
  [companiessssService, "remove", { id: 1 }],
  [companiessssService, "find", { id: 1 }],
  [companiessssService, "findAll", []],
  [companyAddressService, "find", { id: 1 }],
  [menuCategoriesService, "find", { id: 1 }],
  [menuCategoriesService, "findAll", []],
  [menuItemsService, "find", { id: 1 }],
  [menuItemsService, "findAll", []],
  [paymentMethodsService, "find", { id: 1 }],
  [paymentMethodsService, "findAll", []],
  [additionalInfoService, "find", { id: 1 }],
  [openingHoursService, "find", { id: 1 }],
  [openingHoursService, "findAll", []],
  [userService, "getAllUsers", []],
  [userService, "createUser", { id: 1 }],
  [productOptionsService, "findByProduct", []],
  [productOptionsService, "create", { id: 1 }],
  [productOptionsService, "update", { id: 1 }],
  [productOptionsService, "remove", { id: 1 }],
  [productOptionsService, "reorder", []],
  [connectionsService, "update", { id: 1 }],
  [connectionsService, "remove", { id: 1 }],
  [connectionsService, "find_by_instance", null],
  [connectionsService, "getStatusByInstance", "open"],
  [identityService, "resolveClientByPhone", { client: { id: 1, company_id: OWN_COMPANY }, userId: 1 }],
  [evolution, "create", { instance: { instanceId: "i", status: "created" }, hash: "h" }],
  [evolution, "updateInstance", {}],
  [n8n, "duplicate", {}],
  [connectionsService, "create", { id: 1 }],
  [evolution, "getQrCode", {}],
  [evolution, "testConnection", {}],
  [evolution, "deleteInstance", {}],
  [n8n, "remove", {}],
  [minio, "uploadFile", { url: "https://files/x.png" }],
];

const OWNER_BY_ID = { [OWN_ID]: OWN_COMPANY, [OTHER_ID]: OTHER_COMPANY };
const OWNER_BY_INSTANCE = { [OWN_INSTANCE]: OWN_COMPANY, [OTHER_INSTANCE]: OTHER_COMPANY };

const fakeQuery = async (sql, params = []) => {
  if (sql.includes("FROM user_companies")) {
    return { rows: params[0] === USER_ID ? [{ company_id: OWN_COMPANY }] : [] };
  }
  if (sql.includes("is_system_admin")) {
    return { rows: [{ is_system_admin: params[0] === ADMIN_ID }] };
  }
  if (sql.startsWith("SELECT company_id FROM connections WHERE instance_name")) {
    const companyId = OWNER_BY_INSTANCE[params[0]];
    return { rows: companyId ? [{ company_id: companyId }] : [] };
  }
  if (sql.startsWith("SELECT company_id FROM")) {
    const companyId = OWNER_BY_ID[Number(params[0])];
    return { rows: companyId ? [{ company_id: companyId }] : [] };
  }
  return { rows: [] };
};

let server;
let baseUrl;
const originals = [];

test.before(async () => {
  originals.push([pool, "query", pool.query]);
  pool.query = fakeQuery;
  for (const [target, method, result] of STUBS) {
    originals.push([target, method, target[method]]);
    target[method] = record(method, result);
  }
  originals.push([connectionsService, "find", connectionsService.find]);
  connectionsService.find = async (id) => ({
    id: Number(id),
    company_id: OWNER_BY_ID[Number(id)],
    instance_name: OWN_INSTANCE,
  });

  const app = express();
  app.use(express.json());
  app.use(routes);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const [target, method, original] of originals) target[method] = original;
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  calls = [];
});

const tokenFor = (id) => ({ Authorization: `Bearer ${generateToken({ id, email: "u@loja.com" })}` });
const USER = () => tokenFor(USER_ID);
const ADMIN = () => tokenFor(ADMIN_ID);
const SERVICE = () => ({ "x-api-key": "test-service-key" });

const send = (method, path, body, headers = USER()) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Os dados de escrita usados por um serviço: o primeiro objeto entre os argumentos.
const writtenData = () => calls[0].args.find((arg) => arg && typeof arg === "object");

const CREATE_ROUTES = ["/menu_categories", "/menu_items", "/payment_methods", "/additional_info", "/company_opening_hours", "/product-options"];

for (const path of CREATE_ROUTES) {
  test(`POST ${path} recusa company_id de outra empresa`, async () => {
    const res = await send("POST", path, { company_id: OTHER_COMPANY, name: "x" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`POST ${path} recusa pedido sem empresa`, async () => {
    const res = await send("POST", path, { name: "x" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`POST ${path} recusa company_id "1e1"`, async () => {
    const res = await send("POST", path, { company_id: "1e1", name: "x" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`POST ${path} cria na empresa do usuário`, async () => {
    const res = await send("POST", path, { company_id: OWN_COMPANY, name: "x" });
    assert.equal(res.status, 201);
    assert.equal(writtenData().company_id, OWN_COMPANY);
  });

  // menu_categoriesService lê companyId antes de company_id; o middleware faz o contrário.
  test(`POST ${path} não aceita company_id próprio junto de companyId alheio`, async () => {
    const res = await send("POST", path, { company_id: OWN_COMPANY, companyId: OTHER_COMPANY, name: "x" });
    assert.equal(res.status, 201);
    assert.equal(writtenData().company_id, OWN_COMPANY);
    assert.equal(writtenData().companyId, OWN_COMPANY);
  });
}

const ID_ROUTES = [
  ["PATCH", "/menu_categories"],
  ["DELETE", "/menu_categories"],
  ["DELETE", "/menu_items"],
  ["PATCH", "/payment_methods"],
  ["DELETE", "/payment_methods"],
  ["PATCH", "/additional_info"],
  ["DELETE", "/additional_info"],
  ["PATCH", "/company_opening_hours"],
  ["DELETE", "/company_opening_hours"],
  ["PATCH", "/product-options"],
  ["DELETE", "/product-options"],
];

for (const [method, path] of ID_ROUTES) {
  test(`${method} ${path}/:id recusa recurso de outra empresa`, async () => {
    const res = await send(method, `${path}/${OTHER_ID}`, { company_id: OWN_COMPANY, name: "x" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`${method} ${path}/:id responde 404 para recurso inexistente`, async () => {
    const res = await send(method, `${path}/${MISSING_ID}`, { company_id: OWN_COMPANY, name: "x" });
    assert.equal(res.status, 404);
    assert.deepEqual(calls, []);
  });

  test(`${method} ${path}/:id altera recurso da própria empresa`, async () => {
    const res = await send(method, `${path}/${OWN_ID}`, { company_id: OWN_COMPANY, name: "x" });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });
}

// Sem fixar a empresa, o PATCH moveria o recurso próprio para outra empresa.
for (const path of ["/menu_categories", "/additional_info", "/company_opening_hours", "/product-options"]) {
  test(`PATCH ${path}/:id não move o recurso para outra empresa`, async () => {
    const res = await send("PATCH", `${path}/${OWN_ID}`, { company_id: OTHER_COMPANY, companyId: OTHER_COMPANY, name: "x" });
    assert.equal(res.status, 200);
    assert.equal(writtenData().company_id, OWN_COMPANY);
    assert.equal(writtenData().companyId, OWN_COMPANY);
  });
}

test("PATCH /menu_items recusa id de outra empresa no corpo", async () => {
  const res = await send("PATCH", "/menu_items", { id: OTHER_ID, company_id: OWN_COMPANY });
  assert.equal(res.status, 403);
  assert.deepEqual(calls, []);
});

test("PATCH /menu_items recusa id não canônico no corpo", async () => {
  for (const id of ["1e2", "0x64", `${OTHER_ID}abc`, [OWN_ID], 100.5, null, undefined]) {
    const res = await send("PATCH", "/menu_items", { id, company_id: OWN_COMPANY });
    assert.equal(res.status, 403, JSON.stringify(id));
  }
  assert.deepEqual(calls, []);
});

test("PATCH /menu_items responde 404 para id inexistente", async () => {
  const res = await send("PATCH", "/menu_items", { id: MISSING_ID, company_id: OWN_COMPANY });
  assert.equal(res.status, 404);
  assert.deepEqual(calls, []);
});

test("PATCH /menu_items altera item próprio sem movê-lo de empresa", async () => {
  const res = await send("PATCH", "/menu_items", { id: OWN_ID, company_id: OTHER_COMPANY });
  assert.equal(res.status, 200);
  assert.equal(writtenData().id, OWN_ID);
  assert.equal(writtenData().company_id, OWN_COMPANY);
});

test("PATCH /product-options/reorder/:productId recusa produto de outra empresa", async () => {
  const res = await send("PATCH", `/product-options/reorder/${OTHER_ID}`, { company_id: OWN_COMPANY, ordered_ids: [1] });
  assert.equal(res.status, 403);
  assert.deepEqual(calls, []);
});

test("PATCH /product-options/reorder/:productId usa a empresa dona do produto", async () => {
  const res = await send("PATCH", `/product-options/reorder/${OWN_ID}`, { company_id: OTHER_COMPANY, ordered_ids: [1] });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0].args, [OWN_ID, OWN_COMPANY, [1]]);
});

test("GET /product-options/product/:productId recusa produto de outra empresa", async () => {
  const res = await send("GET", `/product-options/product/${OTHER_ID}`);
  assert.equal(res.status, 403);
  assert.deepEqual(calls, []);
});

test("GET /product-options/product/:productId lista produto próprio", async () => {
  const res = await send("GET", `/product-options/product/${OWN_ID}`);
  assert.equal(res.status, 200);
});

test("POST /product-options/upload-item-image não usa o nome original como chave", async () => {
  const form = new FormData();
  form.append("image", new Blob(["x"], { type: "image/png" }), "logo.png");
  const res = await fetch(`${baseUrl}/product-options/upload-item-image`, { method: "POST", headers: USER(), body: form });
  assert.equal(res.status, 200);
  const key = calls[0].args[1];
  assert.notEqual(key, "logo.png");
  assert.match(key, /^product_options\/.+\.png$/);
});

test("PATCH /companiessss recusa empresa alheia e aceita a própria", async () => {
  const denied = await send("PATCH", "/companiessss", { id: OTHER_COMPANY, name: "x" });
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, []);

  const allowed = await send("PATCH", "/companiessss", { id: OWN_COMPANY, name: "x" });
  assert.equal(allowed.status, 200);
  assert.equal(writtenData().id, OWN_COMPANY);
});

test("PATCH /companiessss não aceita id alheio junto de companyId próprio", async () => {
  const res = await send("PATCH", "/companiessss", { id: OTHER_COMPANY, companyId: OWN_COMPANY, name: "x" });
  assert.equal(res.status, 403);
  assert.deepEqual(calls, []);
});

test("DELETE /companiessss/:id recusa empresa alheia e aceita a própria", async () => {
  const denied = await send("DELETE", `/companiessss/${OTHER_COMPANY}`);
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, []);

  const allowed = await send("DELETE", `/companiessss/${OWN_COMPANY}`);
  assert.equal(allowed.status, 200);
});

test("POST /companiessss é restrita a admin do sistema e serviço", async () => {
  const denied = await send("POST", "/companiessss", { id: OWN_COMPANY, name: "x" });
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, []);

  assert.equal((await send("POST", "/companiessss", { name: "x" }, ADMIN())).status, 201);
  assert.equal((await send("POST", "/companiessss", { name: "x" }, SERVICE())).status, 201);
});

for (const action of ["qrcode", "test", "status"]) {
  test(`GET /connections/${action}/:instance recusa instância de outra empresa`, async () => {
    const res = await send("GET", `/connections/${action}/${OTHER_INSTANCE}`);
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`GET /connections/${action}/:instance responde 404 para instância sem registro`, async () => {
    const res = await send("GET", `/connections/${action}/inexistente`);
    assert.equal(res.status, 404);
    assert.deepEqual(calls, []);
  });

  test(`GET /connections/${action}/:instance aceita instância própria`, async () => {
    const res = await send("GET", `/connections/${action}/${OWN_INSTANCE}`);
    assert.equal(res.status, 200);
  });
}

test("DELETE /connections/:id/:instance apaga a instância do registro, não a da URL", async () => {
  const res = await send("DELETE", `/connections/${OWN_ID}/${OTHER_INSTANCE}`);
  assert.equal(res.status, 200);
  // evolution.deleteInstance, n8n.remove e connectionsService.remove, nessa ordem.
  assert.deepEqual(calls.map((c) => c.args[0]), [OWN_INSTANCE, OWN_INSTANCE, String(OWN_ID)]);
});

test("DELETE /connections/:id/:instance recusa conexão de outra empresa", async () => {
  const res = await send("DELETE", `/connections/${OTHER_ID}/${OTHER_INSTANCE}`);
  assert.equal(res.status, 403);
  assert.deepEqual(calls, []);
});

test("PATCH /connections/:id não permite ao usuário renomear a instância", async () => {
  const res = await send("PATCH", `/connections/${OWN_ID}`, { instanceName: OTHER_INSTANCE, description: "x" });
  assert.equal(res.status, 200);
  assert.equal(writtenData().instanceName, undefined);
  assert.equal(writtenData().description, "x");
});

test("POST /identity/resolve recusa empresa alheia e aceita a própria", async () => {
  const denied = await send("POST", "/identity/resolve", { company_id: OTHER_COMPANY, phone: "5511999999999" });
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, []);

  const allowed = await send("POST", "/identity/resolve", { company_id: OWN_COMPANY, phone: "5511999999999" });
  assert.equal(allowed.status, 200);
});

test("admin do sistema age sobre qualquer empresa", async () => {
  assert.equal((await send("POST", "/menu_categories", { company_id: OTHER_COMPANY, name: "x" }, ADMIN())).status, 201);
  assert.equal(writtenData().company_id, OTHER_COMPANY);
  calls = [];
  assert.equal((await send("PATCH", "/menu_items", { id: OTHER_ID, company_id: OTHER_COMPANY }, ADMIN())).status, 200);
  assert.equal(writtenData().company_id, OTHER_COMPANY);
  calls = [];
  assert.equal((await send("GET", `/connections/status/${OTHER_INSTANCE}`, undefined, ADMIN())).status, 200);
});

test("principal de serviço continua liberado e mantém o corpo enviado", async () => {
  assert.equal((await send("POST", "/menu_items", { company_id: OTHER_COMPANY, name: "x" }, SERVICE())).status, 201);
  assert.equal(writtenData().company_id, OTHER_COMPANY);
  calls = [];
  assert.equal((await send("PATCH", "/menu_items", { id: OTHER_ID, company_id: OTHER_COMPANY }, SERVICE())).status, 200);
  assert.equal(writtenData().company_id, OTHER_COMPANY);
  calls = [];
  assert.equal((await send("PATCH", `/connections/${OTHER_ID}`, { instanceName: "novo" }, SERVICE())).status, 200);
  assert.equal(writtenData().instanceName, "novo");
  calls = [];
  assert.equal(
    (await send("PATCH", `/product-options/reorder/${OTHER_ID}?company_id=${OTHER_COMPANY}`, { ordered_ids: [1] }, SERVICE())).status,
    200,
  );
  assert.deepEqual(calls[0].args, [OTHER_ID, OTHER_COMPANY, [1]]);
});

test("rotas de escrita recusam pedido sem token", async () => {
  for (const [method, path] of [["POST", "/menu_categories"], ["PATCH", "/menu_items"], ["DELETE", `/payment_methods/${OWN_ID}`]]) {
    const res = await send(method, path, { company_id: OWN_COMPANY }, {});
    assert.equal(res.status, 401, path);
  }
  assert.deepEqual(calls, []);
});

test("POST /connections recusa nome repetido antes de chamar o n8n", async () => {
  const original = connectionsService.find_by_instance;
  connectionsService.find_by_instance = async () => ({ id: OTHER_ID, company_id: OTHER_COMPANY });
  try {
    const res = await send("POST", "/connections", { integration: "x", instanceName: OTHER_INSTANCE, company: OWN_COMPANY });
    assert.equal(res.status, 409);
    assert.deepEqual(calls, []);
  } finally {
    connectionsService.find_by_instance = original;
  }
});

test("POST /connections cria o workflow e a instância quando o nome está livre", async () => {
  const res = await send("POST", "/connections", { integration: "x", instanceName: "livre", company: OWN_COMPANY });
  assert.equal(res.status, 201);
  assert.deepEqual(calls.map((c) => c.name).slice(0, 2), ["find_by_instance", "duplicate"]);
});

// O n8n lê essas tabelas direto do Postgres e o portal envia token; o cardápio público usa /public/*.
const GLOBAL_LISTS = ["/companiessss", "/menu_categories", "/menu_items", "/payment_methods", "/company_opening_hours", "/users"];

for (const path of GLOBAL_LISTS) {
  test(`GET ${path} recusa quem não é admin do sistema`, async () => {
    assert.equal((await send("GET", path, undefined, {})).status, 401);
    assert.equal((await send("GET", path)).status, 403);
    assert.deepEqual(calls, []);
  });

  test(`GET ${path} libera admin do sistema e serviço`, async () => {
    assert.equal((await send("GET", path, undefined, ADMIN())).status, 200);
    assert.equal((await send("GET", path, undefined, SERVICE())).status, 200);
  });
}

const companyRead = (prefix) => [`${prefix}${OWN_COMPANY}`, `${prefix}${OTHER_COMPANY}`];
const lookupRead = (prefix) => [`${prefix}${OWN_ID}`, `${prefix}${OTHER_ID}`];
const TENANT_READS = [
  companyRead("/menu_categories/company/"),
  companyRead("/menu_items/company/"),
  companyRead("/payment_methods/company/"),
  companyRead("/additional_info/company/"),
  companyRead("/company_opening_hours/company/"),
  companyRead("/companiessss/"),
  companyRead("/company/address/"),
  lookupRead("/menu_categories/"),
  lookupRead("/menu_items/"),
  lookupRead("/payment_methods/"),
  lookupRead("/additional_info/"),
  lookupRead("/company_opening_hours/"),
];

for (const [own, other] of TENANT_READS) {
  test(`GET ${own} exige login e vínculo com a empresa`, async () => {
    assert.equal((await send("GET", own, undefined, {})).status, 401);
    assert.equal((await send("GET", other)).status, 403);
    assert.deepEqual(calls, []);
    assert.equal((await send("GET", own)).status, 200);
    assert.equal((await send("GET", other, undefined, ADMIN())).status, 200);
    assert.equal((await send("GET", other, undefined, SERVICE())).status, 200);
  });
}

test("POST /users só aceita admin do sistema autenticado por JWT", async () => {
  const body = { name: "n", email: "n@x.com", password: "segredo" };
  assert.equal((await send("POST", "/users", body, {})).status, 401);
  assert.equal((await send("POST", "/users", body)).status, 403);
  assert.equal((await send("POST", "/users", body, SERVICE())).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await send("POST", "/users", body, ADMIN())).status, 201);
});

test("GET /public/product-options/:id continua sem exigir login", async () => {
  const res = await send("GET", `/public/product-options/${OWN_ID}`, undefined, {});
  assert.equal(res.status, 200);
});

test("menu_items recusa categoria de outra empresa antes de gravar", async () => {
  const realService = originals.find(([target, method]) => target === menuItemsService && method === "create")[2];
  const realUpdate = originals.find(([target, method]) => target === menuItemsService && method === "update")[2];
  const saved = pool.query;
  const seen = [];
  pool.query = async (sql, params = []) => {
    seen.push(sql);
    if (sql.includes("FROM menu_categories")) return { rows: [{ id: params[0][0], company_id: OTHER_COMPANY }] };
    return { rows: [] };
  };
  try {
    const data = { id: OWN_ID, company_id: OWN_COMPANY, category_id: OTHER_ID, name: "x" };
    await assert.rejects(realService(data), { status: 400 });
    await assert.rejects(realUpdate(data), { status: 400 });
    assert.equal(seen.length, 2);
  } finally {
    pool.query = saved;
  }
});
