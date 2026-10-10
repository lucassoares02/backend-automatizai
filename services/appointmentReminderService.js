const cron = require("node-cron");
const pool = require("../db");
const orderWebhookService = require("./orderWebhookService");
const { columnExists, tableExists } = require("../helpers/schema");
const { REMINDERS, dueReminder } = require("../helpers/appointmentMetrics");

// A cada 5 min envia os lembretes de agendamento (24h e 2h antes) pelo n8n.
// Dedup por appointments.reminder_*_sent_at: a linha é "reivindicada" com um
// UPDATE condicional ANTES do envio — duas instâncias da API nunca mandam o
// mesmo lembrete. Se o envio falhar, a marca é desfeita para tentar de novo.
const CRON_EXPRESSION = "*/5 * * * *";
let running = false;

const _hasReminderSchema = async () => {
  if (!(await tableExists("appointments"))) return false;
  const cols = await Promise.all(REMINDERS.map((r) => columnExists("appointments", r.column)));
  return cols.every(Boolean);
};

const _claim = async (appointmentId, column) => {
  const res = await pool.query(
    `UPDATE appointments SET ${column} = NOW() WHERE id = $1 AND ${column} IS NULL RETURNING id`,
    [appointmentId],
  );
  return res.rowCount > 0;
};

const runOnce = async (now = new Date()) => {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    if (!(await _hasReminderSchema())) return 0;
    const maxHours = Math.max(...REMINDERS.map((r) => r.hours));
    // Candidatos: confirmados, ainda não começaram e dentro da maior janela.
    const res = await pool.query(
      `SELECT a.id, a.order_id, a.starts_at, a.created_at,
              ${REMINDERS.map((r) => `a.${r.column}`).join(", ")}
       FROM appointments a
       JOIN orders o ON o.id = a.order_id
       WHERE a.status = 'confirmed'
         AND o.status::text NOT IN ('6', '7')
         AND a.starts_at > $1
         AND a.starts_at <= $1::timestamptz + make_interval(hours => $2)
         AND (${REMINDERS.map((r) => `a.${r.column} IS NULL`).join(" OR ")})
       ORDER BY a.starts_at
       LIMIT 200`,
      [now, maxHours],
    );
    for (const row of res.rows) {
      const sentMap = Object.fromEntries(REMINDERS.map((r) => [r.kind, row[r.column] != null]));
      const due = dueReminder({ startsAt: row.starts_at, createdAt: row.created_at, sent: sentMap }, now);
      if (!due) continue;
      // Lembretes que venceram juntos (cron parado): só o mais próximo sai.
      for (const kind of due.skip) {
        const skipped = REMINDERS.find((r) => r.kind === kind);
        await _claim(row.id, skipped.column);
      }
      if (!(await _claim(row.id, due.column))) continue;
      try {
        if (await orderWebhookService.sendAppointmentReminder(row.order_id, due.kind)) sent++;
      } catch (err) {
        await pool.query(`UPDATE appointments SET ${due.column} = NULL WHERE id = $1`, [row.id]);
        console.error(`[lembretes] falha ao enviar lembrete ${due.kind} do pedido ${row.order_id}:`, err.message);
      }
    }
    if (sent > 0) console.log(`[lembretes] ${sent} lembrete(s) de agendamento enviado(s)`);
  } catch (err) {
    console.error("[lembretes] erro no ciclo:", err.message);
  } finally {
    running = false;
  }
  return sent;
};

const start = () => {
  cron.schedule(CRON_EXPRESSION, () => runOnce());
  console.log(`[lembretes] agendador de lembretes iniciado com expressão "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce };
