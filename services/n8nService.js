const n8nUrl = process.env.URL_N8N;
const token = process.env.TOKEN_N8N;

const _headers = {
  "Content-Type": "application/json",
  "X-N8N-API-KEY": token,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find an N8N workflow by exact name. Returns the workflow object or null.
 */
const findWorkflowByName = async (name) => {
  // N8N v1 API supports ?name= filter
  const url = `${n8nUrl}workflows?name=${encodeURIComponent(name)}&limit=10`;
  const res = await fetch(url, { headers: _headers });
  if (!res.ok) return null;
  const body = await res.json();
  const list = body?.data ?? body; // v1 wraps in { data: [...] }
  if (!Array.isArray(list)) return null;
  return list.find((w) => w.name === name) ?? null;
};

/**
 * Deactivate an N8N workflow (frees its webhooks).
 */
const deactivateWorkflow = async (id) => {
  const res = await fetch(`${n8nUrl}workflows/${id}/deactivate`, {
    method: "POST",
    headers: _headers,
  });
  // 200 or 404 are both acceptable here
  return res.ok || res.status === 404;
};

/**
 * Delete an N8N workflow by id.
 */
const deleteWorkflow = async (id) => {
  const res = await fetch(`${n8nUrl}workflows/${id}`, {
    method: "DELETE",
    headers: _headers,
  });
  return res.ok || res.status === 404;
};

// ─── Main export ──────────────────────────────────────────────────────────────

const duplicate = async (instance, company) => {
  // 1. Fetch the template workflow
  const templateRes = await fetch(`${n8nUrl}workflows/sBNtd2jZC8s9YQPO`, {
    headers: _headers,
  });
  if (!templateRes.ok) {
    throw new Error(`N8N template fetch failed [${templateRes.status}]: ${await templateRes.text()}`);
  }
  const workflow = await templateRes.json();

  // 2. Adapt nodes for this instance/company
  const updatedNodes = replaceWebhookId(replaceCompanyId(workflow.nodes, company), instance);

  const newWorkflow = {
    name: instance,
    nodes: updatedNodes,
    connections: workflow.connections,
    settings: {},
  };

  // 3. Remove any existing workflow with the same name to avoid webhook conflicts
  const existing = await findWorkflowByName(instance);
  if (existing) {
    console.log(`[n8n] Removing existing workflow '${instance}' (id=${existing.id}) before recreate`);
    await deactivateWorkflow(existing.id);
    await deleteWorkflow(existing.id);
  }

  // 4. Create the new workflow
  const createRes = await fetch(`${n8nUrl}workflows`, {
    method: "POST",
    headers: _headers,
    body: JSON.stringify(newWorkflow),
  });
  if (!createRes.ok) {
    throw new Error(`N8N workflow create failed [${createRes.status}]: ${await createRes.text()}`);
  }
  const workflowCreated = await createRes.json();

  // 5. Activate it
  const activateRes = await fetch(`${n8nUrl}workflows/${workflowCreated.id}/activate`, {
    method: "POST",
    headers: _headers,
  });
  if (!activateRes.ok) {
    // Cleanup: delete the newly created workflow to avoid orphans
    await deleteWorkflow(workflowCreated.id).catch(() => {});
    throw new Error(`N8N workflow activate failed [${activateRes.status}]: ${await activateRes.text()}`);
  }

  return await activateRes.json();
};

// ─── Node transformers ────────────────────────────────────────────────────────

const replaceWebhookId = (nodes, instance) => {
  const oldId = "d5c1216d-4d32-406a-afde-ddc5ca51b40d";
  const otherId = "4f9d86ae-04c0-49ca-a77c-a38f5a345aad";

  const traverse = (obj) => {
    if (typeof obj === "string") {
      return obj.replaceAll(oldId, instance).replaceAll(otherId, instance);
    } else if (Array.isArray(obj)) {
      return obj.map(traverse);
    } else if (obj && typeof obj === "object") {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, traverse(v)]));
    }
    return obj;
  };

  return nodes.map(traverse);
};

const replaceCompanyId = (nodes, company) => {
  return nodes.map((node) => {
    if (node.parameters?.operation === "executeQuery" && node.parameters?.query) {
      node.parameters.query = node.parameters.query.replace(/c\.id\s*=\s*\d+/, `c.id = ${company}`);
    }
    return node;
  });
};

module.exports = { duplicate };
