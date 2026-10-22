// Ficha técnica do produto: normalização da entrada e cálculo de custos.
// Funções puras (sem banco) — o portal espelha as mesmas contas em
// portal/lib/features/technical_sheet/technical_sheet_calculator.dart.

// Unidades aceitas. `factor` converte para a unidade base da dimensão
// (g, ml ou un); só se converte dentro da mesma dimensão.
const UNITS = {
  g: { dim: "mass", factor: 1 },
  kg: { dim: "mass", factor: 1000 },
  ml: { dim: "volume", factor: 1 },
  l: { dim: "volume", factor: 1000 },
  un: { dim: "unit", factor: 1 },
  dz: { dim: "unit", factor: 12 },
};

const YIELD_UNITS = ["porcao", "unidade", "fatia", "kg", "l"];
const MAX_INGREDIENTS = 100;
const DEFAULT_TARGET_CMV = 30;

// Erro de validação: o controller devolve 400 com a mensagem.
const _invalid = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

const _num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const _text = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

const _round = (v, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
};

const unitsCompatible = (a, b) => Boolean(UNITS[a] && UNITS[b] && UNITS[a].dim === UNITS[b].dim);

/**
 * Valida e normaliza o corpo do PUT. Lança erro com `status = 400` e
 * mensagem em PT-BR quando algo está inválido.
 */
const normalizeSheet = (input = {}) => {
  const yieldQuantity = _num(input.yield_quantity) ?? 1;
  if (yieldQuantity <= 0) throw _invalid("O rendimento precisa ser maior que zero");

  const yieldUnit = YIELD_UNITS.includes(input.yield_unit) ? input.yield_unit : "porcao";

  const portionSize = _num(input.portion_size);
  if (portionSize !== null && portionSize < 0) throw _invalid("O tamanho da porção não pode ser negativo");
  const portionUnit = portionSize !== null && UNITS[input.portion_unit] ? input.portion_unit : null;

  const money = (v, label) => {
    const n = _num(v) ?? 0;
    if (n < 0) throw _invalid(`${label} não pode ser negativo`);
    return _round(n, 2);
  };

  const targetCmv = _num(input.target_cmv_percent) ?? DEFAULT_TARGET_CMV;
  if (targetCmv <= 0 || targetCmv >= 100) throw _invalid("O CMV alvo precisa estar entre 1% e 99%");

  const shelfLife = _num(input.shelf_life_days);
  if (shelfLife !== null && (!Number.isInteger(shelfLife) || shelfLife < 0 || shelfLife > 3650)) {
    throw _invalid("Validade inválida (use dias inteiros, até 3650)");
  }

  const rawIngredients = Array.isArray(input.ingredients) ? input.ingredients : [];
  if (rawIngredients.length > MAX_INGREDIENTS) {
    throw _invalid(`A ficha técnica aceita até ${MAX_INGREDIENTS} matérias-primas`);
  }

  const ingredients = rawIngredients.map((raw, index) => {
    const row = index + 1;
    const name = _text(raw?.name, 120);
    if (!name) throw _invalid(`Informe o nome da matéria-prima na linha ${row}`);

    const purchaseQuantity = _num(raw.purchase_quantity);
    if (purchaseQuantity === null || purchaseQuantity <= 0) {
      throw _invalid(`Quantidade comprada inválida em "${name}"`);
    }
    const purchasePrice = _num(raw.purchase_price);
    if (purchasePrice === null || purchasePrice < 0) throw _invalid(`Valor pago inválido em "${name}"`);
    const recipeQuantity = _num(raw.recipe_quantity);
    if (recipeQuantity === null || recipeQuantity < 0) {
      throw _invalid(`Quantidade na receita inválida em "${name}"`);
    }

    const purchaseUnit = raw.purchase_unit;
    const recipeUnit = raw.recipe_unit;
    if (!UNITS[purchaseUnit]) throw _invalid(`Unidade de compra inválida em "${name}"`);
    if (!UNITS[recipeUnit]) throw _invalid(`Unidade da receita inválida em "${name}"`);
    if (!unitsCompatible(purchaseUnit, recipeUnit)) {
      throw _invalid(`Unidades incompatíveis em "${name}" (${purchaseUnit} → ${recipeUnit})`);
    }

    const loss = _num(raw.loss_percent) ?? 0;
    if (loss < 0 || loss >= 100) throw _invalid(`Perda inválida em "${name}" (0 a 99%)`);

    return {
      position: index,
      name,
      brand: _text(raw.brand, 120),
      purchase_quantity: purchaseQuantity,
      purchase_unit: purchaseUnit,
      purchase_price: _round(purchasePrice, 2),
      recipe_quantity: recipeQuantity,
      recipe_unit: recipeUnit,
      loss_percent: _round(loss, 2),
    };
  });

  return {
    yield_quantity: yieldQuantity,
    yield_unit: yieldUnit,
    portion_size: portionSize,
    portion_unit: portionUnit,
    packaging_cost: money(input.packaging_cost, "O custo de embalagem"),
    other_costs: money(input.other_costs, "Outros custos"),
    target_cmv_percent: _round(targetCmv, 2),
    preparation_method: _text(input.preparation_method, 10000),
    storage_instructions: _text(input.storage_instructions, 2000),
    shelf_life_days: shelfLife,
    ingredients,
  };
};

