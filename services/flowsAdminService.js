const pool = require("../db");
const n8n = require("./n8nService");

/**
 * Atualização em massa dos fluxos do n8n (somente admin do sistema).
 *
 * O "fluxo principal" é o workflow template do n8n (n8nService.TEMPLATE_WORKFLOW_ID),
 * o mesmo usado em Conexões → "Atualizar fluxo". Cada conexão tem um workflow
 * próprio, nomeado pelo `instance_name`, que é recriado a partir do template
 * com o id da empresa reaplicado. Nada é gravado no banco: o vínculo
 * workflow ↔ empresa continua sendo o `instance_name`.
 */

// Todas as conexões com workflow (uma por instância), com o nome da empresa
// para o relatório de retorno.
const listConnections = async () => {
  const result = await pool.query(
    `SELECT c.id,
            c.company_id,
            c.instance_name,
            co.name AS company_name
     FROM connections c
     LEFT JOIN companies co ON co.id = c.company_id
     WHERE c.instance_name IS NOT NULL
       AND c.company_id IS NOT NULL
     ORDER BY c.company_id, c.id`,
  );
  return result.rows;
};

// Trava em memória: evita duas execuções simultâneas recriando os mesmos
// workflows (conflito de webhooks no n8n).
let running = false;

const isRunning = () => running;

/**
 * Recria o workflow de cada conexão a partir do fluxo principal.
 * Sequencial de propósito: o n8n precisa liberar o webhook antigo antes do
 * create, e rodar em paralelo sobrecarregaria a instância.
 *
 * Falha em uma conexão não interrompe as demais; o retorno lista cada uma.
 * `deps` existe para os testes.
 */
const updateAll = async (deps = {}) => {
  const { list = listConnections, fetchTemplate = n8n.fetchTemplate, update = n8n.update } = deps;

  if (running) {
    const err = new Error("Atualização de fluxos já em andamento");
    err.code = "ALREADY_RUNNING";
    throw err;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const connections = await list();
    // Busca o template uma vez; se falhar, nenhuma conexão é tocada.
    const template = connections.length > 0 ? await fetchTemplate() : null;

    const results = [];
    for (const conn of connections) {
      const base = {
        connection_id: conn.id,
        company_id: conn.company_id,
        company_name: conn.company_name ?? null,
        instance_name: conn.instance_name,
      };
      try {
        await update(conn.instance_name, conn.company_id, template);
        results.push({ ...base, success: true });
      } catch (error) {
        console.error(`[flows] Falha ao atualizar fluxo '${conn.instance_name}':`, error.message);
        results.push({ ...base, success: false, error: error.message });
      }
    }

    const updated = results.filter((r) => r.success).length;
    return {
      total: results.length,
      updated,
      failed: results.length - updated,
      duration_ms: Date.now() - startedAt,
      results,
    };
  } finally {
    running = false;
  }
};

module.exports = { updateAll, isRunning, listConnections };
