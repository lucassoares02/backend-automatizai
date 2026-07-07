const pool = require("../db");
const { n8nUrlWebhook } = require("./evolutionService");

// Webhook do n8n que roda a campanha (IA dispara as mensagens no WhatsApp).
const WEBHOOK_PATH = "run-campaign";
const FETCH_TIMEOUT_MS = 15000;
const WEBHOOK_AUTH_USER = process.env.WEBHOOK_N8N_USER;
const WEBHOOK_AUTH_PASS = process.env.WEBHOOK_N8N_PASS;
const WEBHOOK_AUTH_HEADER = `Basic ${Buffer.from(
  `${WEBHOOK_AUTH_USER}:${WEBHOOK_AUTH_PASS}`,
).toString("base64")}`;

const AUDIENCE_TYPES = ["all", "selected", "top_recurrence", "inactive"];
const SCHEDULE_TYPES = ["now", "scheduled"];
const PERIODS = ["morning", "afternoon", "evening"];

// ─── Helpers ────────────────────────────────────────────────────────────────

const _num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Janela de validade do desconto no carrinho. Recebe 'yyyy-MM-dd' opcional;
// default = fim do dia da data agendada (ou de hoje, quando 'Agora').
const _computeValidUntil = (validUntil, scheduledDate) => {
  const base = validUntil || scheduledDate;
  if (base) return `${String(base).slice(0, 10)} 23:59:59`;
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} 23:59:59`;
};

// Calcula o preço final a partir do desconto (percentual ou fixo). Nunca negativo.
const _finalPrice = (price, discountType, discountValue) => {
  const p = _num(price);
  const d = _num(discountValue);
  const final = discountType === "fixed" ? p - d : p * (1 - d / 100);
  return Number(Math.max(0, final).toFixed(2));
};

// Resolve os produtos com preço autoritativo do banco (restrito à empresa).
const _buildProducts = async (companyId, products) => {
  const list = Array.isArray(products) ? products : [];
  const ids = [...new Set(list.map((p) => Number(p.menu_item_id)).filter(Boolean))];
  if (!ids.length) return [];
  const res = await pool.query(
    "SELECT id, name, price FROM menu_items WHERE company_id = $1 AND id = ANY($2::int[])",
    [companyId, ids],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  const out = [];
  for (const p of list) {
    const product = byId.get(Number(p.menu_item_id));
    if (!product) continue;
    const discountType = p.discount_type === "fixed" ? "fixed" : "percent";
    const discountValue = _num(p.discount_value);
    const price = _num(product.price);
    out.push({
      menu_item_id: product.id,
      name: product.name,
      discount_type: discountType,
      discount_value: discountValue,
      price,
      final_price: _finalPrice(price, discountType, discountValue),
    });
  }
  return out;
};

// ─── Resolução de público ─────────────────────────────────────────────────────
// Monta a query de clientes-alvo conforme o tipo. Para 'selected', os clientes
// são gravados na criação (campaign_clients) — aqui só listamos os já vinculados.
const _resolveAudienceClients = async (campaign) => {
  const companyId = campaign.company_id;
  const type = campaign.audience_type;

  if (type === "selected") {
    const res = await pool.query(
      `SELECT c.id, c.name, c.phone
         FROM campaign_clients cc
         JOIN clients c ON c.id = cc.client_id
        WHERE cc.campaign_id = $1`,
      [campaign.id],
    );
    return res.rows;
  }

  const limit = campaign.audience_limit != null ? Number(campaign.audience_limit) : null;

  if (type === "inactive") {
    const days = campaign.inactive_days != null ? Number(campaign.inactive_days) : 30;
    const res = await pool.query(
      `WITH stats AS (
         SELECT o.client_id, MAX(o.created_at) AS last_order_at
           FROM orders o WHERE o.company_id = $1 GROUP BY o.client_id
       )
       SELECT c.id, c.name, c.phone
         FROM clients c
         LEFT JOIN stats s ON s.client_id = c.id
        WHERE c.company_id = $1
          AND (s.last_order_at IS NULL OR s.last_order_at < NOW() - ($2 || ' days')::interval)
        ORDER BY s.last_order_at ASC NULLS FIRST
        ${limit ? "LIMIT " + Number(limit) : ""}`,
      [companyId, String(days)],
    );
    return res.rows;
  }

  if (type === "top_recurrence") {
    const res = await pool.query(
      `WITH stats AS (
         SELECT o.client_id, COUNT(o.id)::int AS total_orders, MAX(o.created_at) AS last_order_at
           FROM orders o WHERE o.company_id = $1 GROUP BY o.client_id
       )
       SELECT c.id, c.name, c.phone
         FROM clients c
         JOIN stats s ON s.client_id = c.id
        WHERE c.company_id = $1
        ORDER BY s.total_orders DESC, s.last_order_at DESC
        ${limit ? "LIMIT " + Number(limit) : "LIMIT 100"}`,
      [companyId],
    );
    return res.rows;
  }

  // all
  const res = await pool.query(
    `SELECT c.id, c.name, c.phone FROM clients c WHERE c.company_id = $1 ORDER BY c.name ASC
     ${limit ? "LIMIT " + Number(limit) : ""}`,
    [companyId],
  );
  return res.rows;
};

// Prévia da contagem do público (sem gravar nada). Para 'selected' recebe a
// própria lista escolhida no formulário.
const audiencePreview = async (companyId, params) => {
  const type = AUDIENCE_TYPES.includes(params.audience_type) ? params.audience_type : "all";
  if (type === "selected") {
    const ids = Array.isArray(params.client_ids) ? params.client_ids : [];
    return { audience_type: type, count: ids.length };
  }
  const fake = {
    id: null,
    company_id: companyId,
    audience_type: type,
    audience_limit: params.audience_limit != null ? Number(params.audience_limit) : null,
    inactive_days: params.inactive_days != null ? Number(params.inactive_days) : null,
  };
  const rows = await _resolveAudienceClients(fake);
  return { audience_type: type, count: rows.length };
};

// ─── Leitura ──────────────────────────────────────────────────────────────────

const _mapCampaign = (row) => ({
  ...row,
  products: row.products || [],
});

const findByCompany = async (companyId) => {
  const res = await pool.query(
    `SELECT ca.*,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', cp.id, 'menu_item_id', cp.menu_item_id, 'name', mi.name,
                'image_url', mi.image_url, 'discount_type', cp.discount_type,
                'discount_value', cp.discount_value, 'price', cp.price, 'final_price', cp.final_price
              ) ORDER BY cp.id)
              FROM campaign_products cp
              JOIN menu_items mi ON mi.id = cp.menu_item_id
              WHERE cp.campaign_id = ca.id
            ), '[]'::json) AS products,
            (SELECT COUNT(*)::int FROM campaign_clients cc WHERE cc.campaign_id = ca.id) AS clients_total,
            (SELECT COUNT(*)::int FROM campaign_clients cc WHERE cc.campaign_id = ca.id AND cc.status = 'sent') AS clients_sent
       FROM campaigns ca
      WHERE ca.company_id = $1
      ORDER BY ca.created_at DESC`,
    [companyId],
  );
  return res.rows.map(_mapCampaign);
};

const find = async (id, companyId) => {
  const res = await pool.query(
    `SELECT ca.*,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', cp.id, 'menu_item_id', cp.menu_item_id, 'name', mi.name,
                'image_url', mi.image_url, 'discount_type', cp.discount_type,
                'discount_value', cp.discount_value, 'price', cp.price, 'final_price', cp.final_price
              ) ORDER BY cp.id)
              FROM campaign_products cp
              JOIN menu_items mi ON mi.id = cp.menu_item_id
              WHERE cp.campaign_id = ca.id
            ), '[]'::json) AS products,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', cc.id, 'client_id', cc.client_id, 'name', c.name, 'phone', c.phone,
                'status', cc.status, 'responded', cc.responded, 'message', cc.message,
                'sent_at', cc.sent_at
              ) ORDER BY cc.id)
              FROM campaign_clients cc
              JOIN clients c ON c.id = cc.client_id
              WHERE cc.campaign_id = ca.id
            ), '[]'::json) AS clients
       FROM campaigns ca
      WHERE ca.id = $1 AND ca.company_id = $2`,
    [id, companyId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, products: row.products || [], clients: row.clients || [] };
};

// ─── Criação / edição ───────────────────────────────────────────────────────

const create = async (data) => {
  const companyId = Number(data.company_id);
  const title = (data.title || "").trim();
  if (!title) throw Object.assign(new Error("Título é obrigatório."), { status: 400 });

  const audienceType = AUDIENCE_TYPES.includes(data.audience_type) ? data.audience_type : "all";
  const scheduleType = SCHEDULE_TYPES.includes(data.schedule_type) ? data.schedule_type : "now";
  const period = PERIODS.includes(data.period) ? data.period : null;
  const scheduledDate = scheduleType === "scheduled" ? data.scheduled_date || null : null;

  if (scheduleType === "scheduled" && !scheduledDate) {
    throw Object.assign(new Error("Data é obrigatória para campanha programada."), { status: 400 });
  }

  const products = await _buildProducts(companyId, data.products);
  const selectedClientIds =
    audienceType === "selected" && Array.isArray(data.client_ids)
      ? [...new Set(data.client_ids.map(Number).filter(Boolean))]
      : [];

  // 'now' já nasce como 'scheduled' e é despachado logo abaixo; o cron cobre o resto.
  const status = "scheduled";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const camp = await client.query(
      `INSERT INTO campaigns
        (company_id, title, description, image_url, audience_type, audience_limit,
         inactive_days, schedule_type, scheduled_date, period, status, discount_valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        companyId,
        title,
        data.description || null,
        data.image_url || null,
        audienceType,
        data.audience_limit != null ? Number(data.audience_limit) : null,
        data.inactive_days != null ? Number(data.inactive_days) : null,
        scheduleType,
        scheduledDate,
        period,
        status,
        _computeValidUntil(data.valid_until, scheduledDate),
      ],
    );
    const campaign = camp.rows[0];

    for (const p of products) {
      await client.query(
        `INSERT INTO campaign_products
          (campaign_id, menu_item_id, discount_type, discount_value, price, final_price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [campaign.id, p.menu_item_id, p.discount_type, p.discount_value, p.price, p.final_price],
      );
    }

    // Para 'selected', grava o público escolhido já na criação.
    for (const cid of selectedClientIds) {
      await client.query(
        `INSERT INTO campaign_clients (campaign_id, client_id)
         VALUES ($1,$2) ON CONFLICT (campaign_id, client_id) DO NOTHING`,
        [campaign.id, cid],
      );
    }

    await client.query("COMMIT");

    // Disparo imediato quando "Agora".
    if (scheduleType === "now") {
      // fora da transação: falha no n8n não deve desfazer a campanha criada.
      dispatchCampaign(campaign.id).catch((e) =>
        console.error(`[campaigns] dispatch imediato falhou id=${campaign.id}: ${e.message}`),
      );
    }

    return await find(campaign.id, companyId);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

const update = async (id, companyId, data) => {
  const current = await pool.query(
    "SELECT * FROM campaigns WHERE id = $1 AND company_id = $2",
    [id, companyId],
  );
  const camp = current.rows[0];
  if (!camp) throw Object.assign(new Error("Campanha não encontrada."), { status: 404 });
  if (!["draft", "scheduled"].includes(camp.status)) {
    throw Object.assign(new Error("Só é possível editar campanhas ainda não disparadas."), { status: 409 });
  }

  const audienceType = AUDIENCE_TYPES.includes(data.audience_type) ? data.audience_type : camp.audience_type;
  const scheduleType = SCHEDULE_TYPES.includes(data.schedule_type) ? data.schedule_type : camp.schedule_type;
  const period = data.period !== undefined ? (PERIODS.includes(data.period) ? data.period : null) : camp.period;
  const scheduledDate = scheduleType === "scheduled" ? data.scheduled_date || camp.scheduled_date : null;
  const products = await _buildProducts(companyId, data.products);
  const selectedClientIds =
    audienceType === "selected" && Array.isArray(data.client_ids)
      ? [...new Set(data.client_ids.map(Number).filter(Boolean))]
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE campaigns SET
         title = $2, description = $3, image_url = $4, audience_type = $5, audience_limit = $6,
         inactive_days = $7, schedule_type = $8, scheduled_date = $9, period = $10,
         discount_valid_until = $11, updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        (data.title || camp.title).trim(),
        data.description !== undefined ? data.description : camp.description,
        data.image_url !== undefined ? data.image_url : camp.image_url,
        audienceType,
        data.audience_limit != null ? Number(data.audience_limit) : null,
        data.inactive_days != null ? Number(data.inactive_days) : null,
        scheduleType,
        scheduledDate,
        period,
        _computeValidUntil(data.valid_until, scheduledDate),
      ],
    );

    if (Array.isArray(data.products)) {
      await client.query("DELETE FROM campaign_products WHERE campaign_id = $1", [id]);
      for (const p of products) {
        await client.query(
          `INSERT INTO campaign_products
            (campaign_id, menu_item_id, discount_type, discount_value, price, final_price)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, p.menu_item_id, p.discount_type, p.discount_value, p.price, p.final_price],
        );
      }
    }

    if (selectedClientIds) {
      await client.query("DELETE FROM campaign_clients WHERE campaign_id = $1", [id]);
      for (const cid of selectedClientIds) {
        await client.query(
          `INSERT INTO campaign_clients (campaign_id, client_id)
           VALUES ($1,$2) ON CONFLICT (campaign_id, client_id) DO NOTHING`,
          [id, cid],
        );
      }
    }

    await client.query("COMMIT");
    return await find(id, companyId);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

