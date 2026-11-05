const pool = require("../db");
const { columnExists, tableExists } = require("../helpers/schema");

// Aceite automático de pedidos, configurado por empresa:
//  - auto_accept_paid_orders: pedido já PAGO online (Pagar.me/Stripe) é aceito
//    sozinho assim que o pagamento é confirmado;
//  - auto_accept_cash_orders: pedido em DINHEIRO pode ficar manual, ser aceito
//    ou recusado automaticamente.
// Os demais métodos presenciais (débito/crédito na entrega, PIX manual etc.)
// continuam manuais.
//
// Pedidos de SERVIÇO (com agendamento) seguem outra regra: são aceitos
// automaticamente, a menos que a loja tenha ligado
// companies.booking_requires_approval ("aceitar agendamentos manualmente").

const CASH_MODES = ["manual", "accept", "reject"];
const STATUS_AWAITING = 1;
const STATUS_CONFIRMED = 2;
const STATUS_REJECTED = 7;
const CASH_PAYMENT_TYPE = 4;
const CASH_REJECT_REASON = "Pedido recusado automaticamente: a loja não aceita pagamento em dinheiro no momento.";

const DEFAULT_SETTINGS = Object.freeze({
  auto_accept_paid_orders: false,
  auto_accept_cash_orders: "manual",
});

const _hasColumns = async () =>
  (await columnExists("companies", "auto_accept_paid_orders")) &&
  (await columnExists("companies", "auto_accept_cash_orders"));

const _normalizeCashMode = (value) =>
  CASH_MODES.includes(String(value)) ? String(value) : "manual";

const _isCashPaymentMethod = (type) => {
  const normalized = String(type ?? "").trim().toLowerCase();
  return normalized === String(CASH_PAYMENT_TYPE) || normalized === "cash";
};

const getSettings = async (companyId) => {
  if (!(await _hasColumns())) return { ...DEFAULT_SETTINGS, available: false };
  const r = await pool.query(
    `SELECT auto_accept_paid_orders, auto_accept_cash_orders
       FROM companies
      WHERE id = $1`,
    [companyId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    auto_accept_paid_orders: row.auto_accept_paid_orders === true,
    auto_accept_cash_orders: _normalizeCashMode(row.auto_accept_cash_orders),
    available: true,
  };
};

const updateSettings = async (companyId, data) => {
  if (!(await _hasColumns())) {
    throw Object.assign(
      new Error("O aceite automático ainda não está disponível. Execute a migração pendente."),
      { status: 503 },
    );
  }
  const paid =
    typeof data.auto_accept_paid_orders === "boolean" ? data.auto_accept_paid_orders : null;
  const cash =
    data.auto_accept_cash_orders != null && CASH_MODES.includes(String(data.auto_accept_cash_orders))
      ? String(data.auto_accept_cash_orders)
      : null;
  if (data.auto_accept_cash_orders != null && cash == null) {
    throw Object.assign(new Error("Opção de dinheiro inválida."), { status: 400 });
  }
  await pool.query(
    `UPDATE companies
        SET auto_accept_paid_orders = COALESCE($2, auto_accept_paid_orders),
            auto_accept_cash_orders = COALESCE($3, auto_accept_cash_orders)
      WHERE id = $1`,
    [companyId, paid, cash],
  );
  return getSettings(companyId);
};

// Decide a ação para um pedido em "Aguardando". Função pura para facilitar teste.
const decideAction = (order, settings) => {
  if (!order || !settings) return null;
  if (Number(order.status) !== STATUS_AWAITING) return null;
  // Pedidos agendados sempre exigem confirmação manual da loja.
  if (order.scheduled_for != null) return null;
  const isOnline = ["pagarme", "stripe"].includes(String(order.payment_provider || ""));
  if (isOnline) {
    return order.payment_status === "paid" && settings.auto_accept_paid_orders === true
      ? "accept"
      : null;
  }
  if (_isCashPaymentMethod(order.payment_method_type)) {
    const mode = _normalizeCashMode(settings.auto_accept_cash_orders);
    return mode === "manual" ? null : mode;
  }
  return null;
};

/**
 * Pedido de serviço em "Aguardando": aceita sozinho ("accept"), salvo quando a
 * loja aprova os agendamentos manualmente ("await"). "skip" = fora de
 * "Aguardando"; null = o pedido não é de serviço.
 */
const _serviceAction = async (orderId) => {
  if (!(await tableExists("appointments"))) return null;
  const hasApproval = await columnExists("companies", "booking_requires_approval");
  const r = await pool.query(
    `SELECT o.status, ${hasApproval ? "c.booking_requires_approval" : "FALSE"} AS requires_approval
       FROM orders o
       JOIN companies c ON c.id = o.company_id
      WHERE o.id = $1
        AND EXISTS (SELECT 1 FROM appointments a WHERE a.order_id = o.id)`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row.status) !== STATUS_AWAITING) return "skip";
  return row.requires_approval === true ? "await" : "accept";
};

