const pool = require("../db");

// Reaproveita a mesma normalização de status do dashboard (esquemas mistos:
// texto legado, string numérica ou inteiro). Resolvido a partir do último
// registro de order_status_history; pedidos sem histórico caem em 1 (AGUARDANDO).
const STATUS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT status FROM order_status_history
    WHERE order_id = o.id
    ORDER BY created_at DESC
    LIMIT 1
  ) ls ON true
`;

// Gera a expressão que normaliza o status para inteiro (1..9) a partir do alias
// do lateral join informado. Evita a duplicação literal usada no dashboard.
const statusExpr = (alias = "ls") => `
  COALESCE(
    CASE
      WHEN ${alias}.status IS NULL THEN NULL
      WHEN ${alias}.status::text ~ '^[0-9]+$' THEN ${alias}.status::int
      WHEN lower(${alias}.status::text) = 'novo' THEN 1
      WHEN lower(${alias}.status::text) = 'aguardando' THEN 1
      WHEN lower(${alias}.status::text) = 'confirmado' THEN 2
      WHEN lower(${alias}.status::text) IN ('em_preparo', 'preparo') THEN 3
      WHEN lower(${alias}.status::text) = 'entrega' THEN 4
      WHEN lower(${alias}.status::text) = 'entregue' THEN 5
      WHEN lower(${alias}.status::text) = 'cancelado' THEN 6
      WHEN lower(${alias}.status::text) = 'rejeitado' THEN 7
      WHEN lower(${alias}.status::text) IN ('pronto', 'pronto_retirada') THEN 8
      WHEN lower(${alias}.status::text) = 'retirado' THEN 9
      ELSE NULL
    END,
    1
  )
