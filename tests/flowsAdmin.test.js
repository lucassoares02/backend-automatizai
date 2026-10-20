const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../services/flowsAdminService");
const { requireSystemAdminUser } = require("../src/middlewares/authorize");

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const conns = [
  { id: 1, company_id: 10, instance_name: "loja-a", company_name: "A" },
  { id: 2, company_id: 20, instance_name: "loja-b", company_name: "B" },
  { id: 3, company_id: 30, instance_name: "loja-c", company_name: null },
];

test("só admin do sistema autenticado por usuário passa no middleware", () => {
  const cases = [
    [{ isSystemAdmin: true, isService: false }, true],
    [{ isSystemAdmin: false, isService: false, user: { type: 0 } }, false],
    [{ isSystemAdmin: false, isService: true }, false],
    [{ isSystemAdmin: true, isService: true }, false],
    [{}, false],
  ];
  for (const [req, allowed] of cases) {
    let called = false;
    const res = fakeRes();
    requireSystemAdminUser(req, res, () => { called = true; });
    assert.equal(called, allowed, JSON.stringify(req));
    if (!allowed) assert.equal(res.statusCode, 403);
  }
});

test("busca o template uma vez e atualiza todas as conexões", async () => {
  let fetches = 0;
  const calls = [];
  const template = { nodes: [] };
  const out = await service.updateAll({
    list: async () => conns,
    fetchTemplate: async () => { fetches += 1; return template; },
    update: async (instance, company, tpl) => { calls.push([instance, company, tpl]); },
  });
  assert.equal(fetches, 1);
  assert.deepEqual(calls, [["loja-a", 10, template], ["loja-b", 20, template], ["loja-c", 30, template]]);
  assert.equal(out.total, 3);
  assert.equal(out.updated, 3);
  assert.equal(out.failed, 0);
  assert.equal(out.results[2].company_name, null);
});

test("falha numa conexão não interrompe as demais", async () => {
  const out = await service.updateAll({
    list: async () => conns,
    fetchTemplate: async () => ({}),
    update: async (instance) => { if (instance === "loja-b") throw new Error("activate failed"); },
  });
  assert.equal(out.updated, 2);
  assert.equal(out.failed, 1);
  const b = out.results.find((r) => r.instance_name === "loja-b");
  assert.equal(b.success, false);
  assert.equal(b.error, "activate failed");
});

test("sem conexões não busca o template", async () => {
  const out = await service.updateAll({
    list: async () => [],
    fetchTemplate: async () => { throw new Error("não deveria buscar"); },
    update: async () => {},
  });
  assert.equal(out.total, 0);
});

test("template indisponível aborta sem tocar nas conexões e libera a trava", async () => {
  let updates = 0;
  await assert.rejects(
    service.updateAll({
      list: async () => conns,
      fetchTemplate: async () => { throw new Error("N8N template fetch failed [500]"); },
      update: async () => { updates += 1; },
    }),
    /template fetch failed/,
  );
  assert.equal(updates, 0);
  assert.equal(service.isRunning(), false);
});

test("bloqueia execução simultânea", async () => {
  let release;
  const first = service.updateAll({
    list: async () => conns.slice(0, 1),
    fetchTemplate: async () => ({}),
    update: () => new Promise((r) => { release = r; }),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(service.isRunning(), true);
  await assert.rejects(service.updateAll({ list: async () => [] }), (e) => e.code === "ALREADY_RUNNING");
  release();
  await first;
  assert.equal(service.isRunning(), false);
});
