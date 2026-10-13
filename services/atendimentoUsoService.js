const pool = require("../db");

// Uso e custo do atendimento do Arbian no WhatsApp, por negócio e por mês.
// Fonte: view v_uso_atendimento_turno (uma linha por execução do fluxo, somando
// as linhas por agente de ai_usage_turns). Ver DB_CHANGES_NEEDED.md.
//
// Todas as datas são tratadas no fuso de São Paulo; o banco guarda UTC.

const TZ = "America/Sao_Paulo";

const _MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isValidMonth = (s) => typeof s === "string" && _MONTH_RE.test(s);

// Data de hoje (YYYY-MM-DD) no fuso de São Paulo.
const todayInSaoPaulo = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

const currentMonth = (now = new Date()) => todayInSaoPaulo(now).slice(0, 7);

// (atual − anterior) ÷ anterior × 100; anterior zero → null.
const variationPct = (current, previous) => {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
};

// custo ÷ atendimentos × 100; zero atendimentos → null.
const costPer100 = (cost, count) => (count ? (cost / count) * 100 : null);

// Resumo do mês + mesmo período do mês anterior. Sempre devolve uma linha.
const SUMMARY_SQL = `
WITH p AS (
  SELECT
    $1::bigint AS company_id,
    $2::date AS mes_ini,
    ($2::date + interval '1 month')::date AS mes_fim,
    ($2::date - interval '1 month')::date AS ant_ini,
    LEAST((now() AT TIME ZONE '${TZ}')::date + 1,
          ($2::date + interval '1 month')::date) AS ate
),
t AS (
  SELECT v.execution_id, v.session_id, v.custo_brl,
         (v.criado_em AT TIME ZONE '${TZ}')::date AS dia
  FROM v_uso_atendimento_turno v, p
  WHERE v.company_id = p.company_id
    AND v.criado_em >= (p.ant_ini::timestamp AT TIME ZONE '${TZ}')
    AND v.criado_em <  (p.mes_fim::timestamp AT TIME ZONE '${TZ}')
)
SELECT
  count(t.execution_id) FILTER (WHERE t.dia >= p.mes_ini)                 AS atendimentos,
  count(DISTINCT t.session_id) FILTER (WHERE t.dia >= p.mes_ini)         AS clientes_atendidos,
  COALESCE(sum(t.custo_brl) FILTER (WHERE t.dia >= p.mes_ini), 0)        AS custo_brl,
  count(t.execution_id) FILTER (WHERE t.dia >= p.ant_ini
                                  AND t.dia <  p.mes_ini
                                  AND t.dia <  p.ant_ini + (p.ate - p.mes_ini)) AS atendimentos_ant,
  COALESCE(sum(t.custo_brl) FILTER (WHERE t.dia >= p.ant_ini
                                  AND t.dia <  p.mes_ini
                                  AND t.dia <  p.ant_ini + (p.ate - p.mes_ini)), 0) AS custo_brl_ant,
  to_char(p.ate - 1, 'YYYY-MM-DD') AS ate_dia
FROM p
LEFT JOIN t ON true
GROUP BY p.mes_ini, p.ant_ini, p.ate`;

// Atendimentos por dia do mês (até hoje no mês atual), sem buracos.
const DAILY_SQL = `
WITH p AS (
  SELECT
    $1::bigint AS company_id,
    $2::date AS mes_ini,
    ($2::date + interval '1 month')::date AS mes_fim
),
dias AS (
  SELECT generate_series(
           p.mes_ini,
           LEAST(p.mes_fim - 1, (now() AT TIME ZONE '${TZ}')::date),
           interval '1 day')::date AS dia
  FROM p
),
t AS (
  SELECT (v.criado_em AT TIME ZONE '${TZ}')::date AS dia, v.custo_brl
  FROM v_uso_atendimento_turno v, p
  WHERE v.company_id = p.company_id
    AND v.criado_em >= (p.mes_ini::timestamp AT TIME ZONE '${TZ}')
    AND v.criado_em <  (p.mes_fim::timestamp AT TIME ZONE '${TZ}')
)
SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia,
       count(t.dia) AS atendimentos,
       COALESCE(sum(t.custo_brl), 0) AS custo_brl
FROM dias d
LEFT JOIN t ON t.dia = d.dia
GROUP BY d.dia
ORDER BY d.dia`;

// Primeiro mês com atendimento registrado (alimenta o seletor de mês).
const FIRST_MONTH_SQL = `
SELECT to_char(min(created_at) AT TIME ZONE '${TZ}', 'YYYY-MM') AS primeiro_mes
FROM ai_usage_turns
WHERE company_id = $1`;

