const pool = require("../db");

// ─── Relatórios/consultas consumidos PELO n8n ─────────────────────────────────
// Diferente de `n8nService.js` (que gerencia workflows no n8n), aqui ficam as
// leituras que o n8n SOLICITA à nossa API para montar mensagens/relatórios.
// Novas requisições do n8n devem ser adicionadas aqui (uma função por payload).

// Rótulos de dia da semana em pt-BR, cobrindo as DUAS convenções usadas no app:
//  • DOW do PostgreSQL (EXTRACT(DOW)): 0=domingo … 6=sábado — usado em sales_average;
//  • company_opening_hours.weekday (portal): 1=segunda … 7=domingo — usado em opening_hours.
// Segunda–sábado (1–6) coincidem nas duas; domingo aparece como 0 (DOW) OU 7 (portal),
// por isso o índice 7 também mapeia para "domingo" (antes vinha null no domingo).
const WEEKDAY_LABELS = [
  "domingo", // 0 (DOW)
  "segunda-feira", // 1
  "terça-feira", // 2
  "quarta-feira", // 3
  "quinta-feira", // 4
  "sexta-feira", // 5
  "sábado", // 6
  "domingo", // 7 (opening_hours: domingo)
];

const weekdayLabel = (dow) => (dow == null ? null : WEEKDAY_LABELS[Number(dow)] ?? null);

// time do Postgres vem como "HH:MM:SS" — reduz para "HH:MM" para exibição.
const toHHMM = (t) => (typeof t === "string" ? t.slice(0, 5) : t);

const toMoney = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Resumo diário de uma empresa para o n8n. Reúne, numa única resposta:
 *  1. data/hora atual da geração (momento da chamada);
 *  2. média de faturamento das últimas 4 semanas no mesmo dia da semana vs. hoje;
 *  3. nome completo do dono;
 *  4. horário de funcionamento (dias + turnos);
 *  5. cardápio com itens ativos e desativados;
 *  6. "ativo desde" (data de cadastro/vínculo da loja).
 *
 * `tz` é a timezone de negócio usada para determinar "hoje" e o dia da semana.
 * Os timestamps em `orders.created_at` são naive (hora local), então comparamos
 * contra o relógio de parede local obtido via `now() AT TIME ZONE tz`.
 *
 * Retorna null quando a empresa não existe.
 */
