const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../services/atendimentoUsoService");
const { _testing: ctrl } = require("../controllers/atendimentoUsoController");

const { buildResponse, variationPct, costPer100, todayInSaoPaulo } = service._testing;

test("valida mês no formato YYYY-MM", () => {
  assert.equal(service.isValidMonth("2026-10"), true);
  assert.equal(service.isValidMonth("2026-13"), false);
  assert.equal(service.isValidMonth("2026-1"), false);
  assert.equal(service.isValidMonth("2026-10-01"), false);
});

test("hoje usa o fuso de São Paulo (23h50 BRT ainda é o mesmo dia)", () => {
  // 2026-10-06 23:50 BRT = 2026-10-07 02:50 UTC
  assert.equal(todayInSaoPaulo(new Date("2026-10-07T02:50:00Z")), "2026-10-06");
  assert.equal(service.currentMonth(new Date("2026-11-01T02:50:00Z")), "2026-10");
});

test("variação e custo a cada 100 devolvem null sem base", () => {
  assert.equal(variationPct(10, 0), null);
  assert.equal(variationPct(112.5, 100), 12.5);
  assert.equal(costPer100(1, 0), null);
  assert.equal(costPer100(0.5, 250), 0.2);
});

test("monta o contrato convertendo numeric/bigint e sem campos internos", () => {
  const res = buildResponse({
    month: "2026-10",
    today: "2026-10-06",
    summaryRow: {
      atendimentos: "812",
      clientes_atendidos: "143",
      custo_brl: "1.4632115",
      atendimentos_ant: "0",
      custo_brl_ant: "0",
      ate_dia: "2026-10-06",
    },
    dailyRows: [{ dia: "2026-10-01", atendimentos: "131", custo_brl: "0.2361" }],
    firstMonth: "2026-09",
  });
  assert.equal(res.mes_atual, true);
  assert.equal(res.resumo.atendimentos, 812);
  assert.equal(res.resumo.custo_brl, 1.4632115);
  assert.equal(res.resumo.variacao.atendimentos_pct, null);
  assert.equal(res.resumo.variacao.custo_pct, null);
  assert.deepEqual(res.por_dia, [{ dia: "2026-10-01", atendimentos: 131, custo_brl: 0.2361 }]);
  assert.equal(res.primeiro_mes, "2026-09");
  assert.deepEqual(Object.keys(res).sort(), ["ate_dia", "mes", "mes_atual", "por_dia", "primeiro_mes", "resumo"]);
});

test("mês vazio devolve zeros", () => {
  const res = buildResponse({
    month: "2026-08",
    today: "2026-10-06",
    summaryRow: { atendimentos: "0", clientes_atendidos: "0", custo_brl: "0", atendimentos_ant: "0", custo_brl_ant: "0", ate_dia: "2026-08-31" },
    dailyRows: [],
    firstMonth: null,
  });
  assert.equal(res.mes_atual, false);
  assert.equal(res.resumo.atendimentos, 0);
  assert.equal(res.resumo.custo_por_100_brl, null);
});

test("empresa vem da sessão e não aceita negócio de outra dona", () => {
  assert.equal(ctrl.resolveCompanyId({ query: {}, userCompanies: [25] }), 25);
  assert.equal(ctrl.resolveCompanyId({ query: {}, userCompanies: [25, 30] }), null);
  assert.equal(ctrl.resolveCompanyId({ query: { company_id: "30" }, userCompanies: [25, 30] }), 30);
  assert.equal(ctrl.resolveCompanyId({ query: { company_id: "25" }, userCompanies: [7] }), null);
  assert.equal(ctrl.resolveCompanyId({ query: { company_id: "abc" }, userCompanies: [25] }), null);
});
