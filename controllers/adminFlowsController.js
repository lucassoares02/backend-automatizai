const service = require("../services/flowsAdminService");

/**
 * Atualizar todos os fluxos do n8n a partir do fluxo principal (template).
 * Somente admin do sistema (rota protegida por requireSystemAdminUser).
 *
 * 200 → todos atualizados; 207 → atualização parcial; 409 → já em andamento;
 * 500 → falha geral (ex.: template indisponível, nenhuma conexão alterada).
 */
const updateAll = async (req, res) => {
  try {
    console.log(`[flows] Atualização de todos os fluxos solicitada pelo usuário ${req.user?.id}`);
    const result = await service.updateAll();
    const success = result.failed === 0;
    return res.status(success ? 200 : 207).json({
      success,
      message: success
        ? `${result.updated} fluxo(s) atualizado(s)`
        : `${result.updated} de ${result.total} fluxo(s) atualizado(s); ${result.failed} com erro`,
      data: result,
    });
  } catch (error) {
    if (error.code === "ALREADY_RUNNING") {
      return res.status(409).json({ success: false, error: error.message });
    }
    console.error("Error updating all workflows:", error);
    return res.status(500).json({ success: false, error: "Failed to update workflows", details: error.message });
  }
};

module.exports = { updateAll };
