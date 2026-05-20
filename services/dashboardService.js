const pool = require("../db");

// Lateral join that resolves the latest status from order_status_history.
// Orders without history are treated as status 1 (AGUARDANDO).
const STATUS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT status FROM order_status_history
    WHERE order_id = o.id
    ORDER BY created_at DESC
    LIMIT 1
  ) ls ON true
`;

// Normalizes status to integer for mixed schemas:
// - legacy text values ('aguardando', 'cancelado', etc.)
// - numeric strings ('1'..'9')
// - integer column values
const STATUS_EXPR = `
  COALESCE(
    CASE
      WHEN ls.status IS NULL THEN NULL
      WHEN ls.status::text ~ '^[0-9]+$' THEN ls.status::int
      WHEN lower(ls.status::text) = 'novo' THEN 1
      WHEN lower(ls.status::text) = 'aguardando' THEN 1
      WHEN lower(ls.status::text) = 'confirmado' THEN 2
      WHEN lower(ls.status::text) IN ('em_preparo', 'preparo') THEN 3
      WHEN lower(ls.status::text) = 'entrega' THEN 4
      WHEN lower(ls.status::text) = 'entregue' THEN 5
      WHEN lower(ls.status::text) = 'cancelado' THEN 6
      WHEN lower(ls.status::text) = 'rejeitado' THEN 7
      WHEN lower(ls.status::text) IN ('pronto', 'pronto_retirada') THEN 8
      WHEN lower(ls.status::text) = 'retirado' THEN 9
      ELSE NULL
    END,
    1
  )
`;
const STATUS_EXPR_LS2 = `
  COALESCE(
    CASE
      WHEN ls2.status IS NULL THEN NULL
      WHEN ls2.status::text ~ '^[0-9]+$' THEN ls2.status::int
      WHEN lower(ls2.status::text) = 'novo' THEN 1
      WHEN lower(ls2.status::text) = 'aguardando' THEN 1
      WHEN lower(ls2.status::text) = 'confirmado' THEN 2
      WHEN lower(ls2.status::text) IN ('em_preparo', 'preparo') THEN 3
      WHEN lower(ls2.status::text) = 'entrega' THEN 4
      WHEN lower(ls2.status::text) = 'entregue' THEN 5
      WHEN lower(ls2.status::text) = 'cancelado' THEN 6
      WHEN lower(ls2.status::text) = 'rejeitado' THEN 7
      WHEN lower(ls2.status::text) IN ('pronto', 'pronto_retirada') THEN 8
      WHEN lower(ls2.status::text) = 'retirado' THEN 9
      ELSE NULL
    END,
    1
  )
`;
const STATUS_EXPR_CHART = `
  COALESCE(
    CASE
      WHEN ls.status IS NULL THEN NULL
      WHEN ls.status::text ~ '^[0-9]+$' THEN ls.status::int
      WHEN lower(ls.status::text) = 'novo' THEN 1
      WHEN lower(ls.status::text) = 'aguardando' THEN 1
      WHEN lower(ls.status::text) = 'confirmado' THEN 2
      WHEN lower(ls.status::text) IN ('em_preparo', 'preparo') THEN 3
      WHEN lower(ls.status::text) = 'entrega' THEN 4
      WHEN lower(ls.status::text) = 'entregue' THEN 5
      WHEN lower(ls.status::text) = 'cancelado' THEN 6
      WHEN lower(ls.status::text) = 'rejeitado' THEN 7
      WHEN lower(ls.status::text) IN ('pronto', 'pronto_retirada') THEN 8
      WHEN lower(ls.status::text) = 'retirado' THEN 9
      ELSE NULL
    END,
    1
  )
`;
const STATUS_LABEL_CASE = `
  CASE ${STATUS_EXPR}
    WHEN 1 THEN 'aguardando'
    WHEN 2 THEN 'confirmado'
    WHEN 3 THEN 'preparo'
    WHEN 4 THEN 'entrega'
    WHEN 5 THEN 'entregue'
    WHEN 6 THEN 'cancelado'
    WHEN 7 THEN 'rejeitado'
    WHEN 8 THEN 'pronto_retirada'
    WHEN 9 THEN 'retirado'
    ELSE 'aguardando'
  END