const remove = async (id, companyId) => {
  const res = await pool.query(
    "DELETE FROM campaigns WHERE id = $1 AND company_id = $2 RETURNING id",
    [id, companyId],
  );
  if (!res.rows[0]) throw Object.assign(new Error("Campanha não encontrada."), { status: 404 });
  return { id: res.rows[0].id };
};

// ─── Disparo (n8n) ──────────────────────────────────────────────────────────

const _postWebhook = async (payload) => {
  const url = `${n8nUrlWebhook}${WEBHOOK_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: WEBHOOK_AUTH_HEADER },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
};

// Resolve o público, grava campaign_clients, chama o n8n e atualiza o status.
// Usado tanto pelo disparo imediato ('now') quanto pelo cron (campanhas 'scheduled').
const dispatchCampaign = async (campaignId) => {
  const campRes = await pool.query(
    `SELECT ca.*, comp.name AS company_name
       FROM campaigns ca JOIN companies comp ON comp.id = ca.company_id
      WHERE ca.id = $1`,
    [campaignId],
  );
  const campaign = campRes.rows[0];
  if (!campaign) throw Object.assign(new Error("Campanha não encontrada."), { status: 404 });

  // Resolve e grava os clientes (dedup); para 'selected' já estão gravados.
  const clients = await _resolveAudienceClients(campaign);
  if (campaign.audience_type !== "selected") {
    for (const c of clients) {
      await pool.query(
        `INSERT INTO campaign_clients (campaign_id, client_id)
         VALUES ($1,$2) ON CONFLICT (campaign_id, client_id) DO NOTHING`,
        [campaign.id, c.id],
      );
    }
  }

  // Lê os campaign_clients já com o id da linha (a IA reporta por esse id).
  const targetRes = await pool.query(
    `SELECT cc.id AS campaign_client_id, c.id AS client_id, c.name, c.phone
       FROM campaign_clients cc JOIN clients c ON c.id = cc.client_id
      WHERE cc.campaign_id = $1`,
    [campaign.id],
  );
  const targets = targetRes.rows;

  const prodRes = await pool.query(
    `SELECT cp.menu_item_id, mi.name, cp.discount_type, cp.discount_value, cp.price, cp.final_price
       FROM campaign_products cp JOIN menu_items mi ON mi.id = cp.menu_item_id
      WHERE cp.campaign_id = $1`,
    [campaign.id],
  );

  const payload = {
    event: "campaign_run",
    campaign: {
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      image_url: campaign.image_url,
      period: campaign.period,
      scheduled_date: campaign.scheduled_date,
      schedule_type: campaign.schedule_type,
    },
    company: { id: campaign.company_id, name: campaign.company_name },
    products: prodRes.rows,
    clients: targets,
    report_url: "/api/campaigns/webhook/report",
  };

  await pool.query(
    "UPDATE campaigns SET status = 'running', fired_at = NOW(), clients_count = $2, updated_at = NOW() WHERE id = $1",
    [campaign.id, targets.length],
  );

  try {
    await _postWebhook(payload);
    await pool.query("UPDATE campaigns SET status = 'sent', updated_at = NOW() WHERE id = $1", [campaign.id]);
    console.log(`[campaigns] disparada id=${campaign.id} clientes=${targets.length}`);
  } catch (err) {
    await pool.query("UPDATE campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [campaign.id]);
    console.error(`[campaigns] falha ao disparar id=${campaign.id}: ${err.message}`);
    throw err;
  }

  return { id: campaign.id, clients_count: targets.length };
};

// Callback do n8n: atualiza status/mensagem/horário de envio por cliente.
const reportFromWebhook = async (items) => {
  const list = Array.isArray(items) ? items : [];
  let updated = 0;
  for (const it of list) {
    const ccId = Number(it.campaign_client_id);
    if (!ccId) continue;
    const status = ["pending", "sent", "failed", "responded"].includes(it.status) ? it.status : "sent";
    const responded = it.responded === true || status === "responded";
    await pool.query(
      `UPDATE campaign_clients
          SET status = $2,
              responded = $3,
              message = COALESCE($4, message),
              sent_at = COALESCE($5, sent_at, NOW()),
              responded_at = CASE WHEN $3 THEN NOW() ELSE responded_at END
        WHERE id = $1`,
      [ccId, status, responded, it.message || null, it.sent_at || null],
    );
    updated += 1;
  }
  return { updated };
};

// ─── Preços ativos (desconto real no carrinho) ────────────────────────────────
// Mapa menu_item_id -> { final_price, price, discount_percent } dos produtos com
// campanha disparada e ainda válida. Se o mesmo produto está em mais de uma
// campanha, escolhe o menor preço (melhor para o cliente).
const getActivePricesMap = async (companyId) => {
  const map = new Map();
  try {
    const res = await pool.query(
      `SELECT cp.menu_item_id,
              MIN(cp.final_price) AS final_price,
              MAX(cp.price)       AS price
         FROM campaign_products cp
         JOIN campaigns ca ON ca.id = cp.campaign_id
        WHERE ca.company_id = $1
          AND ca.status IN ('running', 'sent')
          AND (ca.discount_valid_until IS NULL OR ca.discount_valid_until >= NOW())
        GROUP BY cp.menu_item_id`,
      [companyId],
    );
    for (const r of res.rows) {
      const price = Number(r.price ?? 0);
      const finalPrice = Number(r.final_price ?? 0);
      const pct = price > 0 ? Number((100 * (1 - finalPrice / price)).toFixed(2)) : 0;
      map.set(Number(r.menu_item_id), { final_price: finalPrice, price, discount_percent: pct });
    }
  } catch (err) {
    // Antes de rodar a migration as tabelas não existem — nunca quebrar o fluxo
    // público por causa disso.
    console.error(`[campaigns] getActivePricesMap falhou (migration pendente?): ${err.message}`);
  }
  return map;
};

// ─── Cron: campanhas programadas vencidas ─────────────────────────────────────
// Janela de início por período (o n8n/IA distribui os envios ao longo dela).
const _periodStartHour = (period) => {
  if (period === "afternoon") return 12;
  if (period === "evening") return 18;
  return 8; // morning ou sem período
};

// Retorna campanhas 'scheduled' cuja data+janela já começou.
const findDueCampaigns = async () => {
  const res = await pool.query(
    `SELECT id, period, scheduled_date FROM campaigns
      WHERE status = 'scheduled' AND schedule_type = 'scheduled' AND scheduled_date IS NOT NULL
        AND scheduled_date <= CURRENT_DATE
      ORDER BY scheduled_date ASC`,
  );
  const now = new Date();
  return res.rows.filter((r) => {
    const d = new Date(r.scheduled_date);
    // Dias passados: dispara já. Hoje: respeita a hora de início da janela.
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (!isToday) return true;
    return now.getHours() >= _periodStartHour(r.period);
  });
};

module.exports = {
  findByCompany,
  find,
  audiencePreview,
  create,
  update,
  remove,
  dispatchCampaign,
  reportFromWebhook,
  findDueCampaigns,
  getActivePricesMap,
};
