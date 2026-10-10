const cron = require("node-cron");
const bookingService = require("./bookingService");

// A cada minuto libera reservas de horário (appointments 'hold') cujo pagamento
// online não foi confirmado a tempo e cancela o pedido pendente correspondente.
const CRON_EXPRESSION = "* * * * *";
let running = false;

const runOnce = async () => {
  if (running) return;
  running = true;
  try {
    const released = await bookingService.releaseExpiredHolds();
    if (released > 0) console.log(`[agendamentos] ${released} reserva(s) vencida(s) liberada(s)`);
  } catch (err) {
    console.error("[agendamentos] falha ao liberar reservas vencidas:", err.message);
  } finally {
    running = false;
  }
};

const start = () => {
  cron.schedule(CRON_EXPRESSION, runOnce);
};

module.exports = { start, runOnce };
