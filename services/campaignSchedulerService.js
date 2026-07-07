const cron = require("node-cron");
const campaignsService = require("./campaignsService");

// A cada 5 min verifica campanhas programadas cuja data/janela já venceu.
const CRON_EXPRESSION = "*/5 * * * *";

let running = false;

const runOnce = async () => {
  if (running) {
    console.log("[campaigns] ciclo anterior em andamento, pulando");
    return;
  }
  running = true;
  try {
    const due = await campaignsService.findDueCampaigns();
    if (due.length > 0) {
      console.log(`[campaigns] ${due.length} campanha(s) a disparar`);
      for (const c of due) {
        try {
          await campaignsService.dispatchCampaign(c.id);
        } catch (err) {
          console.error(`[campaigns] falha ao disparar id=${c.id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[campaigns] erro no ciclo principal -> ${err.message}`);
  } finally {
    running = false;
  }
};

const start = () => {
  cron.schedule(CRON_EXPRESSION, runOnce);
  console.log(`[campaigns] agendador iniciado com expressão "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce };
