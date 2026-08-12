const cron = require("node-cron");
const pagarmeService = require("./pagarmeService");

const CRON_EXPRESSION = process.env.PAGARME_RECONCILIATION_CRON || "*/5 * * * *";
let running = false;

const runOnce = async () => {
  if (running) return;
  running = true;
  try {
    const result = await pagarmeService.reconcileOpenPaymentAttempts();
    if (!result.skipped && result.checked > 0) {
      console.info("pagarme.reconciliation", result);
    }
  } catch (error) {
    console.error("pagarme: falha na conciliação:", error.message);
  } finally {
    running = false;
  }
};

const start = () => {
  if (!process.env.PAGARME_SECRET_KEY) return;
  cron.schedule(CRON_EXPRESSION, runOnce);
  console.info(`pagarme: conciliação agendada em "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce };
