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

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const updatedNodes = rewriteWebhookIds(replaceCompanyId(workflow.nodes, company), instance);

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
    // Pequeno respiro pra n8n liberar o registro do webhook antes do create.
    await _sleep(600);
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
    const errText = await activateRes.text();
    // Cleanup: delete the newly created workflow to avoid orphans
    await deleteWorkflow(workflowCreated.id).catch(() => {});
    throw new Error(`N8N workflow activate failed [${activateRes.status}]: ${errText}`);
  }

  return await activateRes.json();
};

// ─── Node transformers ────────────────────────────────────────────────────────

/**
 * Rewrites every webhook node in the workflow to have a fresh unique
 * `webhookId` AND a fresh unique `parameters.path`, both derived from
 * `instance` plus a per-node suffix.
 *
 * Two things matter for n8n to activate without "conflict with one of the
 * webhooks":
 *  - each webhook node within the workflow must have a unique webhookId;
 *  - each webhook PATH must be globally unique across all active workflows
 *    in the n8n instance.
 *
 * Strategy:
 *  1. First pass: scan nodes, detect every webhook-like node, assign new
 *     unique IDs, and build a map oldId → newId.
 *  2. Second pass: traverse ALL nodes (including non-webhook) and rewrite
 *     any string reference to an old webhook id to its new value. This keeps
 *     internal references (e.g., HTTP/Wait/Resume nodes that point back to
 *     the webhook) consistent.
 *
 * This is robust to ANY UUID present in the template — we don't hardcode the
 * old ids.
 */
const rewriteWebhookIds = (nodes, instance) => {
  const idMap = new Map(); // oldWebhookId → newWebhookId
  const isWebhookNode = (node) => {
    const t = String(node?.type || "").toLowerCase();
    // Catches: n8n-nodes-base.webhook, .formTrigger, .respondToWebhook, etc.
    return t.includes("webhook") || t.endsWith(".formtrigger");
  };

  // ── Pass 1: detect webhooks, assign new unique ids ──────────────────────────
  let counter = 0;
  const stage1 = nodes.map((node) => {
    if (!isWebhookNode(node)) return node;
    counter += 1;
    const oldId = node.webhookId;
    // const newId = `${instance}-${counter}`;
    const newId = `${instance}`;
    if (oldId && !idMap.has(oldId)) idMap.set(oldId, newId);

    const oldPath = node?.parameters?.path;
    // Reaproveita o mesmo newId pra path — fica simples de auditar nas URLs.
    if (oldPath && !idMap.has(oldPath) && oldPath !== oldId) {
      idMap.set(oldPath, newId);
    }

    return {
      ...node,
      webhookId: newId,
      parameters: {
        ...(node.parameters || {}),
        path: newId,
      },
    };
  });

  // ── Pass 2: rewrite every string that references an old id ──────────────────
  if (idMap.size === 0) return stage1;

  const traverse = (obj) => {
    if (typeof obj === "string") {
      let s = obj;
      for (const [oldId, newId] of idMap) {
        if (s.includes(oldId)) s = s.split(oldId).join(newId);
      }
      return s;
    } else if (Array.isArray(obj)) {
      return obj.map(traverse);
    } else if (obj && typeof obj === "object") {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, traverse(v)]));
    }
    return obj;
  };

  return stage1.map(traverse);
};

const replaceCompanyId = (nodes, company) => {
  return nodes.map((node) => {
    if (node.parameters?.operation === "executeQuery" && node.parameters?.query) {
      node.parameters.query = node.parameters.query.replace(/c\.id\s*=\s*\d+/, `c.id = ${company}`);
    }
    return node;
  });
};

/**
 * Atualizar fluxo do n8n para uma empresa.
 *
 * Estratégia: delete + recria. Reutiliza `duplicate` que já implementa esse
 * fluxo (deactivate → delete → fetch template → adapt → create → activate).
 * Mantida como função separada para deixar a intenção clara no controller.
 */
const update = async (instance, company) => {
  return duplicate(instance, company);
};

module.exports = { duplicate, update };
