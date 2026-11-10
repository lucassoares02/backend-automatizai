const service = require("../services/merchantNotificationsService");
const { resolveCompanyId } = require("../src/middlewares/authorize");

const list = async (req, res) => {
  try {
    const limit = Number(req.query?.limit) || 50;
    const unreadOnly = String(req.query?.unread_only || "").toLowerCase() === "true";
    return res.status(200).json(await service.listForCompany(resolveCompanyId(req), { limit, unreadOnly }));
  } catch (error) {
    console.error("merchant-notifications-list", error);
    return res.status(500).json({ error: "Não foi possível carregar as notificações." });
  }
};

const markRead = async (req, res) => {
  try {
    const notification = await service.markRead(req.authorizedCompanyId, req.params.id);
    if (!notification) return res.status(404).json({ error: "Notificação não encontrada." });
    return res.status(200).json(notification);
  } catch (error) {
    console.error("merchant-notifications-mark-read", error);
    return res.status(500).json({ error: "Não foi possível atualizar a notificação." });
  }
};

module.exports = { list, markRead };
