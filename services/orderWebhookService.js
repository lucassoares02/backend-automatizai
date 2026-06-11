const pool = require("../db");
const { n8nUrlWebhook } = require("./evolutionService");

const WEBHOOK_PATH = "automatic-update-order";
const FETCH_TIMEOUT_MS = 15000;

// Somente estes status disparam o webhook para o n8n.
const TRIGGER_STATUSES = new Set([2, 4, 6, 7, 8]);

const STATUS_NAMES = {
  2: "Confirmado",
  4: "Saiu para entrega",
  6: "Cancelado",
  7: "Rejeitado",
  8: "Pronto para retirada",
};

const _deliveryTypeLabel = (value) => {
  if (value === true) return "delivery";
  if (value === false) return "pickup";
  return null;
};

const _buildPayload = (order, status, extra) => ({
  order_id: order.id,
  order_code: `PED-${order.id}`,
  status_id: status,
  status_name: STATUS_NAMES[status],
  company: {
    id: order.company_id,
    name: extra.company_name,
  },
  customer: {
    id: order.client_id,
    name: extra.client_name,
    phone: extra.client_phone,
  },
  total: order.total != null ? Number(order.total) : null,
  delivery_type: _deliveryTypeLabel(order.delivery_type),
  created_at: order.created_at,
  updated_at: order.updated_at,
});

/**
 * Notifica o n8n sobre mudança de status de pedido.
 *
 * Chamada a partir de ordersService.updateStatus APÓS o commit — fire-and-forget.
 * Nunca lança: falhas do n8n não podem impactar a atualização do pedido.
 */
const notifyStatusChange = async (order, status) => {
  try {
    if (!order?.id || !TRIGGER_STATUSES.has(Number(status))) return;

    const extraRes = await pool.query(
      `SELECT comp.name AS company_name, cli.name AS client_name, cli.phone AS client_phone
       FROM orders o
       JOIN companies comp ON comp.id = o.company_id
       JOIN clients cli ON cli.id = o.client_id
       WHERE o.id = $1`,
      [order.id],
    );
    const extra = extraRes.rows[0];
    if (!extra) return;

    const payload = _buildPayload(order, Number(status), extra);
    const url = `${n8nUrlWebhook}${WEBHOOK_PATH}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    console.log(
      `Webhook automatic-update-order enviado com sucesso. order=${order.id} status=${status}`,
    );
  } catch (err) {
    console.error(
      `Erro ao enviar webhook automatic-update-order. order=${order?.id} status=${status} erro=${err.message}`,
    );
  }
};

module.exports = { notifyStatusChange, TRIGGER_STATUSES, STATUS_NAMES };