const getDailySummary = async (companyId, tz = "America/Sao_Paulo") => {
  const id = Number(companyId);

  // Empresa (valida existência).
  const companyRes = await pool.query(
    "SELECT id, name, phone, description FROM companies WHERE id = $1",
    [id],
  );
  const company = companyRes.rows[0];
  if (!company) return null;

  // Dono + "ativo desde". Dono = vínculo com relation_type = 0 (mais antigo em caso
  // de empate). "Ativo desde" = vínculo mais antigo da empresa (a tabela companies
  // não possui created_at próprio).
  const ownerRes = await pool.query(
    `SELECT
       (SELECT u.name
          FROM user_companies uc
          JOIN users u ON u.id = uc.user_id
         WHERE uc.company_id = $1
         ORDER BY (uc.relation_type = 0) DESC, uc.created_at ASC
         LIMIT 1) AS owner_name,
       (SELECT MIN(created_at)
          FROM user_companies
         WHERE company_id = $1) AS active_since`,
    [id],
  );
  const ownerName = ownerRes.rows[0]?.owner_name ?? null;
  const activeSince = ownerRes.rows[0]?.active_since ?? null;

  // Faturamento por dia: hoje (offset 0) + as 4 ocorrências anteriores do mesmo dia
  // da semana (hoje-7, -14, -21, -28). Pedidos cancelados são excluídos.
  const salesRes = await pool.query(
    `WITH ref AS (
       SELECT (now() AT TIME ZONE $2) AS local_now
     ),
     params AS (
       SELECT (local_now)::date AS today,
              EXTRACT(DOW FROM local_now)::int AS dow
       FROM ref
     ),
     target_days AS (
       SELECT today AS d, 0 AS offset_weeks FROM params
       UNION ALL SELECT today - 7,  1 FROM params
       UNION ALL SELECT today - 14, 2 FROM params
       UNION ALL SELECT today - 21, 3 FROM params
       UNION ALL SELECT today - 28, 4 FROM params
     )
     SELECT td.offset_weeks,
            to_char(td.d, 'YYYY-MM-DD') AS date,
            (SELECT dow FROM params) AS dow,
            COALESCE(SUM(o.total), 0) AS revenue,
            COUNT(o.id) AS orders_count
       FROM target_days td
       LEFT JOIN orders o
         ON o.company_id = $1
        AND o.cancelled_at IS NULL
        AND (o.created_at)::date = td.d
      GROUP BY td.offset_weeks, td.d
      ORDER BY td.offset_weeks`,
    [id, tz],
  );

  const rows = salesRes.rows;
  const dow = rows.length ? Number(rows[0].dow) : null;
  const todayRow = rows.find((r) => Number(r.offset_weeks) === 0);
  const previousRows = rows
    .filter((r) => Number(r.offset_weeks) > 0)
    .map((r) => ({
      date: r.date,
      orders_count: Number(r.orders_count),
      revenue: toMoney(r.revenue),
    }));

  const avg = (arr, sel) =>
    arr.length ? arr.reduce((s, x) => s + sel(x), 0) / arr.length : 0;

  // Horário de funcionamento (dias + turnos). Um dia pode ter múltiplos turnos.
  const hoursRes = await pool.query(
    `SELECT weekday, opens_at, closes_at, is_closed
       FROM company_opening_hours
      WHERE company_id = $1
      ORDER BY weekday, opens_at`,
    [id],
  );
  const hoursByWeekday = new Map();
  for (const h of hoursRes.rows) {
    const wd = Number(h.weekday);
    if (!hoursByWeekday.has(wd)) {
      hoursByWeekday.set(wd, {
        weekday: wd,
        weekday_label: weekdayLabel(wd),
        is_closed: h.is_closed === true,
        shifts: [],
      });
    }
    const entry = hoursByWeekday.get(wd);
    if (h.is_closed) entry.is_closed = true;
    else entry.shifts.push({ opens_at: toHHMM(h.opens_at), closes_at: toHHMM(h.closes_at) });
  }
  const openingHours = Array.from(hoursByWeekday.values()).sort((a, b) => a.weekday - b.weekday);

  // Cardápio: todos os itens (ativos e desativados), agrupados por categoria.
  const menuRes = await pool.query(
    `SELECT mc.id AS category_id, mc.name AS category_name,
            mc.active AS category_active, mc.sort_order,
            mi.id, mi.name, mi.description, mi.price, mi.available
       FROM menu_items mi
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.company_id = $1
      ORDER BY mc.sort_order NULLS LAST, mc.id NULLS LAST, mi.display_order NULLS LAST, mi.id`,
    [id],
  );

  const categoriesMap = new Map();
  let activeCount = 0;
  let inactiveCount = 0;
  for (const it of menuRes.rows) {
    const key = it.category_id ?? "sem_categoria";
    if (!categoriesMap.has(key)) {
      categoriesMap.set(key, {
        id: it.category_id ?? null,
        name: it.category_name ?? "Sem categoria",
        active: it.category_id == null ? null : it.category_active,
        items: [],
      });
    }
    const available = it.available === true;
    if (available) activeCount++;
    else inactiveCount++;
    categoriesMap.get(key).items.push({
      id: it.id,
      name: it.name,
      description: it.description,
      price: toMoney(it.price),
      available,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    timezone: tz,
    company: {
      id: company.id,
      name: company.name,
      phone: company.phone,
      owner_name: ownerName,
      active_since: activeSince,
    },
    sales_average: {
      weekday: dow,
      weekday_label: weekdayLabel(dow),
      today: {
        date: todayRow?.date ?? null,
        orders_count: todayRow ? Number(todayRow.orders_count) : 0,
        revenue: todayRow ? toMoney(todayRow.revenue) : 0,
      },
      last_4_same_weekday: {
        average_revenue: toMoney(avg(previousRows, (x) => x.revenue)),
        average_orders: Math.round(avg(previousRows, (x) => x.orders_count) * 100) / 100,
        days: previousRows,
      },
    },
    opening_hours: openingHours,
    menu: {
      active_count: activeCount,
      inactive_count: inactiveCount,
      total_count: activeCount + inactiveCount,
      categories: Array.from(categoriesMap.values()),
    },
  };
};

module.exports = { getDailySummary };
