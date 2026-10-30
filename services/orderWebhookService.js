const pool = require("../db");
const { n8nUrlWebhook } = require("./evolutionService");
const orderStatusNotificationService = require("./orderStatusNotificationService");
const { tableExists } = require("../helpers/schema");
const slots = require("../helpers/bookingSlots");

const WEBHOOK_PATH = "automatic-update-order";
const NEW_ORDER_WEBHOOK_PATH = "arbian-avisos";
const FETCH_TIMEOUT_MS = 15000;
const STATUS_AWAITING = 1;

// Basic Auth do webhook n8n.
const WEBHOOK_AUTH_USER = process.env.WEBHOOK_N8N_USER;
const WEBHOOK_AUTH_PASS = process.env.WEBHOOK_N8N_PASS;
const WEBHOOK_AUTH_HEADER = `Basic ${Buffer.from(
  `${WEBHOOK_AUTH_USER}:${WEBHOOK_AUTH_PASS}`,
).toString("base64")}`;

// Somente estes status disparam o webhook para o n8n.
const TRIGGER_STATUSES = new Set([2, 4, 6, 7, 8]);

const STATUS_NAMES = {
  2: "Confirmado",
  3: "Em Preparo",
  4: "Saiu para entrega",
  5: "Entregue",
  6: "Cancelado",
  7: "Rejeitado",
  8: "Pronto para retirada",
  9: "Retirado",
};

const _deliveryTypeLabel = (value) => {
  if (value === true) return "delivery";
  if (value === false) return "pickup";
  return null;
};

// Substitui os placeholders da mensagem configurada pelo comerciante.
const _renderMessage = (template, order, status, extra) => {
  if (!template) return "";
  const code =
    extra.tag && String(extra.tag).trim() !== ""
      ? String(extra.tag).trim()
      : `PED-${order.id}`;
  return String(template)
    .replaceAll("{cliente}", extra.client_name ?? "")
    .replaceAll("{pedido}", code)
    .replaceAll("{loja}", extra.company_name ?? "")
    .replaceAll("{status}", STATUS_NAMES[status] ?? "");
};

const _buildPayload = (order, status, extra, message) => ({
  order_id: order.id,
  order_code: `PED-${order.id}`,
  status_id: status,
  status_name: STATUS_NAMES[status],
  message: message ?? null,
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
  tag: extra.tag ?? null,
  created_at: order.created_at,
  updated_at: order.updated_at,
});

// Carrega um retrato completo do pedido no momento da notificação. Usamos os
// JSONs das próprias tabelas para não perder campos adicionados ao pedido no
// futuro, e agregamos os detalhes que vivem nas tabelas filhas.
const _findAwaitingOrderPayload = async (orderId) => {
  const orderResult = await pool.query(
    `SELECT
       to_jsonb(o) AS order,
       to_jsonb(comp) AS company,
       to_jsonb(cli) AS customer,
       to_jsonb(pm) AS payment_method,
       COALESCE((
         SELECT jsonb_agg(
           to_jsonb(oi) || jsonb_build_object(
             'options', COALESCE((
               SELECT jsonb_agg(to_jsonb(oio) ORDER BY oio.id)
               FROM order_item_options oio
               WHERE oio.order_item_id = oi.id
             ), '[]'::jsonb)
           )
           ORDER BY oi.id
         )
         FROM order_items oi
         WHERE oi.order_id = o.id
       ), '[]'::jsonb) AS items,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(osh) ORDER BY osh.created_at, osh.id)
         FROM order_status_history osh
         WHERE osh.order_id = o.id
       ), '[]'::jsonb) AS status_history
     FROM orders o
     JOIN companies comp ON comp.id = o.company_id
     JOIN clients cli ON cli.id = o.client_id AND cli.company_id = o.company_id
     LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
     WHERE o.id = $1
       AND o.status = $2`,
    [orderId, STATUS_AWAITING],
  );
  const row = orderResult.rows[0];
  if (!row) return null;

  // Não enviamos `hash`: ele é um dado de provisionamento da conexão e não é
  // necessário para o fluxo de avisos. Todas as conexões abertas da empresa
  // são retornadas, inclusive quando houver mais de uma simultaneamente.
  const connectionsResult = await pool.query(
    `SELECT id,
            company_id AS "companyId",
            instance_name AS "instanceName",
            instance_id AS "instanceId",
            description,
            integration,
            status,
            ai_enabled AS "aiEnabled",
            created_at AS "createdAt"
       FROM connections
      WHERE company_id = $1
        AND LOWER(TRIM(COALESCE(status, ''))) = 'open'
      ORDER BY id`,
    [row.order.company_id],
  );

  return {
    event: "new_order",
    status: {
      id: STATUS_AWAITING,
      name: "Aguardando",
    },
    order: {
      ...row.order,
      company: row.company,
      customer: row.customer,
      payment_method: row.payment_method,
      items: row.items,
      status_history: row.status_history,
    },
    connections: connectionsResult.rows,
    notified_at: new Date().toISOString(),
  };
};

