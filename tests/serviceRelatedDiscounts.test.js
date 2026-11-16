const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const menuItemsService = require("../services/menu_itemsService");
const bookingService = require("../services/bookingService");

const { normalizeRelatedDiscounts } = menuItemsService;
const { addOnBaseUnit } = bookingService._internal;

const COMPANY = 7;
const SERVICE = 90;

// Banco simulado: todas as colunas/tabelas existem e o INSERT do serviço
// devolve o próprio item. `writes` guarda o SQL dos produtos sugeridos.
const withFakeDb = async (fn) => {
  const writes = [];
  const handle = async (sql, params = []) => {
    if (sql.includes("information_schema.columns")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("to_regclass")) return { rows: [{ name: "x" }] };
    if (sql.includes("FROM menu_categories")) return { rows: [{ id: params[0][0], company_id: COMPANY }] };
    if (sql.includes("INSERT INTO menu_items")) return { rows: [{ id: SERVICE, company_id: COMPANY }] };
    if (sql.includes("service_related_products")) writes.push({ sql, params });
    return { rows: [] };
  };
  const original = { query: pool.query, connect: pool.connect };
  pool.query = handle;
  pool.connect = async () => ({ query: handle, release: () => {} });
  try {
    await fn(writes);
  } finally {
    pool.query = original.query;
    pool.connect = original.connect;
  }
};

const service = (extra = {}) => ({
  company_id: COMPANY,
  category_id: 3,
  name: "Corte",
  price: 50,
  available: true,
  item_type: "service",
  duration_minutes: 30,
  related_product_ids: [11, 12],
  ...extra,
});

test("desconto ausente ou zero vira 0; mapa ausente preserva o atual", () => {
  assert.equal(normalizeRelatedDiscounts([11], undefined), null);
  assert.equal(normalizeRelatedDiscounts(null, { 11: 10 }), null);
  const discounts = normalizeRelatedDiscounts([11, 12, 13], { 11: 0, "12": "15.5" });
  assert.deepEqual([...discounts], [[11, 0], [12, 15.5], [13, 0]]);
});

test("rejeita desconto fora de 0–99", () => {
  for (const value of [-1, 100, 150, "abc"]) {
    assert.throws(() => normalizeRelatedDiscounts([11], { 11: value }), (e) => e.status === 400);
  }
  assert.throws(() => normalizeRelatedDiscounts([11], [10]), (e) => e.status === 400);
});

test("grava o desconto de cada produto sugerido na ordem recebida", async () => {
  await withFakeDb(async (writes) => {
    await menuItemsService.create(service({ related_product_discounts: { 11: 10, 12: 0 } }));
    const insert = writes.find((w) => w.sql.includes("INSERT INTO service_related_products"));
    assert.match(insert.sql, /discount_percent/);
    assert.deepEqual(insert.params.slice(2), [[11, 12], [10, 0]]);
  });
});

test("serviço com desconto fora da faixa não é salvo", async () => {
  await withFakeDb(async (writes) => {
    await assert.rejects(
      menuItemsService.create(service({ related_product_discounts: { 11: 100 } })),
      (e) => e.status === 400,
    );
    assert.equal(writes.length, 0);
  });
});

test("preço do produto levado junto aplica o desconto sem somar com campanha", () => {
  assert.equal(addOnBaseUnit(20, null, 0), 20);
  assert.equal(addOnBaseUnit(20, null, 10), 18);
  // Campanha melhor que o desconto: vale a campanha.
  assert.equal(addOnBaseUnit(20, { final_price: 15 }, 10), 15);
  // Desconto melhor que a campanha: vale o desconto.
  assert.equal(addOnBaseUnit(20, { final_price: 19 }, 10), 18);
});
