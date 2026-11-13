const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../services/customerTrackingService");

const { rotationReason, archivedSessionId, buildMetrics } = service._testing;

const now = new Date("2026-11-13T12:00:00Z");
const minutesAgo = (m) => new Date(now.getTime() - m * 60 * 1000).toISOString();

test("sem visita anterior não há rotação", () => {
  assert.equal(rotationReason(null, { status: "browsing", current_step: "menu" }, now), null);
});

test("visita parada há mais de 30 min abre uma nova visita", () => {
  const row = { order_id: null, last_activity_at: minutesAgo(31) };
  assert.equal(
    rotationReason(row, { status: "selecting_products", current_step: "menu" }, now),
    "new_visit",
  );
  assert.equal(
    rotationReason({ ...row, last_activity_at: minutesAgo(5) }, { status: "cart", current_step: "cart" }, now),
    null,
  );
});

test("aba aberta parada (só heartbeat) continua na mesma visita", () => {
  const row = { order_id: null, last_activity_at: minutesAgo(45), last_seen_at: minutesAgo(1) };
  assert.equal(rotationReason(row, { status: "cart", current_step: "cart" }, now), null);
});

test("cliente que comprou e voltou ao cardápio ganha visita nova", () => {
  const row = { order_id: 236, status: "order_created", last_activity_at: minutesAgo(2) };
  assert.equal(
    rotationReason(row, { status: "browsing", current_step: "menu", order_id: null }, now),
    "after_order",
  );
  assert.equal(
    rotationReason(row, { status: "cart", current_step: "cart", order_id: null }, now),
    "after_order",
  );
});

test("pós-pedido da mesma compra não abre visita nova", () => {
  const row = { order_id: 236, status: "order_created", last_activity_at: minutesAgo(1) };
  // acompanhamento / confirmação
  assert.equal(rotationReason(row, { status: "order_created", current_step: "tracking" }, now), null);
  // pagamento online do pedido recém-criado
  assert.equal(
    rotationReason(row, { status: "payment_selection", current_step: "card_entry", order_id: null }, now),
    null,
  );
  // cliente informa o próprio pedido
  assert.equal(
    rotationReason(row, { status: "browsing", current_step: "menu", order_id: 236 }, now),
    null,
  );
});

test("id arquivado mantém o token do dispositivo e cabe em 64 caracteres", () => {
  const sid = "cts_hmcik00kyw_e6dq9u9a0ogd2ecefp";
  const archived = archivedSessionId(sid, now);
  assert.ok(archived.startsWith(`${sid}${service.ARCHIVE_SEPARATOR}`));
  assert.equal(archived.split(service.ARCHIVE_SEPARATOR)[0], sid);
  assert.ok(archivedSessionId("x".repeat(64), now).length <= 64);
});

test("indicadores separam navegando agora e abandonados", () => {
  const m = buildMetrics([
    { presence: "online", cart_items_count: 0, subtotal: "0.00", order_id: null },
    { presence: "online", cart_items_count: 2, subtotal: "38.80", order_id: null },
    { presence: "online", cart_items_count: 1, subtotal: "27.90", order_id: 274 },
    { presence: "abandoned", cart_items_count: 1, subtotal: "135.00", order_id: null },
  ]);
  assert.deepEqual(m, {
    online: 3,
    online_with_cart: 1,
    online_cart_value: 38.8,
    abandoned_carts: 1,
    abandoned_value: 135,
  });
});
