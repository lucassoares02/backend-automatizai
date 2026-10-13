const cron = require("node-cron");
const pool = require("./../db");
const { resolveOpenStatus } = require("../helpers/openStatus");

// Encerra as exceções manuais de aberto/fechado (companies.manual_open) quando
// o horário de funcionamento vira: loja fechada manualmente volta a seguir o
// horário quando o expediente acaba; aberta manualmente, quando o horário abre.
// Sem isso, a exceção valeria para sempre (o horário deixaria de ser a regra).
const CRON_EXPRESSION = "* * * * *";

let running = false;

const runOnce = async () => {
  if (running) return;
  running = true;
  try {
    const companies = await pool.query(
      "SELECT id, manual_open FROM companies WHERE manual_open IS NOT NULL",
    );
    if (companies.rows.length === 0) return;
    const ids = companies.rows.map((c) => c.id);
    const hoursResult = await pool.query(
      `SELECT company_id, weekday, opens_at, closes_at, is_closed
         FROM company_opening_hours WHERE company_id = ANY($1)`,
      [ids],
    );
    const hoursByCompany = new Map();
    for (const row of hoursResult.rows) {
      if (!hoursByCompany.has(row.company_id)) hoursByCompany.set(row.company_id, []);
      hoursByCompany.get(row.company_id).push(row);
    }
    const now = new Date();
    for (const company of companies.rows) {
      const status = resolveOpenStatus(hoursByCompany.get(company.id) || [], company.manual_open, now);
      if (!status.manual_expired) continue;
      // `AND manual_open = $2`: não desfaz uma exceção nova feita no meio do ciclo.
      await pool.query("UPDATE companies SET manual_open = NULL WHERE id = $1 AND manual_open = $2", [
        company.id,
        company.manual_open,
      ]);
      console.log(`[horario-loja] loja ${company.id} voltou a seguir o horário`);
    }
  } catch (err) {
    console.error(`[horario-loja] erro no ciclo -> ${err.message}`);
  } finally {
    running = false;
  }
};

const start = () => {
  cron.schedule(CRON_EXPRESSION, runOnce);
  console.log(`[horario-loja] agendado com expressão "${CRON_EXPRESSION}"`);
};

module.exports = { start, runOnce };
