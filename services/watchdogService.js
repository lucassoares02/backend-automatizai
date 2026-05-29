const cron = require("node-cron");
const connectionsService = require("./connectionsService");
const evolutionService = require("./evolutionService");

const CRON_EXPRESSION = "*/5 * * * *";

const checkInstance = async (connection) => {
  const { instance_name: instanceName } = connection;

  if (!instanceName) {
    console.warn(`[watchdog] connection ${connection.id} sem instance_name, ignorando`);
    return;
  }

  try {
    const state = await evolutionService.testConnection(instanceName);
    const currentState = state?.instance?.state ?? state?.state ?? null;

    if (currentState === "open") {
      if (connection.status !== "open") {
        await connectionsService.updateStatusByInstance(instanceName, "open");
        console.log(`[watchdog] ${instanceName}: estado=open, status atualizado para open`);
      } else {
        console.log(`[watchdog] ${instanceName}: estado=open, ok`);
      }
      return;
    }

    console.warn(`[watchdog] ${instanceName}: estado=${currentState ?? "desconhecido"}, tentando reconectar`);

    try {
      await evolutionService.getQrCode(instanceName);
      await connectionsService.updateStatusByInstance(instanceName, "reconnecting");
      console.log(`[watchdog] ${instanceName}: reconexão disparada, status=reconnecting`);
    } catch (reconnectErr) {
      await connectionsService.updateStatusByInstance(instanceName, "error");
      console.error(`[watchdog] ${instanceName}: falha ao reconectar -> ${reconnectErr.message}`);
    }
  } catch (err) {
    console.error(`[watchdog] ${instanceName}: erro ao consultar estado -> ${err.message}`);
    try {
      await connectionsService.updateStatusByInstance(instanceName, "error");
    } catch (updateErr) {
      console.error(`[watchdog] ${instanceName}: falha ao atualizar status para error -> ${updateErr.message}`);
    }
  }
};

let running = false;

const runOnce = async () => {
  if (running) {
    console.log("[watchdog] execução anterior ainda em andamento, pulando ciclo");
    return;
  }
  running = true;

  const startedAt = Date.now();
  try {
    const connections = await connectionsService.findActive();
    console.log(`[watchdog] iniciando ciclo: ${connections.length} instância(s) ativa(s)`);

    for (const connection of connections) {
      await checkInstance(connection);
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[watchdog] ciclo concluído em ${elapsed}ms`);
  } catch (err) {
    console.error(`[watchdog] erro no ciclo principal -> ${err.message}`);
  } finally {
    running = false;
  }
};

const start = () => {
  if (!process.env.EVOLUTION_API_URL || !process.env.TOKEN_EVOLUTION) {
    console.warn("[watchdog] EVOLUTION_API_URL ou TOKEN_EVOLUTION ausentes, watchdog não iniciado");
    return;
  }

  cron.schedule(CRON_EXPRESSION, runOnce);
  console.log(`[watchdog] agendado com expressão "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce };
