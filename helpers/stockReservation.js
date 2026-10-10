// Controle de estoque dos pedidos públicos (sacola e produtos levados junto
// com um agendamento): checagem do schema e reserva atômica dentro da transação.
// A devolução no cancelamento fica em ordersService.updateStatus
// (orders.stock_reserved + stock_reservation_items).

const { columnExists } = require("./schema");

const hasStockControlSchema = async () => {
  const [unlimited, quantity, threshold, reserved, reservationItems] = await Promise.all([
    columnExists("menu_items", "stock_unlimited"),
    columnExists("menu_items", "stock_quantity"),
    columnExists("menu_items", "low_stock_threshold"),
    columnExists("orders", "stock_reserved"),
    columnExists("orders", "stock_reservation_items"),
  ]);
  return unlimited && quantity && threshold && reserved && reservationItems;
};

const reserveStock = async (client, companyId, requirements) => {
  for (const [menuItemId, quantity] of requirements) {
    const reserved = await client.query(
      `UPDATE menu_items
       SET stock_quantity = CASE
         WHEN COALESCE(stock_unlimited, true) THEN stock_quantity
         ELSE stock_quantity - $3
       END
       WHERE id = $1
         AND company_id = $2
         AND available = true
         AND deleted_at IS NULL
         AND (
           COALESCE(stock_unlimited, true)
           OR COALESCE(stock_quantity, 0) >= $3
         )
       RETURNING id, name, stock_unlimited, stock_quantity, low_stock_threshold`,
      [menuItemId, companyId, quantity],
    );
    if (reserved.rows[0]) continue;

    const product = await client.query(
      `SELECT name
       FROM menu_items
       WHERE id = $1 AND company_id = $2
       LIMIT 1`,
      [menuItemId, companyId],
    );
    const name = product.rows[0]?.name;
    throw Object.assign(
      new Error(
        name
          ? `"${name}" não possui unidades suficientes para este pedido.`
          : "Um produto do carrinho não está mais disponível.",
      ),
      { status: 409, code: "STOCK_UNAVAILABLE" },
    );
  }
};

module.exports = { hasStockControlSchema, reserveStock };
