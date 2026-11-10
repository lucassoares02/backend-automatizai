const pool = require("../db");
const { n8nUrlWebhook } = require("./evolutionService");
const orderStatusNotificationService = require("./orderStatusNotificationService");
const { tableExists } = require("../helpers/schema");
const slots = require("../helpers/bookingSlots");

const WEBHOOK_PATH = "automatic-update-order";
const NEW_ORDER_WEBHOOK_PATH = "arbian-avisos";
const SUBSCRIPTION_NOTIFICATION_WEBHOOK_PATH = "subscription-notification";
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
    .replaceAll("{status}", STATUS_NAMES[status] ?? "")
    .replaceAll("{motivo}", String(order.cancel_reason ?? "").trim());
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
  // Motivo informado ao cancelar/recusar (pode ser vazio).
  cancel_reason: [6, 7].includes(Number(status)) ? String(order.cancel_reason ?? "").trim() || null : null,
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
const SERVICE_EVENT_BY_STATUS = { 2: 102, 3: 103, 5: 109, 9: 109, 6: 106, 7: 107 };
const SERVICE_EVENT_BY_KIND = {
  awaiting_approval: 101,
  rescheduled: 104,
  reminder_24h: 201,
  reminder_2h: 202,
};

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
  return Object.entries(vars)
    .reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value ?? ""), String(template))
    // Variável vazia (ex.: {motivo} sem motivo) não deixa espaço duplo.
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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

const _cancelledAppointmentsSuffix = (n) => (n
  ? `; ${n} agendamento${n === 1 ? " marcado depois do período pago foi cancelado" : "s marcados depois do período pago foram cancelados"}`
  : "");

const SUBSCRIPTION_CUSTOMER_MESSAGES = {
  payment_declined: ({ itemName, failedAttempts }) =>
    `Não conseguimos aprovar a cobrança da sua assinatura de ${itemName}. Confira os dados do cartão para evitar a pausa do serviço${failedAttempts ? ` (tentativa ${failedAttempts})` : ""}.`,
  paused: ({ itemName, cancelledAppointments }) =>
    `Sua assinatura de ${itemName} foi pausada após cobranças recusadas. Atualize o cartão para retomar${cancelledAppointments ? `; ${cancelledAppointments} agendamento${cancelledAppointments === 1 ? " foi" : "s foram"} cancelado${cancelledAppointments === 1 ? "" : "s"} automaticamente` : ""}.`,
  payment_declined_paused: ({ itemName }) =>
    `Não conseguimos aprovar a cobrança pendente da sua assinatura de ${itemName}, que continua pausada. Confira os dados do cartão ou cadastre outro para retomar.`,
  first_payment_failed: ({ itemName }) =>
    `Não conseguimos aprovar a primeira cobrança da sua assinatura de ${itemName}, então a contratação não foi concluída e nada foi cobrado. Você pode assinar de novo com outro cartão.`,
  resumed: ({ itemName }) => `Sua assinatura de ${itemName} foi retomada após a confirmação da cobrança.`,
  canceled: ({ itemName, canceledBy, cancelledAppointments }) =>
    `Sua assinatura de ${itemName} foi cancelada${canceledBy === "chargeback" ? " após a contestação do pagamento" : ""}${_cancelledAppointmentsSuffix(cancelledAppointments)}.`,
  ended: ({ itemName, cancelledAppointments }) =>
    `Sua assinatura de ${itemName} foi encerrada ao fim do prazo contratado${_cancelledAppointmentsSuffix(cancelledAppointments)}.`,
};

/**
 * Envia avisos de cobrança/estado da assinatura para o cliente pelo webhook
 * dedicado do n8n. Chamar após o commit; erros são registrados e não propagados.
 */
