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

const pack = (extra = {}) => ({
  success: true,
  version: "arbian-menu-import/2",
  company_id: 7,
  categories: [],
  review: { needed: false, issues: [] },
  ...extra,
});

const ok = () => new Response(JSON.stringify(pack()), { status: 200 });

const MB = 1024 * 1024;

// A prévia consulta o banco; nos testes do controller ela não importa.
service.buildPreviewContext = async () => ({ company: null, existing_items: 0 });

// Passa o multipart real pelo multer, com o envio ao webhook substituído.
const postFile = async ({ size, type, name }) => {
  const original = service.sendToWebhook;
  const sent = [];
  const originalContext = service.buildPreviewContext;
  service.sendToWebhook = async (args) => { sent.push(args); return { status: 200, pack: pack() }; };
  service.buildPreviewContext = async () => ({ company: null, existing_items: 0 });

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
    service.buildPreviewContext = originalContext;
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

test("pacote do extrator volta para o painel com o contexto da prévia", async () => {
  await withFetch(ok, async () => {
    const res = fakeRes();
    await controller.importMenu({ body: { company_id: "7", url: "https://loja.com" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pack.version, "arbian-menu-import/2");
    assert.deepEqual(res.body.context, { company: null, existing_items: 0 });
  });
});

test("422 do extrator vira 422 com a mensagem da pendência", async () => {
  const body = pack({
    success: false,
    review: { needed: true, issues: [{ ref: null, code: "no_menu_content", message: "Não achamos cardápio na página." }] },
  });
  await withFetch(() => new Response(JSON.stringify(body), { status: 422 }), async () => {
    const res = fakeRes();
    await controller.importMenu({ body: { company_id: "7", url: "https://loja.com" } }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "no_menu_content");
    assert.equal(res.body.message, "Não achamos cardápio na página.");
  });
});

test("pacote de outra versão ou de outra empresa é recusado", async () => {
  const original = console.error;
  console.error = () => {};
  for (const [body, code] of [
    [pack({ version: "arbian-menu-import/1" }), "UNSUPPORTED_VERSION"],
    [pack({ company_id: 8 }), "COMPANY_MISMATCH"],
  ]) {
    await withFetch(() => new Response(JSON.stringify(body), { status: 200 }), async () => {
      const res = fakeRes();
      await controller.importMenu({ body: { company_id: "7", url: "https://loja.com" } }, res);
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, code);
    });
  }
  console.error = original;
});

test("normalização ignora acento, caixa e espaços repetidos", () => {
  assert.equal(service.normalizeName("  Porções  Especiais "), service.normalizeName("porcoes especiais"));
});

test("SKU ocupado recebe sufixo -2, -3", () => {
  const taken = new Set(["208", "208-2"]);
  assert.equal(service.resolveSku("208", taken), "208-3");
  assert.equal(service.resolveSku("208", taken), "208-4");
  assert.equal(service.resolveSku("", taken), null);
});

// ─── Gravação ───────────────────────────────────────────────────────────────

const pool = require("../db");

// Cliente falso: responde às consultas da gravação e registra cada SQL.
const withFakeClient = async (answers, fn) => {
  const calls = [];
  let nextId = 100;
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      for (const [match, rows] of answers) {
        if (sql.includes(match)) return { rows: typeof rows === "function" ? rows(params) : rows, rowCount: 1 };
      }
      if (/^\s*INSERT/.test(sql)) return { rows: [{ id: nextId++ }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    await fn(calls);
  } finally {
    pool.connect = original;
  }
};

const baseAnswers = () => [
  ["FOR UPDATE", [{ dietary_restrictions: ["Sem glúten"], custom_dietary_restrictions: null }]],
  ["FROM menu_categories WHERE company_id = $1 AND active", [{ id: 5, name: "Petiscos" }]],
  ["MAX(sort_order)", [{ n: 3 }]],
  ["MAX(display_order)", [{ n: 10 }]],
  ["SELECT sku FROM menu_items", [{ sku: "RISOLE" }]],
  ["SELECT description, phone", [{ description: "Já tenho", phone: null, cuisine_type: null, logo_url: null }]],
  ["COUNT(*)::int AS n FROM company_addresses", [{ n: 1 }]],
  ["COUNT(*)::int AS n FROM company_opening_hours", [{ n: 0 }]],
  ["SELECT title FROM additional_info", [{ title: "Instagram" }]],
];

const item = (extra = {}) => ({
  ref: "i1", name: "Risole", description: "10 unidades", price: 48, price_type: "fixed", sku: "RISOLE",
  display_order: 1, available: true, featured: false, prep_time_minutes: null, preorder_only: false,
  preorder_lead_days: null, dietary_restrictions: ["sem gluten", "Vegano"], images: [],
  option_groups: [{ name: "Recheio", type: "single", min_selection: 1, max_selection: 1, is_required: true, sort_order: 1,
    options: [{ name: "Costela", additional_price: 0, sort_order: 1, image_url: null }] }],
  ...extra,
});

test("gravação reusa categoria, resolve selo e SKU e só preenche dados vazios", async () => {
  const p = pack({
    dietary_restrictions: ["Sem Glúten", "Vegano"],
    categories: [
      { ref: "c1", name: "PETISCOS", sort_order: 1, items: [item()] },
      { ref: "c2", name: "Bebidas", sort_order: 2, items: [item({ ref: "i2", name: "Suco", sku: "SUCO", option_groups: [], dietary_restrictions: [] })] },
    ],
    company: {
      description: "Botequim", phone: "11999990000", cuisine_type: "Botequim", logo_url: null,
      address: { street: "Rua A", city: "SP", state: "SP" },
      opening_hours: [{ weekday: 1, opens_at: "18:00", closes_at: "23:00" }, { weekday: 9, opens_at: "x", closes_at: "y" }],
      additional_info: [{ title: "instagram", content: "@x" }, { title: "Couvert", content: "R$ 10", trigger_keywords: "couvert" }],
    },
  });

  await withFakeClient(baseAnswers(), async (calls) => {
    const summary = await service.applyPackage(7, p);
    const sqls = calls.map((c) => c.sql);

    assert.equal(sqls[0], "BEGIN");
    assert.equal(sqls.at(-1), "COMMIT");
    assert.equal(summary.categories_reused, 1);
    assert.equal(summary.categories_created, 1);
    assert.equal(summary.items_created, 2);
    assert.equal(summary.option_groups_created, 1);
    assert.equal(summary.option_items_created, 1);
    assert.deepEqual(summary.selos_created, ["Vegano"]);
    assert.deepEqual(summary.company_fields, ["phone", "cuisine_type"]);
    assert.equal(summary.address_created, false);
    assert.equal(summary.opening_hours_created, 1);
    assert.equal(summary.additional_info_created, 1);

    const newCat = calls.find((c) => c.sql.startsWith("INSERT INTO menu_categories"));
    assert.deepEqual(newCat.params, [7, "Bebidas", 5]);

    const items = calls.filter((c) => c.sql.startsWith("INSERT INTO menu_items"));
    assert.equal(items[0].params[1], 5); // categoria reusada
    assert.equal(items[0].params[6], "RISOLE-2");
    assert.equal(items[0].params[7], 11); // depois dos atuais
    assert.deepEqual(items[0].params[13], ["Sem glúten", "Vegano"]);
    assert.equal(items[1].params[7], 1); // categoria nova começa do zero

    const selos = calls.find((c) => c.sql.startsWith("UPDATE companies SET dietary_restrictions"));
    assert.deepEqual(selos.params, [7, ["Sem glúten", "Vegano"], ["Vegano"]]);
  });
});

test("produto sem preço bloqueia a gravação antes de abrir transação", async () => {
  const p = pack({ categories: [{ name: "Doces", items: [item({ ref: "i6", name: "Pudim", price: null })] }] });
  await withFakeClient(baseAnswers(), async (calls) => {
    await assert.rejects(service.applyPackage(7, p), (e) => e.code === "PRICE_MISSING" && e.ref === "i6" && e.status === 400);
    assert.equal(calls.length, 0);
  });
});

test("erro no meio da gravação faz ROLLBACK", async () => {
  const p = pack({ categories: [{ name: "Doces", items: [item()] }] });
  const answers = [["INSERT INTO menu_items", () => { throw new Error("falhou"); }], ...baseAnswers()];
  await withFakeClient(answers, async (calls) => {
    await assert.rejects(service.applyPackage(7, p), /falhou/);
    assert.equal(calls.at(-1).sql, "ROLLBACK");
    assert.ok(!calls.some((c) => c.sql === "COMMIT"));
  });
});

test("confirmação devolve 400 com o ref do item sem preço", async () => {
  const res = fakeRes();
  await controller.confirmImport(
    { body: { company_id: 7, pack: pack({ categories: [{ name: "Doces", items: [item({ price: null })] }] }) } },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "PRICE_MISSING");
  assert.equal(res.body.ref, "i1");
});
