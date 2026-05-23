const { saveSearchEvent, getTopSearchTerms, getTopClickedProducts, getNoResultsTerms } = require('../services/searchAnalyticsService');

/**
 * POST /api/public/search-analytics
 * Recebe evento de busca do frontend público.
 * Responde 202 imediatamente e processa assincronamente (fire-and-forget no cliente,
 * mas o servidor ainda persiste de forma confiável).
 */
const track = async (req, res) => {
  res.status(202).json({ ok: true });
  try {
    await saveSearchEvent(req.body);
  } catch (err) {
    console.error('search_analytics insert error:', err.message);
  }
};

/**
 * GET /api/search-analytics/top-terms/:companyId
 * Termos mais buscados — para relatório futuro (requer auth).
 */
const topTerms = async (req, res) => {
  try {
    const data = await getTopSearchTerms(req.params.companyId, req.query.limit);
    res.json(data);
  } catch (err) {
    console.error('search_analytics top-terms error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar analytics' });
  }
};

/**
 * GET /api/search-analytics/top-products/:companyId
 * Produtos mais clicados via busca — para relatório futuro (requer auth).
 */
const topProducts = async (req, res) => {
  try {
    const data = await getTopClickedProducts(req.params.companyId, req.query.limit);
    res.json(data);
  } catch (err) {
    console.error('search_analytics top-products error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar analytics' });
  }
};

/**
 * GET /api/search-analytics/no-results/:companyId
 * Buscas sem resultado — oportunidades de produto (requer auth).
 */
const noResults = async (req, res) => {
  try {
    const data = await getNoResultsTerms(req.params.companyId, req.query.limit);
    res.json(data);
  } catch (err) {
    console.error('search_analytics no-results error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar analytics' });
  }
};

module.exports = { track, topTerms, topProducts, noResults };
