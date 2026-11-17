const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const appointmentsService = require("../services/appointmentsService");

// Pedido 281: só um produto, entrega, sem agendamento de serviço.
const ROW = {
  id: 281,
  tag: "9PZ0ZA",
  uuid: "u-281",
  status: 1,
  delivery_type: true,
  scheduled_for: null,
  created_at: new Date("2026-11-17T13:22:34Z"),
  total: "104.78",
  notes: null,
  client_id: 67,
  client_name: "Lucas",
  client_phone: "5511999999999",
  items: [{ item_name: "Hidratante Antiatrito", quantity: 1, options: [{ option_name: "150g", quantity: 1 }] }],
};

pool.query = async (sql) => {
  if (sql.includes("information_schema.columns")) return { rows: [{}], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

const fakeDb = (rows, calls) => ({
  query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows, rowCount: rows.length };
  },
});

test("pedidos só de produtos: sem agendamento, com itens e fora dos cancelados", async () => {
  const calls = [];
  const start = new Date("2026-11-17T03:00:00Z");
  const end = new Date("2026-11-18T03:00:00Z");
  const rows = await appointmentsService._productOrdersInRange(47, start, end, false, fakeDb([ROW], calls));

  const { sql, params } = calls[0];
  assert.deepEqual(params, [47, start, end]);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM appointments a WHERE a\.order_id = o\.id\)/);
  assert.match(sql, /COALESCE\(o\.scheduled_for, o\.created_at AT TIME ZONE 'UTC'\) >= \$2/);
  assert.match(sql, /o\.status NOT IN \(6, 7\)/);
  assert.match(sql, /oi\.subscription_id IS NOT NULL/);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].delivery_type, "delivery");
  assert.equal(rows[0].total, 104.78);
  assert.equal(rows[0].items[0].item_name, "Hidratante Antiatrito");
});

test("pedidos só de produtos: inclui cancelados quando pedido e mapeia retirada", async () => {
  const calls = [];
  const rows = await appointmentsService._productOrdersInRange(
    47, new Date(), new Date(), true,
    fakeDb([{ ...ROW, delivery_type: false, items: null }], calls),
  );
  assert.doesNotMatch(calls[0].sql, /NOT IN \(6, 7\)/);
  assert.equal(rows[0].delivery_type, "pickup");
  assert.deepEqual(rows[0].items, []);
});