`;

const getDashboard = async (companyId) => {
  const id = parseInt(companyId);

  const [
    companyResult,
    openingHoursResult,
    todayStatsResult,
    monthStatsResult,
    prevMonthResult,
    operationResult,
    topProductResult,
    worstProductResult,
    productsWithoutSalesResult,
    top5ProductsResult,
    recentOrdersResult,
    clientsTotalResult,
    recurringClientsResult,
    newClientsMonthResult,
    topSpenderResult,
    salesChartResult,
    statusBreakdownResult,
  ] = await Promise.all([
    pool.query(`SELECT * FROM companies WHERE id = $1`, [id]),

    pool.query(
      `SELECT weekday, opens_at, closes_at, is_closed
       FROM company_opening_hours WHERE company_id = $1`,
      [id],
    ),

    pool.query(
      `SELECT
         COUNT(*)::int                              AS orders,
         COALESCE(SUM(o.total), 0)::float           AS revenue,
         COALESCE(AVG(o.total), 0)::float           AS avg_ticket,
         (SELECT COUNT(*)::int FROM clients
            WHERE company_id = $1 AND created_at::date = CURRENT_DATE) AS new_clients
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1
         AND o.created_at::date = CURRENT_DATE
         AND ${STATUS_EXPR} NOT IN (6,7)`,
      [id],
    ),

    pool.query(
      `SELECT
         COUNT(*)::int                              AS orders,
         COALESCE(SUM(o.total), 0)::float           AS revenue,
         COALESCE(AVG(o.total), 0)::float           AS avg_ticket
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1
         AND date_trunc('month', o.created_at) = date_trunc('month', CURRENT_DATE)
         AND ${STATUS_EXPR} NOT IN (6,7)`,
      [id],
    ),

    pool.query(
      `SELECT COALESCE(SUM(o.total), 0)::float AS revenue
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1
         AND date_trunc('month', o.created_at) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
         AND ${STATUS_EXPR} NOT IN (6,7)`,
      [id],
    ),

    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} IN (1,2,3,4,8))::int AS in_progress,
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} IN (5,9))::int          AS completed,
         COUNT(*) FILTER (WHERE ${STATUS_EXPR} IN (6,7))::int        AS cancelled,
         COUNT(*)::int                                                                  AS total
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1`,
      [id],
    ),

    pool.query(
      `SELECT mi.id, mi.name, mi.image_url,
              SUM(oi.quantity)::int        AS quantity_sold,
              SUM(oi.subtotal)::float      AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${STATUS_JOIN}
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.company_id = $1
         AND o.created_at >= NOW() - INTERVAL '30 days'
         AND ${STATUS_EXPR} NOT IN (6,7)
         AND oi.menu_item_id IS NOT NULL
       GROUP BY mi.id
       ORDER BY quantity_sold DESC
       LIMIT 1`,
      [id],
    ),

    pool.query(
      `SELECT mi.id, mi.name, mi.image_url,
              SUM(oi.quantity)::int AS quantity_sold
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${STATUS_JOIN}
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.company_id = $1
         AND o.created_at >= NOW() - INTERVAL '30 days'
         AND ${STATUS_EXPR} NOT IN (6,7)
         AND oi.menu_item_id IS NOT NULL
       GROUP BY mi.id
       HAVING SUM(oi.quantity) > 0
       ORDER BY quantity_sold ASC, mi.id ASC
       LIMIT 1`,
      [id],
    ),

    pool.query(
      `SELECT mi.id, mi.name, mi.image_url
       FROM menu_items mi
       WHERE mi.company_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN LATERAL (
             SELECT status FROM order_status_history
             WHERE order_id = o.id
             ORDER BY created_at DESC
             LIMIT 1
           ) ls2 ON true
           WHERE oi.menu_item_id = mi.id
             AND o.company_id = $1
             AND o.created_at >= NOW() - INTERVAL '30 days'
             AND ${STATUS_EXPR_LS2} NOT IN (6,7)
         )
       ORDER BY mi.id ASC
       LIMIT 6`,
      [id],
    ),

    pool.query(
      `SELECT mi.id, mi.name,
              SUM(oi.quantity)::int    AS quantity,
              SUM(oi.subtotal)::float  AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${STATUS_JOIN}
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.company_id = $1
         AND o.created_at >= NOW() - INTERVAL '30 days'
         AND ${STATUS_EXPR} NOT IN (6,7)
         AND oi.menu_item_id IS NOT NULL
       GROUP BY mi.id
       ORDER BY quantity DESC
       LIMIT 5`,
      [id],
    ),

    pool.query(
      `SELECT o.id,
              ${STATUS_LABEL_CASE}      AS status,
              o.total::float            AS total,
              o.created_at,
              c.name                    AS client_name,
              COALESCE((SELECT SUM(quantity)::int FROM order_items WHERE order_id = o.id), 0) AS items_count
       FROM orders o
       ${STATUS_JOIN}
       JOIN clients c ON c.id = o.client_id
       WHERE o.company_id = $1
       ORDER BY o.created_at DESC
       LIMIT 6`,
      [id],
    ),

    pool.query(`SELECT COUNT(*)::int AS total FROM clients WHERE company_id = $1`, [id]),

    pool.query(
      `SELECT COUNT(*)::int AS recurring
       FROM (
         SELECT o.client_id
         FROM orders o
         ${STATUS_JOIN}
         WHERE o.company_id = $1 AND ${STATUS_EXPR} NOT IN (6,7)
         GROUP BY o.client_id
         HAVING COUNT(*) > 1
       ) sub`,
      [id],
    ),

    pool.query(
      `SELECT COUNT(*)::int AS count
       FROM clients
       WHERE company_id = $1
         AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`,
      [id],
    ),

    pool.query(
      `SELECT c.id, c.name,
              SUM(o.total)::float AS total_spent,
              COUNT(o.id)::int    AS orders_count
       FROM orders o
       ${STATUS_JOIN}
       JOIN clients c ON c.id = o.client_id
       WHERE o.company_id = $1 AND ${STATUS_EXPR} NOT IN (6,7)
       GROUP BY c.id
       ORDER BY total_spent DESC NULLS LAST
       LIMIT 1`,
      [id],
    ),

    pool.query(
      `SELECT
         d::date AS date,
         COALESCE(SUM(o.total), 0)::float AS revenue,
         COUNT(o.id)::int                AS orders_count
       FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, '1 day') d
       LEFT JOIN orders o
              ON o.created_at::date = d::date
             AND o.company_id = $1
       LEFT JOIN LATERAL (
         SELECT status FROM order_status_history
         WHERE order_id = o.id
         ORDER BY created_at DESC
         LIMIT 1
       ) ls ON true
       WHERE o.id IS NULL OR ${STATUS_EXPR_CHART} NOT IN (6,7)
       GROUP BY d::date
       ORDER BY d::date ASC`,
      [id],
    ),

    pool.query(
      `SELECT ${STATUS_LABEL_CASE} AS status, COUNT(*)::int AS count
       FROM orders o
       ${STATUS_JOIN}
       WHERE o.company_id = $1
       GROUP BY ${STATUS_LABEL_CASE}`,
      [id],
    ),
  ]);

  const company = companyResult.rows[0];
  if (!company) return null;

  // ── Compute is_open from opening hours ─────────────────────────────────────
  const now = new Date();
  const weekday = now.getDay(); // 0=Sun..6=Sat
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const currentTime = `${hh}:${mm}:${ss}`;
  const todayHours = openingHoursResult.rows.find((h) => h.weekday === weekday);
  let isOpen = false;
  if (todayHours && !todayHours.is_closed && todayHours.opens_at && todayHours.closes_at) {
    isOpen = currentTime >= todayHours.opens_at && currentTime <= todayHours.closes_at;
  }

  const today = todayStatsResult.rows[0];
  const month = monthStatsResult.rows[0];
  const prevMonth = prevMonthResult.rows[0];
  const operation = operationResult.rows[0];
  const topProduct = topProductResult.rows[0] || null;
  const worstProduct = worstProductResult.rows[0] || null;
  const productsWithoutSales = productsWithoutSalesResult.rows;
  const top5Products = top5ProductsResult.rows;
  const recentOrders = recentOrdersResult.rows;
  const clientsTotal = clientsTotalResult.rows[0].total;
  const recurring = recurringClientsResult.rows[0].recurring;
  const newClientsMonth = newClientsMonthResult.rows[0].count;
  const topSpender = topSpenderResult.rows[0] || null;
  const salesChart = salesChartResult.rows;
  const statusBreakdown = statusBreakdownResult.rows;

  const monthRev = Number(month.revenue) || 0;
  const prevRev = Number(prevMonth.revenue) || 0;
  const growthPct = prevRev > 0 ? ((monthRev - prevRev) / prevRev) * 100 : monthRev > 0 ? 100 : 0;

  const totalOrders = Number(operation.total) || 0;
  const cancellationRate = totalOrders > 0 ? (Number(operation.cancelled) / totalOrders) * 100 : 0;

  // ── Smart insights ─────────────────────────────────────────────────────────
  const insights = [];

  if (growthPct >= 10) {
    insights.push({
      type: "positive",
      icon: "trending_up",
      title: "Crescimento mensal",
      text: `Suas vendas cresceram ${growthPct.toFixed(0)}% em relação ao mês passado.`,
    });
  } else if (growthPct <= -10) {
    insights.push({
      type: "negative",
      icon: "trending_down",
      title: "Queda nas vendas",
      text: `Suas vendas caíram ${Math.abs(growthPct).toFixed(0)}% em relação ao mês passado.`,
    });
  }

  if (topProduct) {
    insights.push({
      type: "info",
      icon: "star",
      title: "Produto destaque",
      text: `${topProduct.name} lidera com ${topProduct.quantity_sold} unidades vendidas em 30 dias.`,
    });
  }

  if (topSpender && Number(topSpender.orders_count) >= 3) {
    insights.push({
      type: "positive",
      icon: "person_premium",
      title: "Cliente VIP",
      text: `${topSpender.name} fez ${topSpender.orders_count} pedidos e gastou ${formatBRL(topSpender.total_spent)}.`,
    });
  }

  const newClientsToday = Number(today.new_clients) || 0;
  if (newClientsToday > 0) {
    insights.push({
      type: "positive",
      icon: "group_add",
      title: "Novos clientes hoje",
      text: `${newClientsToday} ${newClientsToday === 1 ? "novo cliente cadastrado" : "novos clientes cadastrados"} hoje.`,
    });
  }

  if (cancellationRate > 10) {
    insights.push({
      type: "negative",
      icon: "warning",
      title: "Taxa de cancelamento alta",
      text: `${cancellationRate.toFixed(0)}% dos pedidos foram cancelados.`,
    });
  }

  if (productsWithoutSales.length > 0) {
    insights.push({
      type: "info",
      icon: "inventory",
      title: "Produtos parados",
      text: `${productsWithoutSales.length} ${productsWithoutSales.length === 1 ? "produto sem vendas" : "produtos sem vendas"} nos últimos 30 dias.`,
    });
  }

  const todayRev = Number(today.revenue) || 0;
  if (todayRev > 0 && salesChart.length >= 2) {
    const yesterday = salesChart[salesChart.length - 2];
    const yesterdayRev = Number(yesterday.revenue) || 0;
    if (yesterdayRev > 0) {
      const dailyDelta = ((todayRev - yesterdayRev) / yesterdayRev) * 100;
      if (Math.abs(dailyDelta) >= 20) {
        insights.push({
          type: dailyDelta > 0 ? "positive" : "negative",
          icon: dailyDelta > 0 ? "trending_up" : "trending_down",
          title: "Vendas hoje vs ontem",
          text: `As vendas de hoje estão ${Math.abs(dailyDelta).toFixed(0)}% ${dailyDelta > 0 ? "acima" : "abaixo"} de ontem.`,
        });
      }
    }
  }

  return {
    company: { ...company, is_open: isOpen },
    today: {
      orders: Number(today.orders) || 0,
      revenue: todayRev,
      avg_ticket: Number(today.avg_ticket) || 0,
      new_clients: newClientsToday,
    },
    month: {
      orders: Number(month.orders) || 0,
      revenue: monthRev,
      avg_ticket: Number(month.avg_ticket) || 0,
      growth_pct: growthPct,
    },
    operation: {
      in_progress: Number(operation.in_progress) || 0,
      completed: Number(operation.completed) || 0,
      cancelled: Number(operation.cancelled) || 0,
      total: totalOrders,
      cancellation_rate: cancellationRate,
    },
    products: {
      top_seller: topProduct,
      worst_seller: worstProduct,
      without_sales: productsWithoutSales,
      top_5: top5Products,
    },
    recent_orders: recentOrders,
    clients: {
      total: Number(clientsTotal) || 0,
      recurring: Number(recurring) || 0,
      new_month: Number(newClientsMonth) || 0,
      top_spender: topSpender,
    },
    sales_chart: salesChart,
    status_breakdown: statusBreakdown,
    insights,
  };
};

function formatBRL(value) {
  const n = Number(value) || 0;
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

module.exports = { getDashboard };
