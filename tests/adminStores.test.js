const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../services/adminStoresService");
const routes = require("../src/routes");
const { requireSystemAdminUser } = require("../src/middlewares/authorize");

// Banco falso: responde por trecho de SQL e registra as chamadas.
const fakeDb = (handlers) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push([sql, params]);
      for (const [match, reply] of handlers) {
        if (sql.includes(match)) return typeof reply === "function" ? reply(params) : reply;
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
};

const store = ["FROM companies WHERE id", { rows: [{ id: 7 }] }];
const user = ["FROM users", { rows: [{ id: 3, name: "Ana", email: "ana@x.com" }] }];

test("todas as rotas /admin/stores exigem admin do sistema autenticado por usuário", () => {
  const layers = routes.stack.filter((l) => l.route?.path?.startsWith("/admin/stores"));
  assert.equal(layers.length, 4);
  for (const layer of layers) {
    const handles = layer.route.stack.map((s) => s.handle);
    assert.ok(handles.includes(requireSystemAdminUser), layer.route.path);
  }
});

test("vincula e-mail existente gravando relation_type 0 e normaliza o e-mail", async () => {
  const db = fakeDb([store, user, ["INSERT INTO user_companies", { rows: [{ created_at: "now" }] }]]);
  const out = await service.linkUserByEmail(7, "  Ana@X.com ", db);
  assert.equal(out.id, 3);
  const lookup = db.calls.find(([sql]) => sql.includes("FROM users"));
  assert.deepEqual(lookup[1], ["ana@x.com"]);
  const insert = db.calls.find(([sql]) => sql.includes("INSERT INTO user_companies"));
  assert.deepEqual(insert[1], [3, 7, 0]);
});

test("e-mail não cadastrado não cria usuário nem vínculo", async () => {
  const db = fakeDb([store, ["FROM users", { rows: [] }]]);
  await assert.rejects(service.linkUserByEmail(7, "novo@x.com", db), { code: "USER_NOT_FOUND" });
  assert.ok(!db.calls.some(([sql]) => /INSERT/i.test(sql)));
});

test("vínculo repetido retorna ALREADY_LINKED", async () => {
  const db = fakeDb([store, user, ["INSERT INTO user_companies", { rows: [] }]]);
  await assert.rejects(service.linkUserByEmail(7, "ana@x.com", db), { code: "ALREADY_LINKED" });
});

test("e-mail inválido e loja inexistente são recusados antes de gravar", async () => {
  await assert.rejects(service.linkUserByEmail(7, "invalido", fakeDb([])), { code: "INVALID_EMAIL" });
  const db = fakeDb([["FROM companies WHERE id", { rows: [] }]]);
  await assert.rejects(service.linkUserByEmail(99, "ana@x.com", db), { code: "STORE_NOT_FOUND" });
});

test("remover vínculo inexistente retorna LINK_NOT_FOUND", async () => {
  const db = fakeDb([["DELETE FROM user_companies", { rowCount: 0 }]]);
  await assert.rejects(service.unlinkUser(7, 3, db), { code: "LINK_NOT_FOUND" });
});
