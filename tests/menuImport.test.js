const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const controller = require("../controllers/menuImportController");
const service = require("../services/menuImportService");

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

const MB = 1024 * 1024;

// Passa o multipart real pelo multer, com o envio ao webhook substituído.
const postFile = async ({ size, type, name }) => {
  const original = service.sendToWebhook;
  const sent = [];
  service.sendToWebhook = async (args) => { sent.push(args); };

  const app = express();
  app.post("/menu-import", controller.upload, controller.importMenu);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const form = new FormData();
    form.append("company_id", "7");
    form.append("file", new Blob([Buffer.alloc(size)], { type }), name);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/menu-import`, { method: "POST", body: form });
    return { status: res.status, body: await res.json(), sent };
  } finally {
    service.sendToWebhook = original;
    await new Promise((resolve) => server.close(resolve));
  }
};

test("PDF de 45 MB passa pelo limite e chega inteiro ao webhook", async () => {
  const { status, sent } = await postFile({ size: 45 * MB, type: "application/pdf", name: "cardapio.pdf" });

  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].file.buffer.length, 45 * MB);
});

test("PDF de exatamente 50 MB é aceito", async () => {
  const { status } = await postFile({ size: 50 * MB, type: "application/pdf", name: "cardapio.pdf" });
  assert.equal(status, 200);
});

test("PDF acima de 50 MB é recusado com 413", async () => {
  const { status, body, sent } = await postFile({ size: 50 * MB + 1, type: "application/pdf", name: "cardapio.pdf" });

  assert.equal(status, 413);
  assert.equal(body.error, "FILE_TOO_LARGE");
  assert.equal(sent.length, 0);
});

test("imagem continua limitada a 10 MB", async () => {
  const accepted = await postFile({ size: 10 * MB, type: "image/png", name: "cardapio.png" });
  assert.equal(accepted.status, 200);

  const refused = await postFile({ size: 10 * MB + 1, type: "image/png", name: "cardapio.png" });
  assert.equal(refused.status, 413);
  assert.equal(refused.body.error, "FILE_TOO_LARGE");
  assert.equal(refused.sent.length, 0);
});

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
