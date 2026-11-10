const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const notifications = require("../services/merchantNotificationsService");

const withDb = async (handler, fn) => {
  const original = pool.query;
  pool.query = handler;
  try {
    await fn();
  } finally {
    pool.query = original;
  }
};

test("notificação de assinatura usa chave idempotente e referência da empresa", async () => {
  const writes = [];
  await withDb(async (sql, params) => {
    if (sql.includes("to_regclass")) return { rows: [{ name: "merchant_notifications" }] };
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }, async () => {
    const inserted = await notifications.notify({
      companyId: 14,
      type: notifications.TYPES.PAUSED,
      title: "Assinatura pausada",
      message: "Cobrança recusada.",
      subscriptionId: 29,
      eventKey: "subscription:29:paused",
    });
    assert.equal(inserted, true);
  });
  assert.match(writes[0].sql, /ON CONFLICT \(event_key\) DO NOTHING/);
  assert.deepEqual(writes[0].params, [14, "subscription_paused", "Assinatura pausada", "Cobrança recusada.", 29, null, "subscription:29:paused"]);
});

test("listagem e atualização de leitura sempre filtram pela empresa autorizada", async () => {
  const calls = [];
  await withDb(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("to_regclass")) return { rows: [{ name: "merchant_notifications" }] };
    if (sql.startsWith("SELECT id, type")) {
      return { rows: [{ id: 4, company_id: 14, read_at: null }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: 1 }], rowCount: 1 };
    if (sql.startsWith("UPDATE merchant_notifications")) {
      return { rows: [{ id: 4, company_id: 14, read_at: "2026-11-09T12:00:00Z" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }, async () => {
    const listed = await notifications.listForCompany(14, { unreadOnly: true });
    assert.equal(listed.notifications.length, 1);
    assert.equal(listed.unread_count, 1);
    assert.deepEqual(await notifications.markRead(14, 4), {
      id: 4, company_id: 14, read_at: "2026-11-09T12:00:00Z",
    });
  });
  const listQuery = calls.find((call) => call.sql.startsWith("SELECT id, type"));
  const updateQuery = calls.find((call) => call.sql.startsWith("UPDATE merchant_notifications"));
  assert.match(listQuery.sql, /WHERE company_id = \$1/);
  assert.deepEqual(listQuery.params, [14, true, 50]);
  assert.match(updateQuery.sql, /WHERE id = \$1 AND company_id = \$2/);
  assert.deepEqual(updateQuery.params, [4, 14]);
});
