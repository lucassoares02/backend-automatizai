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

  // alterar nodes
  const nodes = replaceCompanyId(workflow.nodes, company);

  const newWorkflow = {
    name: instance,
    nodes,
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

  if (!create.ok) {
    throw new Error(await create.text());
  }

  return await create.json();
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