/**
 * Notifica o fluxo de avisos sobre um pedido que entrou em "Aguardando".
 *
 * Chamar somente depois do commit. O método é best-effort para que uma falha
 * no n8n jamais reverta a criação do pedido ou a confirmação do pagamento.
 */
const notifyAwaitingOrder = async (orderId) => {
  try {
    if (!Number.isInteger(Number(orderId)) || Number(orderId) <= 0) return;

    const payload = await _findAwaitingOrderPayload(Number(orderId));
    if (!payload) return;

    const res = await fetch(`${n8nUrlWebhook}${NEW_ORDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: WEBHOOK_AUTH_HEADER,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    console.log(
      `Webhook arbian-avisos enviado com sucesso. order=${orderId} connections=${payload.connections.length}`,
    );
  } catch (err) {
    console.error(
      `Erro ao enviar webhook arbian-avisos. order=${orderId} erro=${err.message}`,
    );
  }
};

// ─── Pedidos de serviço (agendamento) ────────────────────────────────────────

const APP_URL = (process.env.PUBLIC_APP_URL || process.env.ORIGIN || "").replace(/\/$/, "");
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

// Etapa do pedido → evento de serviço (ids em orderStatusNotificationService).
const SERVICE_EVENT_BY_STATUS = { 2: 102, 3: 103, 5: 109, 9: 109, 6: 106, 7: 106 };
const SERVICE_EVENT_BY_KIND = { rescheduled: 104, reminder_24h: 201, reminder_2h: 202 };

/** "sex, 10/10" e "14:30" no fuso da empresa. */
const formatAppointmentDate = (startsAt, timezone) => {
  const tz = slots.resolveTimezone(timezone);
  const p = slots.zonedParts(startsAt, tz);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return {
    date: `${WEEKDAYS[slots.weekdayOf(date)]}, ${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}`,
    time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
  };
};

const renderServiceMessage = (template, vars) => {
  if (!template) return "";
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value ?? ""),
    String(template),
  );
};

const _loadAppointment = async (orderId) => {
  if (!(await tableExists("appointments"))) return null;
  const res = await pool.query(
    `SELECT a.id, a.status, a.starts_at, a.ends_at, a.professional_id, a.menu_item_id, a.cancel_reason,
            mi.name AS service_name, p.name AS professional_name,
            COALESCE(to_jsonb(comp)->>'timezone', $2) AS timezone
     FROM appointments a
     JOIN companies comp ON comp.id = a.company_id
     LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
     LEFT JOIN professionals p ON p.id = a.professional_id
     WHERE a.order_id = $1
     ORDER BY a.id DESC LIMIT 1`,
    [orderId, slots.DEFAULT_TIMEZONE],
  );
  return res.rows[0] || null;
};

const _postStatusWebhook = async (payload) => {
  const res = await fetch(`${n8nUrlWebhook}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: WEBHOOK_AUTH_HEADER,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
};

/**
 * Envia a notificação de um evento de serviço (confirmação, remarcação,
 * lembrete, pós-atendimento…) pelo mesmo webhook de status. Retorna true se
 * enviou, false se a loja desligou o evento ou não há agendamento. Lança em
 * falha de rede (o chamador decide se registra).
 */
const _sendServiceEvent = async (orderId, eventId, appointment = null) => {
  const ap = appointment || (await _loadAppointment(orderId));
  if (!ap) return false;
  const orderRes = await pool.query(
    `SELECT o.*, comp.name AS company_name, cli.name AS client_name, cli.phone AS client_phone
     FROM orders o
     JOIN companies comp ON comp.id = o.company_id
     JOIN clients cli ON cli.id = o.client_id AND cli.company_id = o.company_id
     WHERE o.id = $1`,
    [orderId],
  );
  const order = orderRes.rows[0];
  if (!order) return false;
  const notif = await orderStatusNotificationService.resolveForStatus(order.company_id, eventId);
  if (!notif.enabled) return false;

  const when = formatAppointmentDate(ap.starts_at, ap.timezone);
  const link = APP_URL && order.uuid ? `${APP_URL}/pedido/${order.uuid}` : "";
  const message = renderServiceMessage(notif.message, {
    cliente: order.client_name,
    loja: order.company_name,
    pedido: order.tag && String(order.tag).trim() ? String(order.tag).trim() : `PED-${order.id}`,
    servico: ap.service_name,
    profissional: ap.professional_name,
    data: when.date,
    hora: when.time,
    link,
    link_avaliacao: link,
    status: orderStatusNotificationService.SERVICE_EVENTS[eventId] ?? "",
  });
  const status = Number(order.status);
  await _postStatusWebhook({
    ..._buildPayload(order, status, order, message),
    status_name: orderStatusNotificationService.SERVICE_EVENTS[eventId] ?? STATUS_NAMES[status],
    event: "appointment",
    notification_id: eventId,
    appointment: {
      id: ap.id,
      status: ap.status,
      starts_at: ap.starts_at,
      ends_at: ap.ends_at,
      service: ap.service_name,
      professional: ap.professional_name,
      date_label: when.date,
      time_label: when.time,
      tracking_url: link || null,
    },
  });
  console.log(`Webhook de agendamento enviado. order=${orderId} evento=${eventId}`);
  return true;
};

/**
 * Evento de agendamento fora da troca de etapa ("rescheduled") — fire-and-forget.
 */
const notifyAppointmentEvent = async (orderId, kind) => {
  try {
    const eventId = SERVICE_EVENT_BY_KIND[kind];
    if (!eventId) return false;
    return await _sendServiceEvent(orderId, eventId);
  } catch (err) {
    console.error(`Erro ao enviar webhook de agendamento. order=${orderId} evento=${kind} erro=${err.message}`);
    return false;
  }
};

/** Lembrete do cron. Lança em falha de envio para o cron poder tentar de novo. */
const sendAppointmentReminder = (orderId, kind) => _sendServiceEvent(orderId, SERVICE_EVENT_BY_KIND[`reminder_${kind}`]);

/**
 * Notifica o n8n sobre mudança de status de pedido.
 *
 * Chamada a partir de ordersService.updateStatus APÓS o commit — fire-and-forget.
 * Nunca lança: falhas do n8n não podem impactar a atualização do pedido.
 * Pedido de serviço usa as mensagens de agendamento (ver SERVICE_EVENT_BY_STATUS);
 * `noShow` troca o cancelamento pela mensagem de "não compareceu".
 */
const notifyStatusChange = async (order, status, { noShow = false } = {}) => {
  try {
    if (!order?.id) return;

    const appointment = await _loadAppointment(order.id);
    if (appointment) {
      const eventId = noShow ? 111 : SERVICE_EVENT_BY_STATUS[Number(status)];
      // Reserva que venceu sem pagamento não vira "agendamento cancelado".
      const expiredHold = eventId === 106 && appointment.cancel_reason === "hold_expired";
      if (eventId && !expiredHold) await _sendServiceEvent(order.id, eventId, appointment);
      return;
    }

    // A empresa decide, por etapa, se a mudança de status notifica o cliente e
    // qual mensagem enviar. Sem linha personalizada, cai nos defaults (que
    // preservam o comportamento histórico de disparar nos status 2,4,6,7,8).
    const notif = await orderStatusNotificationService.resolveForStatus(
      order.company_id,
      Number(status),
    );
    if (!notif.enabled) return;

    const extraRes = await pool.query(
      `SELECT comp.name AS company_name, cli.name AS client_name, cli.phone AS client_phone, o.tag
       FROM orders o
       JOIN companies comp ON comp.id = o.company_id
       JOIN clients cli ON cli.id = o.client_id AND cli.company_id = o.company_id
       WHERE o.id = $1`,
      [order.id],
    );
    const extra = extraRes.rows[0];
    if (!extra) return;

    const message = _renderMessage(notif.message, order, Number(status), extra);
    const payload = _buildPayload(order, Number(status), extra, message);
    const url = `${n8nUrlWebhook}${WEBHOOK_PATH}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: WEBHOOK_AUTH_HEADER,
      },
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

module.exports = {
  notifyStatusChange,
  notifyAwaitingOrder,
  notifyAppointmentEvent,
  sendAppointmentReminder,
  formatAppointmentDate,
  renderServiceMessage,
  TRIGGER_STATUSES,
  STATUS_NAMES,
};