const notifySubscriptionCustomer = async (subscriptionId, notificationId, details = {}) => {
  try {
    if (!Number.isInteger(Number(subscriptionId)) || Number(subscriptionId) <= 0) return false;
    const messageBuilder = SUBSCRIPTION_CUSTOMER_MESSAGES[notificationId];
    if (!messageBuilder) return false;

    const result = await pool.query(
      `SELECT cs.id, cs.company_id, cs.menu_item_id, cs.user_id, cs.client_id, cs.status,
              cs.amount_cents, cs.interval, cs.current_cycle_end, cs.items,
              comp.name AS company_name, cli.name AS client_name, cli.phone AS client_phone,
              (SELECT ui.value_norm FROM user_identifiers ui
                WHERE ui.user_id = cs.user_id AND ui.type = 'phone' AND ui.revoked_at IS NULL
                ORDER BY ui.verified_at DESC NULLS LAST, ui.id DESC LIMIT 1) AS account_phone,
              pu.name AS account_name,
              COALESCE(latest_invoice.failed_attempts, 0) AS failed_attempts
         FROM customer_subscriptions cs
         JOIN companies comp ON comp.id = cs.company_id
         LEFT JOIN clients cli ON cli.id = cs.client_id AND cli.company_id = cs.company_id
         LEFT JOIN platform_users pu ON pu.id = cs.user_id
         LEFT JOIN LATERAL (
           SELECT failed_attempts FROM subscription_invoices
            WHERE subscription_id = cs.id ORDER BY created_at DESC, id DESC LIMIT 1
         ) latest_invoice ON true
        WHERE cs.id = $1`,
      [Number(subscriptionId)],
    );
    const sub = result.rows[0];
    const customerPhone = String(sub?.client_phone || sub?.account_phone || "").trim();
    if (!sub || !customerPhone) return false;

    const itemName = sub.items?.[0]?.name || "assinatura";
    const message = messageBuilder({
      itemName,
      failedAttempts: Number(details.failedAttempts ?? sub.failed_attempts) || 0,
      cancelledAppointments: Number(details.cancelledAppointments) || 0,
      canceledBy: details.canceledBy,
    });
    const payload = {
      event: "subscription_notification",
      notification_id: notificationId,
      company: { id: sub.company_id, name: sub.company_name },
      customer: {
        id: sub.client_id,
        user_id: sub.user_id,
        name: sub.client_name || sub.account_name,
        phone: customerPhone,
      },
      subscription: {
        id: Number(sub.id),
        status: sub.status,
        menu_item_id: sub.menu_item_id,
        item_name: itemName,
        amount: Number(sub.amount_cents) / 100,
        interval: sub.interval,
        next_due_at: sub.current_cycle_end,
        failed_attempts: Number(details.failedAttempts ?? sub.failed_attempts) || 0,
      },
      message,
      notified_at: new Date().toISOString(),
    };
    const response = await fetch(`${n8nUrlWebhook}${SUBSCRIPTION_NOTIFICATION_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: WEBHOOK_AUTH_HEADER },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    console.log(`Webhook subscription-notification enviado. subscription=${sub.id} evento=${notificationId}`);
    return true;
  } catch (err) {
    console.error(`Erro ao avisar cliente sobre assinatura. subscription=${subscriptionId} evento=${notificationId} erro=${err.message}`);
    return false;
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
    motivo: [106, 107].includes(eventId) ? String(order.cancel_reason ?? "").trim() : "",
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

/**
 * Aviso à LOJA (fluxo "arbian-avisos", evento próprio): a assinatura do
 * cliente pausou por pagamento recusado e os agendamentos do ciclo não pago
 * foram cancelados. O fluxo do n8n só trata `new_order` hoje — este evento
 * precisa de um ramo novo lá (ignorado com segurança até existir).
 * Fire-and-forget: nunca lança.
 */
const notifySubscriptionAppointmentsCancelled = async (subscription, appointments, { reason = "paused" } = {}) => {
  try {
    if (!subscription?.company_id || !appointments?.length) return;
    const infoRes = await pool.query(
      `SELECT to_jsonb(comp) AS company, mi.name AS service_name, pu.name AS customer_name
         FROM companies comp
         LEFT JOIN menu_items mi ON mi.id = $2
         LEFT JOIN platform_users pu ON pu.id = $3
        WHERE comp.id = $1`,
      [subscription.company_id, subscription.menu_item_id, subscription.user_id],
    );
    const info = infoRes.rows[0];
    if (!info) return;
    const connectionsResult = await pool.query(
      `SELECT id, instance_name AS "instanceName", status
         FROM connections
        WHERE company_id = $1 AND LOWER(TRIM(COALESCE(status, ''))) = 'open'
        ORDER BY id`,
      [subscription.company_id],
    );
    const timezone = info.company?.timezone;
    const when = appointments.map((a) => {
      const f = formatAppointmentDate(a.starts_at, timezone);
      return `${f.date} às ${f.time}`;
    });
    const serviceName = info.service_name || "Assinatura";
    const customerName = info.customer_name || "um cliente";
    const head = reason === "closed"
      ? `⚠️ *Assinatura encerrada*\n\n` +
        `A assinatura *${serviceName}* de ${customerName} foi ${subscription.status === "ended" ? "encerrada" : "cancelada"}. `
      : `⚠️ *Assinatura pausada*\n\n` +
        `O pagamento da assinatura *${serviceName}* de ${customerName} foi recusado. `;
    const text = head +
      `${appointments.length === 1 ? "O agendamento" : "Os agendamentos"} de ${when.join(", ")} ` +
      `${appointments.length === 1 ? "foi cancelado" : "foram cancelados"} e o cliente foi avisado.`;
    const res = await fetch(`${n8nUrlWebhook}${NEW_ORDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: WEBHOOK_AUTH_HEADER },
      body: JSON.stringify({
        event: "subscription_appointments_cancelled",
        reason,
        company: info.company,
        subscription: {
          id: Number(subscription.id),
          status: subscription.status,
          service_name: info.service_name,
          customer_name: info.customer_name,
        },
        appointments: appointments.map((a) => ({ id: a.id, order_id: a.order_id, starts_at: a.starts_at })),
        text,
        connections: connectionsResult.rows,
        notified_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error(`Erro ao avisar a loja sobre agendamentos cancelados da assinatura. subscription=${subscription?.id} erro=${err.message}`);
  }
};

module.exports = {
  notifySubscriptionCustomer,
  notifySubscriptionAppointmentsCancelled,
  notifyStatusChange,
  notifyAwaitingOrder,
  notifyAppointmentEvent,
  sendAppointmentReminder,
  formatAppointmentDate,
  renderServiceMessage,
  TRIGGER_STATUSES,
  STATUS_NAMES,
};
