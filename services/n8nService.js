const n8nUrl = process.env.URL_N8N;
const token = process.env.TOKEN_N8N;
const fs = require("fs");

const duplicate = async (instance, company) => {
  const response = await fetch(`${n8nUrl}workflows/sBNtd2jZC8s9YQPO`, {
    headers: {
      "X-N8N-API-KEY": token,
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const workflow = await response.json();

  // export workflow to file json
  // fs.writeFileSync(`./${instance}.json`, JSON.stringify(workflow, null, 2));

  // alterar nodes
  const nodes = replaceCompanyId(workflow.nodes, company);

  const updatedNodes = replaceWebhookId(nodes, instance);

  const newWorkflow = {
    name: instance,
    nodes: updatedNodes,
    connections: workflow.connections,
    settings: {},
  };

  const create = await fetch(`${n8nUrl}workflows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": token,
    },
    body: JSON.stringify(newWorkflow),
  });

  const workflowCreated = await create.json();

  console.log(workflowCreated.id);

  const publish = await fetch(`${n8nUrl}workflows/${workflowCreated.id}/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": token,
    },
  });

  if (!publish.ok) {
    throw new Error(await publish.text());
  }

  return await publish.json();
};

const replaceWebhookId = (nodes, instance) => {
  const oldId = "d5c1216d-4d32-406a-afde-ddc5ca51b40d";
  const otherId = "4f9d86ae-04c0-49ca-a77c-a38f5a345aad";

  // Função recursiva para percorrer objetos e substituir strings
  const traverse = (obj) => {
    if (typeof obj === "string") {
      // Substitui todas as ocorrências (caso apareça mais de uma vez no mesmo campo)
      return obj.replaceAll(oldId, instance).replaceAll(otherId, instance);
    } else if (Array.isArray(obj)) {
      return obj.map((item) => traverse(item));
    } else if (obj && typeof obj === "object") {
      const newObj = {};
      for (const [key, value] of Object.entries(obj)) {
        newObj[key] = traverse(value);
      }
      return newObj;
    }
    return obj;
  };

  return nodes.map((node) => traverse(node));
};

const sanitizeWorkflow = (workflow, instance) => {
  const nodes = workflow.nodes.map((node) => {
    const cleanNode = {
      id: node.id,
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: node.position,
      parameters: node.parameters,
    };

    if (node.credentials) {
      cleanNode.credentials = {};

      for (const key of Object.keys(node.credentials)) {
        cleanNode.credentials[key] = {
          name: node.credentials[key].name,
        };
      }
    }

    return cleanNode;
  });

  return {
    name: instance,
    nodes,
    connections: workflow.connections,
    settings: {}, // obrigatório
  };
};

const replaceCompanyId = (nodes, company) => {
  return nodes.map((node) => {
    if (node.parameters && node.parameters.operation === "executeQuery" && node.parameters.query) {
      node.parameters.query = node.parameters.query.replace(/c\.id\s*=\s*\d+/, `c.id = ${company}`);
    }

    return node;
  });
};

module.exports = { duplicate };
