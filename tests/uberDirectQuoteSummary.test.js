const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../services/uberDirectService");

test("expõe na cotação um bloco uber identificável com valor em reais", () => {
  const quote = _private.normalizeQuote({
    id: "dqt_123",
    fee: 1234,
    currency: "brl",
    created: "2026-09-10T15:00:00.000Z",
    expires: "2026-09-10T15:15:00.000Z",
    dropoff_eta: "2026-09-10T16:40:00.000Z",
    duration: 30,
    pickup_duration: 8,
  });
  const payload = {
    pickup_name: "Monchou",
    pickup_address: "R. Machado de Assis, 335 - Serra - ES",
    pickup_ready_dt: "2026-09-10T16:10:00.000Z",
    pickup_deadline_dt: "2026-09-10T16:30:00.000Z",
    pickup_latitude: -20.19,
    pickup_longitude: -40.25,
    dropoff_name: "Lucas Soares",
    dropoff_address: "Av. Copacabana, 540 - Serra - ES",
    dropoff_ready_dt: "2026-09-10T16:10:00.000Z",
    dropoff_deadline_dt: "2026-09-10T17:05:00.000Z",
  };

  const uber = _private.buildUberSummary({
    quote,
    payload,
    now: new Date("2026-09-10T15:05:30.000Z"),
  });

  assert.equal(uber.provider, "uber_direct");
  assert.equal(uber.provider_name, "Uber Direct");
  assert.equal(uber.quote_id, "dqt_123");
  assert.equal(uber.fee_cents, 1234);
  assert.equal(uber.fee_amount, 12.34);
  assert.equal(uber.fee_formatted, "R$ 12,34");
  assert.equal(uber.currency, "BRL");
  assert.equal(uber.expires_in_minutes, 9);
  assert.equal(uber.estimated_delivery_at, "2026-09-10T16:40:00.000Z");
  assert.equal(uber.delivery_duration_minutes, 30);
  assert.equal(uber.pickup_duration_minutes, 8);
  assert.equal(uber.pickup.name, "Monchou");
  assert.equal(uber.pickup.uses_coordinates, true);
  assert.equal(uber.dropoff.uses_coordinates, false);
  assert.equal(uber.dropoff.deadline_at, "2026-09-10T17:05:00.000Z");
  assert.equal(uber.delivery_requested, false);
});

test("bloco uber tolera cotação sem validade informada", () => {
  const uber = _private.buildUberSummary({
    quote: _private.normalizeQuote({ fee: 990 }),
    payload: {},
    now: new Date("2026-09-10T15:00:00.000Z"),
  });
  assert.equal(uber.expires_in_minutes, null);
  assert.equal(uber.fee_formatted, "R$ 9,90");
});