// Monta a resposta do contrato a partir das linhas cruas do banco. Só os
// campos do contrato saem daqui (nada de session_id/execution_id/modelo).
const buildResponse = ({ month, today, summaryRow, dailyRows, firstMonth }) => {
  const s = summaryRow || {};
  const atendimentos = Number(s.atendimentos) || 0;
  const custo = Number(s.custo_brl) || 0;
  const atendimentosAnt = Number(s.atendimentos_ant) || 0;
  const custoAnt = Number(s.custo_brl_ant) || 0;

  return {
    mes: month,
    mes_atual: month === today.slice(0, 7),
    ate_dia: s.ate_dia || null,
    resumo: {
      atendimentos,
      clientes_atendidos: Number(s.clientes_atendidos) || 0,
      custo_brl: custo,
      custo_por_100_brl: costPer100(custo, atendimentos),
      variacao: {
        atendimentos_pct: variationPct(atendimentos, atendimentosAnt),
        custo_pct: variationPct(custo, custoAnt),
      },
    },
    por_dia: (dailyRows || []).map((r) => ({
      dia: r.dia,
      atendimentos: Number(r.atendimentos) || 0,
      custo_brl: Number(r.custo_brl) || 0,
    })),
    primeiro_mes: firstMonth || null,
  };
};

// Dados brutos (só admin do sistema): as linhas de ai_usage_turns do mês, com
// todas as colunas, para conferir tokens e custo por etapa. As colunas não são
// fixadas aqui de propósito: o que existir na tabela aparece na tela.
const RAW_LIMIT = 5000;

const RAW_RANGE = `
  company_id = $1
  AND created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}')
  AND created_at <  (($2::date + interval '1 month')::timestamp AT TIME ZONE '${TZ}')`;

const RAW_ROWS_SQL = `
SELECT * FROM ai_usage_turns
WHERE ${RAW_RANGE}
ORDER BY created_at DESC
LIMIT ${RAW_LIMIT}`;

// Totais do mês inteiro (não só das linhas devolvidas) de toda coluna numérica
// de tokens ou custo, sem depender do nome exato das colunas.
const RAW_TOTALS_SQL = `
SELECT kv.key AS coluna, sum((kv.value #>> '{}')::numeric) AS total
FROM ai_usage_turns t, jsonb_each(to_jsonb(t)) kv
WHERE ${RAW_RANGE.replace(/company_id/g, "t.company_id").replace(/created_at/g, "t.created_at")}
  AND jsonb_typeof(kv.value) = 'number'
  AND kv.key ~* '(token|cost|custo)'
GROUP BY kv.key
ORDER BY kv.key`;

const RAW_COUNT_SQL = `SELECT count(*) AS total FROM ai_usage_turns WHERE ${RAW_RANGE}`;

const buildRawResponse = ({ month, rows, totalRows, totals }) => {
  const list = rows || [];
  return {
    mes: month,
    total_linhas: Number(totalRows) || 0,
    limite: RAW_LIMIT,
    colunas: list.length ? Object.keys(list[0]) : [],
    totais: Object.fromEntries(
      (totals || []).map((r) => [r.coluna, Number(r.total) || 0])
    ),
    linhas: list,
  };
};

const getRawUsage = async (companyId, month) => {
  const id = parseInt(companyId, 10);
  const params = [id, `${month}-01`];

  const [rowsResult, countResult, totalsResult] = await Promise.all([
    pool.query(RAW_ROWS_SQL, params),
    pool.query(RAW_COUNT_SQL, params),
    pool.query(RAW_TOTALS_SQL, params),
  ]);

  return buildRawResponse({
    month,
    rows: rowsResult.rows,
    totalRows: countResult.rows[0]?.total,
    totals: totalsResult.rows,
  });
};

/**
 * Uso do atendimento de um negócio no mês `month` (YYYY-MM).
 */
const getUsage = async (companyId, month) => {
  const id = parseInt(companyId, 10);
  const monthStart = `${month}-01`;

  const [summaryResult, dailyResult, firstResult] = await Promise.all([
    pool.query(SUMMARY_SQL, [id, monthStart]),
    pool.query(DAILY_SQL, [id, monthStart]),
    pool.query(FIRST_MONTH_SQL, [id]),
  ]);

  return buildResponse({
    month,
    today: todayInSaoPaulo(),
    summaryRow: summaryResult.rows[0],
    dailyRows: dailyResult.rows,
    firstMonth: firstResult.rows[0]?.primeiro_mes,
  });
};

module.exports = {
  getUsage,
  getRawUsage,
  isValidMonth,
  currentMonth,
  _testing: { buildResponse, buildRawResponse, variationPct, costPer100, todayInSaoPaulo },
};
