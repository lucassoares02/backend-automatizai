const svc = require("../services/orderMessagesService");

const publicList = async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "phone required" });

    const allowed = await svc.verifyOrderPhone(orderId, phone);
    if (!allowed) return res.status(403).json({ error: "forbidden" });

    const messages = await svc.listMessages(orderId);
    res.json(messages);
  } catch (err) {
    console.error("publicList messages:", err);
    res.status(500).json({ error: err.message });
  }
};

const publicSend = async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { phone, message, sender_name } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
    if (message.length > 2000) return res.status(400).json({ error: "message too long" });

    const allowed = await svc.verifyOrderPhone(orderId, phone);
    if (!allowed) return res.status(403).json({ error: "forbidden" });

    const companyId = await svc.getOrderCompanyId(orderId);
    if (!companyId) return res.status(404).json({ error: "order not found" });

    const msg = await svc.sendCustomerMessage(orderId, companyId, sender_name || "Cliente", message);
    res.status(201).json(msg);
  } catch (err) {
    console.error("publicSend message:", err);
    res.status(500).json({ error: err.message });
  }
};

const adminList = async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const messages = await svc.listMessages(orderId);
    res.json(messages);
  } catch (err) {
    console.error("adminList messages:", err);
    res.status(500).json({ error: err.message });
  }
};

const adminSend = async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { message, sender_name } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    if (message.length > 2000) return res.status(400).json({ error: "message too long" });

    const companyId = await svc.getOrderCompanyId(orderId);
    if (!companyId) return res.status(404).json({ error: "order not found" });

    const msg = await svc.sendCompanyMessage(orderId, companyId, sender_name || "Empresa", message);
    res.status(201).json(msg);
  } catch (err) {
    console.error("adminSend message:", err);
    res.status(500).json({ error: err.message });
  }
};

const markRead = async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const companyId = await svc.getOrderCompanyId(orderId);
    if (!companyId) return res.status(404).json({ error: "order not found" });

    await svc.markAsRead(orderId, companyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("markRead messages:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { publicList, publicSend, adminList, adminSend, markRead };
