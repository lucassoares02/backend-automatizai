const cron = require("node-cron");
const subscriptionsService = require("./subscriptionsService");

// Assinaturas Pagar.me: retentativas agendadas (2 após a 1ª recusa) e
// conferência das assinaturas abertas com a Pagar.me (cobre webhook perdido).
const CRON_EXPRESSION = process.env.SUBSCRIPTION_RECONCILIATION_CRON || "*/5 * * * *";
let running = false;

const runOnce = async () => {
  if (running) return;
  running = true;
  try {
    const retries = await subscriptionsService.processDueRetries();
    const subscriptions = await subscriptionsService.reconcileOpenSubscriptions();
    if ((!retries.skipped && retries.retried > 0) || (!subscriptions.skipped && subscriptions.checked > 0)) {
      console.info("pagarme.subscriptions_reconciliation", { retries, subscriptions });
    }
  } catch (error) {
    console.error("pagarme: falha na conciliação de assinaturas:", error.message);
  } finally {
    running = false;
  }
};

const start = () => {
  if (!process.env.PAGARME_SECRET_KEY) return;
  cron.schedule(CRON_EXPRESSION, runOnce);
  console.info(`pagarme: conciliação de assinaturas agendada em "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce };
