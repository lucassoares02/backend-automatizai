const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeServiceFields,
  normalizeImageUrls,
  normalizeIdList,
  normalizeWorkingHours,
  normalizeTimeOff,
} = require("./serviceItem");

test("produto zera os campos de serviço", () => {
  assert.deepEqual(normalizeServiceFields({ item_type: "product", duration_minutes: 30, price_type: "from" }), {
    itemType: "product",
    durationMinutes: null,
    bufferMinutes: 0,
    priceType: "fixed",
  });
  assert.equal(normalizeServiceFields({}).itemType, "product");
});

test("serviço exige duração válida e normaliza intervalo e tipo de preço", () => {
  assert.deepEqual(
    normalizeServiceFields({ item_type: "service", duration_minutes: "45", buffer_minutes: "10", price_type: "from" }),
    { itemType: "service", durationMinutes: 45, bufferMinutes: 10, priceType: "from" },
  );
  assert.equal(normalizeServiceFields({ item_type: "service", duration_minutes: 30, price_type: "x" }).priceType, "fixed");
  assert.throws(() => normalizeServiceFields({ item_type: "service" }), /duração/);
  assert.throws(() => normalizeServiceFields({ item_type: "service", duration_minutes: 2 }), /duração/);
  assert.throws(
    () => normalizeServiceFields({ item_type: "service", duration_minutes: 30, buffer_minutes: 500 }),
    /intervalo/,
  );
});

test("galeria aceita strings ou objetos, mantém ordem e remove duplicadas", () => {
  assert.equal(normalizeImageUrls(undefined), null);
  assert.deepEqual(normalizeImageUrls(["a", { url: " b " }, "a", "", null]), ["a", "b"]);
  assert.throws(() => normalizeImageUrls(Array.from({ length: 13 }, (_, i) => `u${i}`)), /no máximo/);
});

test("lista de ids ignora inválidos e duplicados", () => {
  assert.equal(normalizeIdList("1"), null);
  assert.deepEqual(normalizeIdList([1, "2", 2, -1, "x", 0]), [1, 2]);
});

test("jornada valida horários e rejeita turnos sobrepostos", () => {
  assert.deepEqual(
    normalizeWorkingHours([
      { weekday: 1, start_time: "14:00", end_time: "18:00" },
      { weekday: 1, start_time: "08:00:00", end_time: "12:00" },
    ]),
    [
      { weekday: 1, start_time: "08:00", end_time: "12:00" },
      { weekday: 1, start_time: "14:00", end_time: "18:00" },
    ],
  );
  assert.throws(() => normalizeWorkingHours([{ weekday: 7, start_time: "08:00", end_time: "09:00" }]), /Dia/);
  assert.throws(() => normalizeWorkingHours([{ weekday: 1, start_time: "10:00", end_time: "09:00" }]), /depois/);
  assert.throws(
    () =>
      normalizeWorkingHours([
        { weekday: 2, start_time: "08:00", end_time: "12:00" },
        { weekday: 2, start_time: "11:00", end_time: "13:00" },
      ]),
    /sobrepostos/,
  );
});

test("folga exige fim depois do início", () => {
  const t = normalizeTimeOff({ starts_at: "2026-10-10T10:00:00Z", ends_at: "2026-10-10T12:00:00Z", reason: "  " });
  assert.equal(t.reason, null);
  assert.equal(t.startsAt, "2026-10-10T10:00:00.000Z");
  assert.throws(() => normalizeTimeOff({ starts_at: "2026-10-10T12:00:00Z", ends_at: "2026-10-10T10:00:00Z" }), /depois/);
  assert.throws(() => normalizeTimeOff({}), /Informe/);
});
