const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSheet, ingredientCost, computeCosts, unitsCompatible } = require("../helpers/technicalSheet");

const farinha = {
  name: "Farinha de trigo",
  brand: "Dona Benta",
  purchase_quantity: 1,
  purchase_unit: "kg",
  purchase_price: 6,
  recipe_quantity: 500,
  recipe_unit: "g",
};

test("converte unidades dentro da mesma dimensão", () => {
  // R$ 6/kg → 500 g custam R$ 3
  assert.equal(ingredientCost(farinha), 3);
  // R$ 24 a dúzia → 3 un custam R$ 6
  assert.equal(
    ingredientCost({ purchase_quantity: 1, purchase_unit: "dz", purchase_price: 24, recipe_quantity: 3, recipe_unit: "un" }),
    6,
  );
  assert.equal(unitsCompatible("l", "ml"), true);
  assert.equal(unitsCompatible("kg", "ml"), false);
});

test("perda aumenta a quantidade bruta usada", () => {
  // 20% de perda: 500 g líquidos pedem 625 g brutos → R$ 3,75
  assert.equal(ingredientCost({ ...farinha, loss_percent: 20 }), 3.75);
});

test("custo por porção, CMV, margem e preço sugerido", () => {
  const sheet = normalizeSheet({
    yield_quantity: 4,
    packaging_cost: 1,
    other_costs: 0,
    target_cmv_percent: 25,
    ingredients: [farinha, { ...farinha, name: "Queijo", purchase_price: 40, recipe_quantity: 200 }],
  });
  // 3 + 8 + 1 = 12 → 3 por porção
  const costs = computeCosts(sheet, 10);
  assert.equal(costs.ingredients_cost, 11);
  assert.equal(costs.total_cost, 12);
  assert.equal(costs.portion_cost, 3);
  assert.equal(costs.cmv_percent, 30);
  assert.equal(costs.gross_margin, 7);
  assert.equal(costs.suggested_price, 12);
  assert.equal(costs.ingredients[1].portion_cost, 2);
});

test("sem preço de venda não calcula CMV nem margem", () => {
  const costs = computeCosts(normalizeSheet({ ingredients: [farinha] }), null);
  assert.equal(costs.cmv_percent, null);
  assert.equal(costs.gross_margin, null);
  assert.equal(costs.suggested_price, 10); // CMV alvo padrão de 30%
});

test("normaliza textos, aceita vírgula e aplica padrões", () => {
  const sheet = normalizeSheet({
    yield_quantity: "2,5",
    preparation_method: "  Misture tudo  ",
    ingredients: [{ ...farinha, brand: "  ", purchase_price: "6,50" }],
  });
  assert.equal(sheet.yield_quantity, 2.5);
  assert.equal(sheet.yield_unit, "porcao");
  assert.equal(sheet.target_cmv_percent, 30);
  assert.equal(sheet.preparation_method, "Misture tudo");
  assert.equal(sheet.ingredients[0].brand, null);
  assert.equal(sheet.ingredients[0].purchase_price, 6.5);
  assert.equal(sheet.ingredients[0].position, 0);
});

test("rejeita dados inválidos com status 400", () => {
  const cases = [
    { yield_quantity: 0 },
    { target_cmv_percent: 100 },
    { ingredients: [{ ...farinha, name: " " }] },
    { ingredients: [{ ...farinha, purchase_quantity: 0 }] },
    { ingredients: [{ ...farinha, recipe_unit: "ml" }] },
    { ingredients: [{ ...farinha, purchase_unit: "xícara" }] },
    { ingredients: [{ ...farinha, loss_percent: 100 }] },
    { shelf_life_days: 1.5 },
  ];
  for (const input of cases) {
    assert.throws(() => normalizeSheet(input), (err) => err.status === 400, JSON.stringify(input));
  }
});
