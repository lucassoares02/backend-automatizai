const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inclusiveLeadDayOffset,
  meetsInclusiveLeadDays,
  normalizePreorder,
} = require("../helpers/preorder");

test("normaliza configuração de encomenda e limpa dias quando desativada", () => {
  assert.deepEqual(
    normalizePreorder({ preorder_only: true, preorder_lead_days: "3" }),
    { preorderOnly: true, preorderLeadDays: 3 },
  );
  assert.deepEqual(
    normalizePreorder({ preorder_only: false, preorder_lead_days: 10 }),
    { preorderOnly: false, preorderLeadDays: null },
  );
});

test("rejeita antecedência fora do intervalo permitido", () => {
  assert.throws(
    () => normalizePreorder({ preorder_only: true, preorder_lead_days: 0 }),
    /entre 1 e 365 dias/,
  );
  assert.throws(
    () => normalizePreorder({ preorder_only: true, preorder_lead_days: 366 }),
    /entre 1 e 365 dias/,
  );
});

test("conta o dia do pedido como primeiro dia da antecedência", () => {
  const orderedAt = new Date("2026-09-08T18:00:00-03:00");
  assert.equal(inclusiveLeadDayOffset(3), 2);
  assert.equal(
    meetsInclusiveLeadDays({
      orderedAt,
      scheduledAt: new Date("2026-09-09T20:00:00-03:00"),
      leadDays: 3,
    }),
    false,
  );
  assert.equal(
    meetsInclusiveLeadDays({
      orderedAt,
      scheduledAt: new Date("2026-09-10T09:00:00-03:00"),
      leadDays: 3,
    }),
    true,
  );
});

test("usa o calendário de São Paulo mesmo perto da virada em UTC", () => {
  assert.equal(
    meetsInclusiveLeadDays({
      orderedAt: new Date("2026-09-09T01:30:00Z"), // 08/09 em São Paulo
      scheduledAt: new Date("2026-09-11T03:00:00Z"), // 11/09 em São Paulo
      leadDays: 4,
    }),
    true,
  );
});
