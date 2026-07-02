const service = require("../services/deliveriesService");

// Erros de negócio conhecidos → 400/422 com a mensagem amigável do service.
const BUSINESS_ERROR_CODES = new Set([
  "maps_key_missing",
  "directions_failed",
  "company_origin_missing",
  "driver_not_found",
  "orders_not_found",
  "order_without_location",
]);

const getActive = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const data = await service.getActiveDeliveries(companyId);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching active deliveries:", error);
    return res.status(500).json({ error: "Failed to fetch active deliveries" });
  }
};

const createRoute = async (req, res) => {
  const { company_id, driver_id, order_ids } = req.body || {};
  if (!company_id || isNaN(company_id)) return res.status(400).json({ error: "Invalid company_id" });
  if (!driver_id || isNaN(driver_id)) return res.status(400).json({ error: "Selecione um motoboy para a rota." });
  if (!Array.isArray(order_ids) || !order_ids.length) {
    return res.status(400).json({ error: "Selecione ao menos um pedido para a rota." });
  }
  try {
    const route = await service.createRoute({
      company_id: Number(company_id),
      driver_id: Number(driver_id),
      order_ids: order_ids.map(Number).filter((n) => Number.isFinite(n)),
    });
    return res.status(201).json(route);
  } catch (error) {
    if (BUSINESS_ERROR_CODES.has(error.code)) {
      console.warn(`Delivery route business error [${error.code}]:`, error.details || error.message);
      return res.status(422).json({ error: error.message, code: error.code });
    }
    console.error("Error creating delivery route:", error);
    return res.status(500).json({ error: "Não foi possível gerar a rota." });
  }
};

const listRoutes = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) return res.status(400).json({ error: "Invalid company ID" });
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const routes = await service.listRoutes(companyId, { days });
    return res.status(200).json(routes);
  } catch (error) {
    console.error("Error listing delivery routes:", error);
    return res.status(500).json({ error: "Failed to list delivery routes" });
  }
};

module.exports = { getActive, createRoute, listRoutes };