`;

const STATUS_EXPR = statusExpr("ls");
const STATUS_EXPR_CHART = statusExpr("lsc");

// Validação simples de data no formato YYYY-MM-DD.
const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s) => typeof s === "string" && _DATE_RE.test(s);

// Teto de pedidos retornados na listagem do relatório (a UI abre o detalhe
// sob demanda; períodos longos podem ter muitos pedidos).
const ORDERS_LIMIT = 500;

/**
 * Relatório operacional de um período [from, to] (datas inclusivas, YYYY-MM-DD).
 * Retorna resumo executivo, séries para gráficos e a lista de pedidos do período.
 */
const getReport = async (companyId, from, to) => {
  const id = parseInt(companyId);

  const [
    companyResult,
    summaryResult,
    newClientsResult,
    salesChartResult,
    statusBreakdownResult,
    topProductsResult,
    ordersResult,
    ordersCountResult,
  ] = await Promise.all([
    pool.query(`SELECT id FROM companies WHERE id = $1`, [id]),

    // Resumo agregado do período.
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} NOT IN (6,7))::int        AS orders,
         COALESCE(SUM(o.total) FILTER (WHERE ${STATUS_EXPR} NOT IN (6,7)), 0)::float AS revenue,
         COALESCE(AVG(o.total) FILTER (WHERE ${STATUS_EXPR} NOT IN (6,7)), 0)::float AS avg_ticket,
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} IN (5,9))::int            AS completed,
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} IN (6,7))::int            AS cancelled,
         COUNT(*)::int                                                   AS total_all,
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} NOT IN (6,7)
                            AND o.delivery_type IS FALSE)::int             AS pickup_count,
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} NOT IN (6,7)
                            AND o.delivery_type IS DISTINCT FROM FALSE)::int AS delivery_count
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1
         AND o.created_at::date BETWEEN $2::date AND $3::date`,
      [id, from, to],
    ),

    // Novos clientes cadastrados no período.
    pool.query(
      `SELECT COUNT(*)::int AS count
       FROM clients
       WHERE company_id = $1
         AND created_at::date BETWEEN $2::date AND $3::date`,
      [id, from, to],
    ),

    // Série diária de faturamento/pedidos (pedidos válidos), com dias zerados.
    pool.query(
      `SELECT
         d::date                             AS date,
         COALESCE(SUM(o.total), 0)::float    AS revenue,
         COUNT(o.id)::int                    AS orders_count
       FROM generate_series($2::date, $3::date, '1 day') d
       LEFT JOIN orders o
              ON o.created_at::date = d::date
             AND o.company_id = $1
       LEFT JOIN LATERAL (
         SELECT status FROM order_status_history
         WHERE order_id = o.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lsc ON true
       WHERE o.id IS NULL OR ${STATUS_EXPR_CHART} NOT IN (6,7)
       GROUP BY d::date
       ORDER BY d::date ASC`,
      [id, from, to],
    ),

    // Distribuição por status (todos os pedidos do período).
    pool.query(
      `SELECT ${STATUS_EXPR} AS status, COUNT(*)::int AS count
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1
         AND o.created_at::date BETWEEN $2::date AND $3::date
       GROUP BY ${STATUS_EXPR}
       ORDER BY count DESC`,
      [id, from, to],
    ),

    // Top 5 produtos por unidades vendidas no período (pedidos válidos).
    pool.query(
      `SELECT mi.id, mi.name,
              SUM(oi.quantity)::int    AS quantity,
              SUM(oi.subtotal)::float  AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${STATUS_JOIN}
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.company_id = $1
         AND o.created_at::date BETWEEN $2::date AND $3::date
         AND ${STATUS_EXPR} NOT IN (6,7)
         AND oi.menu_item_id IS NOT NULL
       GROUP BY mi.id
       ORDER BY quantity DESC
       LIMIT 5`,
      [id, from, to],
    ),

    // Lista de pedidos do período (mais recentes primeiro), inclusive cancelados.
    pool.query(
      `SELECT o.id,
              o.tag,
              ${STATUS_EXPR}            AS status,
              o.total::float            AS total,
              o.created_at,
              CASE WHEN o.delivery_type IS FALSE THEN 'pickup' ELSE 'delivery' END AS delivery_type,
              c.name                    AS client_name,
              COALESCE((SELECT SUM(quantity)::int FROM order_items WHERE order_id = o.id), 0) AS items_count
       FROM orders o
       ${STATUS_JOIN}
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.company_id = $1
         AND o.created_at::date BETWEEN $2::date AND $3::date
       ORDER BY o.created_at DESC
       LIMIT ${ORDERS_LIMIT}`,
      [id, from, to],
    ),

    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM orders o
       WHERE o.company_id = $1
         AND o.created_at::date BETWEEN $2::date AND $3::date`,
      [id, from, to],
    ),
  ]);

  if (!companyResult.rows[0]) return null;

  const s = summaryResult.rows[0];
  const totalAll = Number(s.total_all) || 0;
  const cancelled = Number(s.cancelled) || 0;
  const cancellationRate = totalAll > 0 ? (cancelled / totalAll) * 100 : 0;

  const fromDate = new Date(`${from}T00:00:00`);
  const toDate = new Date(`${to}T00:00:00`);
  const days = Math.round((toDate - fromDate) / 86400000) + 1;

  return {
    range: { from, to, days },
    summary: {
      orders: Number(s.orders) || 0,
      revenue: Number(s.revenue) || 0,
      avg_ticket: Number(s.avg_ticket) || 0,
      completed: Number(s.completed) || 0,
      cancelled,
      cancellation_rate: cancellationRate,
      new_clients: Number(newClientsResult.rows[0].count) || 0,
      delivery_count: Number(s.delivery_count) || 0,
      pickup_count: Number(s.pickup_count) || 0,
    },
    sales_chart: salesChartResult.rows,
    status_breakdown: statusBreakdownResult.rows.map((r) => ({
      status: Number(r.status),
      count: Number(r.count),
    })),
    top_products: topProductsResult.rows,
    orders: ordersResult.rows,
    orders_total: Number(ordersCountResult.rows[0].total) || 0,
    orders_truncated: (Number(ordersCountResult.rows[0].total) || 0) > ORDERS_LIMIT,
  };
};

module.exports = { getReport, isValidDate };
