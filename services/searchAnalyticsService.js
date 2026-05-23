const pool = require('../db');

const VALID_EVENTS = new Set([
  'search_completed',
  'product_clicked_from_search',
  'search_closed',
  'no_results_search',
]);

/**
 * Persiste um evento de analytics de busca.
 * Valida e sanitiza todos os campos antes de inserir.
 * Retorna silenciosamente se o payload for inválido.
 */
const saveSearchEvent = async (payload) => {
  if (!payload || typeof payload !== 'object') return;

  const {
    company_id,
    session_id,
    search_term,
    event_type,
    clicked_product_id,
    clicked_product_name,
    clicked_category,
    results_count,
    had_results,
    device_type,
  } = payload;

  if (!company_id || !session_id || !search_term || !event_type) return;
  if (!VALID_EVENTS.has(event_type)) return;

  const term = String(search_term).trim();
  if (term.length < 2 || term.length > 255) return;

  const companyIdInt = parseInt(company_id);
  if (!companyIdInt || companyIdInt <= 0) return;

  await pool.query(
    `INSERT INTO search_analytics
       (company_id, session_id, search_term, event_type,
        clicked_product_id, clicked_product_name, clicked_category,
        results_count, had_results, device_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      companyIdInt,
      String(session_id).slice(0, 64),
      term.slice(0, 255),
      event_type,
      clicked_product_id ? parseInt(clicked_product_id) || null : null,
      clicked_product_name ? String(clicked_product_name).slice(0, 255) : null,
      clicked_category ? String(clicked_category).slice(0, 255) : null,
      parseInt(results_count) || 0,
      had_results !== false,
      device_type ? String(device_type).slice(0, 50) : 'web',
    ],
  );
};

/**
 * Retorna os termos mais buscados de uma empresa (top N).
 * Pronto para uso futuro em telas de relatório.
 */
const getTopSearchTerms = async (companyId, limit = 20) => {
  const res = await pool.query(
    `SELECT search_term,
            COUNT(*) AS total,
            SUM(CASE WHEN had_results THEN 0 ELSE 1 END) AS no_results_count,
            SUM(CASE WHEN event_type = 'product_clicked_from_search' THEN 1 ELSE 0 END) AS click_count
     FROM search_analytics
     WHERE company_id = $1
     GROUP BY search_term
     ORDER BY total DESC
     LIMIT $2`,
    [parseInt(companyId), parseInt(limit)],
  );
  return res.rows;
};

/**
 * Retorna produtos mais clicados a partir de buscas.
 */
const getTopClickedProducts = async (companyId, limit = 20) => {
  const res = await pool.query(
    `SELECT clicked_product_id,
            clicked_product_name,
            COUNT(*) AS click_count,
            COUNT(DISTINCT session_id) AS unique_sessions
     FROM search_analytics
     WHERE company_id = $1
       AND event_type = 'product_clicked_from_search'
       AND clicked_product_id IS NOT NULL
     GROUP BY clicked_product_id, clicked_product_name
     ORDER BY click_count DESC
     LIMIT $2`,
    [parseInt(companyId), parseInt(limit)],
  );
  return res.rows;
};

/**
 * Retorna buscas sem resultado — oportunidades de produto a criar.
 */
const getNoResultsTerms = async (companyId, limit = 20) => {
  const res = await pool.query(
    `SELECT search_term, COUNT(*) AS total
     FROM search_analytics
     WHERE company_id = $1
       AND event_type = 'no_results_search'
     GROUP BY search_term
     ORDER BY total DESC
     LIMIT $2`,
    [parseInt(companyId), parseInt(limit)],
  );
  return res.rows;
};

module.exports = {
  saveSearchEvent,
  getTopSearchTerms,
  getTopClickedProducts,
  getNoResultsTerms,
};