/**
 * Custo de uma matéria-prima na receita:
 *   preço por unidade base × quantidade usada (base) ÷ (1 − perda)
 * A perda (limpeza, cocção, aparas) aumenta a quantidade bruta necessária.
 */
const ingredientCost = (ing) => {
  const pu = UNITS[ing.purchase_unit];
  const ru = UNITS[ing.recipe_unit];
  const purchaseQty = Number(ing.purchase_quantity);
  if (!pu || !ru || pu.dim !== ru.dim || !(purchaseQty > 0)) return 0;
  const pricePerBase = Number(ing.purchase_price || 0) / (purchaseQty * pu.factor);
  const usedBase = Number(ing.recipe_quantity || 0) * ru.factor;
  const loss = Math.min(Math.max(Number(ing.loss_percent || 0), 0), 99);
  return (pricePerBase * usedBase) / (1 - loss / 100);
};

/** Resumo de custos da ficha, usando o preço de venda atual do produto. */
const computeCosts = (sheet, salePrice) => {
  const yieldQty = Number(sheet.yield_quantity) > 0 ? Number(sheet.yield_quantity) : 1;
  const ingredients = (sheet.ingredients || []).map((ing) => {
    const cost = ingredientCost(ing);
    return { cost: _round(cost, 4), portion_cost: _round(cost / yieldQty, 4) };
  });
  const ingredientsCost = ingredients.reduce((sum, i) => sum + i.cost, 0);
  const extras = Number(sheet.packaging_cost || 0) + Number(sheet.other_costs || 0);
  const totalCost = ingredientsCost + extras;
  const portionCost = totalCost / yieldQty;

  const price = Number(salePrice);
  const hasPrice = Number.isFinite(price) && price > 0;
  const targetCmv = Number(sheet.target_cmv_percent) || DEFAULT_TARGET_CMV;

  return {
    ingredients,
    ingredients_cost: _round(ingredientsCost, 2),
    extra_costs: _round(extras, 2),
    total_cost: _round(totalCost, 2),
    portion_cost: _round(portionCost, 2),
    sale_price: hasPrice ? _round(price, 2) : null,
    cmv_percent: hasPrice ? _round((portionCost / price) * 100, 2) : null,
    gross_margin: hasPrice ? _round(price - portionCost, 2) : null,
    markup: hasPrice && portionCost > 0 ? _round(price / portionCost, 2) : null,
    suggested_price: portionCost > 0 ? _round(portionCost / (targetCmv / 100), 2) : null,
  };
};

module.exports = { UNITS, YIELD_UNITS, MAX_INGREDIENTS, unitsCompatible, normalizeSheet, ingredientCost, computeCosts };
