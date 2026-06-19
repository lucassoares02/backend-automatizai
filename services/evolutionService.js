const evolutionUrl = process.env.EVOLUTION_API_URL;

// Safely build the N8N webhook base URL from the API URL
const _buildN8nWebhookUrl = () => {
  const base = process.env.URL_N8N || "";
  if (base.includes("/api/v1/")) {
    return base.replace("/api/v1/", "/webhook/");
  }
  // Fallback: append /webhook/ to origin
  try {
    const u = new URL(base);
    return `${u.origin}/webhook/`;
  } catch {
    return base;
  }
};
const n8nUrlWebhook = _buildN8nWebhookUrl();

const FETCH_TIMEOUT_MS = 15000;

const _fetcher = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

const _booleanOrDefault = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "sim"].includes(normalized)) return true;
  if (["false", "0", "no", "nao", "não"].includes(normalized)) return false;
  return fallback;
};

const create = async (instanceName, integration, qrcode, settings = {}) => {
  const payload = {
    instanceName,
    integration,
    qrcode,
    rejectCall: _booleanOrDefault(settings.rejectCall, true),
    groupsIgnore: _booleanOrDefault(settings.groupsIgnore, true),
    syncFullHistory: _booleanOrDefault(settings.syncFullHistory, true),
  };

  const response = await _fetcher(`${evolutionUrl}/instance/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Evolution create failed [${response.status}]: ${text}`);
  }
  return JSON.parse(text);
};

const updateInstance = async (instanceName) => {
  const bodyWebSocket = JSON.stringify({
    instanceName,
    websocket: {
      enabled: true,
      events: ["APPLICATION_STARTUP", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    },
  });

  // O webhook da Evolution aponta para a API (não mais direto pro N8N). A API é
  // dona da fila: agrupa/serializa as mensagens e só então encaminha ao N8N.
  const bodyWebHook = JSON.stringify({
    webhook: {
      enabled: true,
      base64: true,
      url: `${process.env.API_BASE_URL}/api/connections/webhook`,
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
    },
  });

  const [wsRes, whRes] = await Promise.all([
    _fetcher(`${evolutionUrl}/websocket/set/${instanceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: process.env.TOKEN_EVOLUTION },
      body: bodyWebSocket,
    }),
    _fetcher(`${evolutionUrl}/webhook/set/${instanceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: process.env.TOKEN_EVOLUTION },
      body: bodyWebHook,
    }),
  ]);

  if (!wsRes.ok) {
    const t = await wsRes.text();
    throw new Error(`Evolution websocket/set failed [${wsRes.status}]: ${t}`);
  }
  if (!whRes.ok) {
    const t = await whRes.text();
    throw new Error(`Evolution webhook/set failed [${whRes.status}]: ${t}`);
  }

  return { message: "success" };
};

const getQrCode = async (instanceName) => {
  const response = await _fetcher(`${evolutionUrl}/instance/connect/${instanceName}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Evolution connect failed [${response.status}]: ${text}`);
  }
  return JSON.parse(text);
};

const testConnection = async (instanceName) => {
  const response = await _fetcher(`${evolutionUrl}/instance/connectionState/${instanceName}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Evolution connectionState failed [${response.status}]: ${text}`);
  }
  return JSON.parse(text);
};

const getInstance = async () => {
  const response = await _fetcher(`${evolutionUrl}/instance/fetchInstances`, {
    method: "GET",
    headers: { "Content-Type": "application/json", apikey: process.env.TOKEN_EVOLUTION },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Evolution fetchInstances failed [${response.status}]: ${text}`);
  }
  return JSON.parse(text);
};

const deleteInstance = async (instanceName) => {
  const response = await _fetcher(`${evolutionUrl}/instance/delete/${instanceName}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", apikey: process.env.TOKEN_EVOLUTION },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Evolution deleteInstance failed [${response.status}]: ${text}`);
  }
  return JSON.parse(text);
};

const forwardToN8n = async (instanceName, body) => {
  const url = `${n8nUrlWebhook}${instanceName}`;
  const res = await _fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`N8N forward failed [${res.status}]: ${t}`);
  }
};

/**
 * Confirma a leitura (read receipt) de uma ou mais mensagens recebidas, chamando
 * direto a Evolution em POST /chat/markMessageAsRead/{instance}. Recebe um array
 * `readMessages` ([{ remoteJid, fromMe, id }]). Lança em caso de falha
 * (HTTP != 2xx); o chamador decide se ignora.
 */
const markMessagesAsRead = async (instanceName, readMessages) => {
  if (!Array.isArray(readMessages) || readMessages.length === 0) return;

  const url = `${evolutionUrl}/chat/markMessageAsRead/${instanceName}`;
  const body = {
    readMessages: readMessages.map((m) => ({
      remoteJid: m.remoteJid,
      fromMe: m.fromMe === true,
      id: m.id,
    })),
  };

  const res = await _fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Evolution markMessageAsRead failed [${res.status}]: ${t}`);
  }
};

module.exports = { create, updateInstance, getQrCode, testConnection, getInstance, deleteInstance, forwardToN8n, markMessagesAsRead, n8nUrlWebhook };
