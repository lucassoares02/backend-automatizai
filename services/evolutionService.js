const evolutionUrl = process.env.EVOLUTION_API_URL;

const create = async (instanceName, integration, qrcode) => {
  console.log(instanceName, integration, qrcode);

  const tes = JSON.stringify({
    instanceName: instanceName,
    integration: integration,
    qrcode: qrcode,
  });

  console.log(tes);

  const response = await fetch(`${evolutionUrl}/instance/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
    body: JSON.stringify({
      instanceName: instanceName,
      integration: integration,
      qrcode: qrcode,
    }),
  });

  const text = await response.text();
  console.log("STATUS:", response.status);
  console.log("BODY:", text);

  if (!response.ok) {
    throw new Error(text);
  }

  return JSON.parse(text);
};

const updateInstance = async (instanceName) => {
  const bodyWebSocket = JSON.stringify({
    instanceName: instanceName,
    websocket: {
      enabled: true,
      events: ["APPLICATION_STARTUP", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    },
  });
  const bodyWebHook = JSON.stringify({
    webhook: {
      enabled: true,
      webhookBase64: true,
      url: `${process.env.URL_N8N}/webhook/${instanceName}`,
      events: ["MESSAGES_UPSERT"],
    },
  });

  const responseWebSocket = await fetch(`${evolutionUrl}/websocket/set/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
    body: bodyWebSocket,
  });

  const responseWebHook = await fetch(`${evolutionUrl}/webhook/set/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
    body: bodyWebHook,
  });

  const text = await responseWebHook.text();

  if (!responseWebHook.ok) {
    throw new Error(text);
  }

  return JSON.parse('{"message": "success"}');
};

const getInstance = async () => {
  const response = await fetch(`${evolutionUrl}/instance/fetchInstances`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
  });

  const text = await response.text();
  console.log("STATUS:", response.status);
  console.log("BODY:", text);

  if (!response.ok) {
    throw new Error(text);
  }

  return JSON.parse(text);
};

const deleteInstance = async (instanceName) => {
  const response = await fetch(`${evolutionUrl}/instance/delete/${instanceName}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.TOKEN_EVOLUTION,
    },
  });

  const text = await response.text();
  console.log("STATUS:", response.status);
  console.log("BODY:", text);

  if (!response.ok) {
    throw new Error(text);
  }

  return JSON.parse(text);
};

module.exports = { create, updateInstance, getInstance, deleteInstance };
