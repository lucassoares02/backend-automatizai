const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../services/adminCompanyDeletionService");
const routes = require("../src/routes");
const { requireSystemAdminUser } = require("../src/middlewares/authorize");

// Cliente falso de transação: responde por trecho de SQL e registra as chamadas.
const fakeDb = (handlers = []) => {
  const calls = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      calls.push([sql.trim(), params]);
      for (const [match, reply] of handlers) {
        if (sql.includes(match)) return typeof reply === "function" ? reply(params) : reply;
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  return { calls, connect: async () => client, get released() { return released; } };
};

const company = ["FROM companies WHERE id = $1 FOR UPDATE", { rows: [{ id: 7, name: "Pizzaria Teste" }] }];

const noExternals = () => {
  const done = [];
  return {
    done,
    cancelSubscription: async (id) => done.push(["sub", id]),
    deleteInstance: async (i) => done.push(["evo", i]),
    removeWorkflow: async (i) => done.push(["n8n", i]),
  };
};

test("rota DELETE /admin/stores/:companyId exige admin do sistema autenticado por usuário", () => {
  const layer = routes.stack.find(
    (l) => l.route?.path === "/admin/stores/:companyId" && l.route.methods.delete,
  );
  assert.ok(layer);
  assert.ok(layer.route.stack.map((s) => s.handle).includes(requireSystemAdminUser));
});

test("nome digitado diferente não apaga nada e faz ROLLBACK", async () => {
  const db = fakeDb([company]);
  await assert.rejects(
    service.deleteCompany(7, "Pizzaria", { db, externals: noExternals() }),
    { code: "NAME_MISMATCH" },
  );
  assert.ok(!db.calls.some(([sql]) => sql.startsWith("DELETE")));
  assert.ok(db.calls.some(([sql]) => sql === "ROLLBACK"));
  assert.ok(db.released);
});

test("loja inexistente retorna STORE_NOT_FOUND", async () => {
  const db = fakeDb([["FROM companies WHERE id = $1 FOR UPDATE", { rows: [] }]]);
  await assert.rejects(service.deleteCompany(99, "x", { db, externals: noExternals() }), {
    code: "STORE_NOT_FOUND",
  });
});

test("exclui tudo em transação, remove usuários exclusivos e limpa recursos externos", async () => {
  const ext = noExternals();
  const db = fakeDb([
    company,
    ["FROM connections WHERE company_id", { rows: [{ instance_name: "loja7" }] }],
    ["SELECT pagarme_subscription_id", { rows: [{ pagarme_subscription_id: "sub_1" }] }],
    ["SELECT DISTINCT u.id", { rows: [{ id: 3 }] }],
    ["DELETE FROM orders", { rows: [], rowCount: 2 }],
    ["DELETE FROM users", { rows: [], rowCount: 1 }],
    ["information_schema.columns", { rows: [{ table_name: "orders" }] }],
    ["SELECT COUNT(*)", { rows: [{ n: 0 }] }],
  ]);
  const out = await service.deleteCompany(7, "  Pizzaria Teste ", { db, externals: ext });

  const sqls = db.calls.map(([sql]) => sql);
  assert.equal(sqls[0], "BEGIN");
  assert.ok(sqls.includes("COMMIT"));
  const companyDelete = sqls.findIndex((s) => s.startsWith("DELETE FROM companies"));
  assert.ok(companyDelete > sqls.findIndex((s) => s.startsWith("DELETE FROM orders")));
  assert.ok(companyDelete > sqls.findIndex((s) => s.startsWith("DELETE FROM user_companies")));
  // Conferência de sobras roda antes do COMMIT.
  assert.ok(sqls.findIndex((s) => s.startsWith("SELECT COUNT(*)")) < sqls.indexOf("COMMIT"));

  assert.equal(out.removed.orders, 2);
  assert.equal(out.removed_users, 1);
  assert.deepEqual(out.external_failures, []);
  assert.deepEqual(ext.done, [["sub", "sub_1"], ["evo", "loja7"], ["n8n", "loja7"]]);
});

test("sobra de company_id reverte a transação e não toca recursos externos", async () => {
  const ext = noExternals();
  const db = fakeDb([
    company,
    ["FROM connections WHERE company_id", { rows: [{ instance_name: "loja7" }] }],
    ["information_schema.columns", { rows: [{ table_name: "tabela_nova" }] }],
    ["SELECT COUNT(*)", { rows: [{ n: 4 }] }],
  ]);
  await assert.rejects(service.deleteCompany(7, "Pizzaria Teste", { db, externals: ext }), {
    code: "LEFTOVER_ROWS",
  });
  assert.ok(db.calls.some(([sql]) => sql === "ROLLBACK"));
  assert.ok(!db.calls.some(([sql]) => sql === "COMMIT"));
  assert.deepEqual(ext.done, []);
});

test("falha na limpeza externa não desfaz a exclusão e é reportada", async () => {
  const ext = {
    cancelSubscription: async () => {},
    deleteInstance: async () => { throw new Error("offline"); },
    removeWorkflow: async () => {},
  };
  const db = fakeDb([
    company,
    ["FROM connections WHERE company_id", { rows: [{ instance_name: "loja7" }] }],
  ]);
  const out = await service.deleteCompany(7, "Pizzaria Teste", { db, externals: ext });
  assert.deepEqual(out.external_failures, ["Evolution loja7: offline"]);
});

test("loja sem nome exige o rótulo 'Loja #id' mostrado no portal", () => {
  assert.equal(service.expectedConfirmation({ id: 5, name: "  " }), "Loja #5");
  assert.equal(service.expectedConfirmation({ id: 5, name: " Ana " }), "Ana");
});