/**
 * Aplica o aceite/recusa automático a um pedido que acabou de entrar em
 * "Aguardando". Chamar somente depois do commit. Best-effort: nunca lança, para
 * que uma falha aqui não reverta a criação do pedido ou a confirmação do pagamento
 * (o pedido apenas fica aguardando a ação manual da loja).
 */
const applyToOrder = async (orderId) => {
  try {
    if (!Number.isInteger(Number(orderId)) || Number(orderId) <= 0) return null;

    const serviceAction = await _serviceAction(Number(orderId));
    if (serviceAction === "skip") return null;
    if (serviceAction === "await") {
      // Avisa o cliente que o horário está reservado aguardando a loja aceitar.
      require("./orderWebhookService").notifyAppointmentEvent(Number(orderId), "awaiting_approval");
      return null;
    }
    if (serviceAction === "accept") {
      const ordersService = require("./ordersService");
      const updated = await ordersService.updateStatus(Number(orderId), STATUS_CONFIRMED, null, {
        onlyFrom: STATUS_AWAITING,
      });
      if (!updated) return null;
      console.log(`Aceite automático: agendamento do pedido ${orderId} -> accept`);
      return "accept";
    }

    if (!(await _hasColumns())) return null;

    const r = await pool.query(
      `SELECT o.id, o.status, o.payment_status, o.payment_provider, o.scheduled_for,
              pm.type AS payment_method_type,
              c.auto_accept_paid_orders, c.auto_accept_cash_orders,
              COALESCE((to_jsonb(o)->>'delivery_fee_pending_agreement')::boolean, false)
                AS delivery_fee_pending_agreement
         FROM orders o
         JOIN companies c ON c.id = o.company_id
         LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
        WHERE o.id = $1`,
      [Number(orderId)],
    );
    const order = r.rows[0];
    if (!order) return null;

    const action = decideAction(order, order);
    if (!action) return null;
    // Frete "a combinar" exige a loja confirmar o valor antes de avançar a etapa.
    if (action === "accept" && order.delivery_fee_pending_agreement === true) return null;

    // Require tardio: ordersService depende (indiretamente) deste módulo.
    const ordersService = require("./ordersService");
    const updated = action === "accept"
      ? await ordersService.updateStatus(order.id, STATUS_CONFIRMED, null, { onlyFrom: STATUS_AWAITING })
      : await ordersService.updateStatus(order.id, STATUS_REJECTED, CASH_REJECT_REASON, { onlyFrom: STATUS_AWAITING });
    if (!updated) return null;
    console.log(`Aceite automático: pedido ${order.id} -> ${action}`);
    return action;
  } catch (err) {
    console.error(`Erro no aceite automático. order=${orderId} erro=${err.message}`);
    return null;
  }
};

module.exports = {
  CASH_MODES,
  getSettings,
  updateSettings,
  decideAction,
  applyToOrder,
};
