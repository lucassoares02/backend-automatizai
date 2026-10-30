const test = require("node:test");
const assert = require("node:assert/strict");
const controller = require("../controllers/menuImportController");

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const withFetch = async (impl, fn) => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl();
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = original;
  }
};

const ok = () => new Response("{}", { status: 200 });

test("URL é encaminhada ao webhook via https com company_id e source", async () => {
  await withFetch(ok, async (calls) => {
    const res = fakeRes();
    await controller.importMenu({ body: { company_id: "7", url: " https://loja.com/cardapio " } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://n8n.arbian.com.br/webhook/cardapio-digital");
    const form = calls[0].options.body;
    assert.equal(form.get("company_id"), "7");
    assert.equal(form.get("source"), "url");
    assert.equal(form.get("url"), "https://loja.com/cardapio");
    assert.equal(form.get("file"), null);
  });
});

test("arquivo é encaminhado como binário preservando tipo e acentos do nome", async () => {
  await withFetch(ok, async (calls) => {
    const res = fakeRes();
    const originalname = Buffer.from("cardápio.pdf", "utf8").toString("latin1");
    await controller.importMenu(
      { body: { company_id: "7" }, file: { buffer: Buffer.from("%PDF"), mimetype: "application/pdf", originalname } },
      res,
    );

    assert.equal(res.statusCode, 200);
    const form = calls[0].options.body;
    assert.equal(form.get("source"), "file");
    assert.equal(form.get("url"), null);
    const file = form.get("file");
    assert.equal(file.name, "cardápio.pdf");
    assert.equal(file.type, "application/pdf");
    assert.equal(await file.text(), "%PDF");
  });
});

test("entradas inválidas são recusadas sem chamar o webhook", async () => {
  const file = { buffer: Buffer.from("x"), mimetype: "image/png", originalname: "a.png" };
  const cases = [
    [{ body: { url: "https://loja.com" } }, "INVALID_COMPANY"],
    [{ body: { company_id: "7" } }, "INVALID_SOURCE"],
    [{ body: { company_id: "7", url: "https://loja.com" }, file }, "INVALID_SOURCE"],
    [{ body: { company_id: "7", url: "javascript:alert(1)" } }, "INVALID_URL"],
    [{ body: { company_id: "7", url: "não é url" } }, "INVALID_URL"],
    [{ body: { company_id: "7", url: `https://loja.com/${"a".repeat(2048)}` } }, "INVALID_URL"],
  ];
  await withFetch(ok, async (calls) => {
    for (const [req, code] of cases) {
      const res = fakeRes();
      await controller.importMenu(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, code);
    }
    assert.equal(calls.length, 0);
  });
});

test("falha do webhook vira 502 sem vazar detalhes", async () => {
  await withFetch(() => new Response("segredo interno", { status: 500 }), async () => {
    const res = fakeRes();
    const original = console.error;
    console.error = () => {};
    await controller.importMenu({ body: { company_id: "7", url: "https://loja.com" } }, res);
    console.error = original;

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "WEBHOOK_FAILED");
    assert.ok(!JSON.stringify(res.body).includes("segredo"));
  });
});
