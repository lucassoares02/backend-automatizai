const uberDirectService = require("../services/uberDirectService");

const quoteOrderDelivery = async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "ID do pedido inválido." });
  }

  try {
    const result = await uberDirectService.createDeliveryQuote(orderId);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Uber Direct quote error:", error.code || error.message);
    return res.status(error.status || 500).json({
      error: error.message || "Não foi possível cotar a entrega.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

module.exports = { quoteOrderDelivery };
