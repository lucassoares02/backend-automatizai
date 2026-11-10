const pool = require("../db");
const { n8nUrlWebhook } = require("./evolutionService");

const WEBHOOK_PATH = "campaign-suggestion";
const FETCH_TIMEOUT_MS = 60000;
const AUDIENCE_TYPES = new Set(["all", "top_recurrence", "inactive"]);
const WEBHOOK_AUTH_USER = process.env.WEBHOOK_N8N_USER;
const WEBHOOK_AUTH_PASS = process.env.WEBHOOK_N8N_PASS;

const _string = (value, maxLength) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const _normalizeSuggestion = (raw, products, companyId) => {
  const value = raw?.suggestion ?? raw?.data ?? raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("O n8n não retornou uma sugestão válida."), { status: 502 });
  }

  const productsById = new Map(products.map((p) => [Number(p.id), p]));
  const allowedImageUrls = new Set(products.map((p) => p.image_url).filter(Boolean));
  const suggestedProducts = (Array.isArray(value.products) ? value.products : [])
    .map((p) => {
      const product = productsById.get(Number(p?.menu_item_id));
      if (!product) return null;
      const discountType = p.discount_type === "fixed" ? "fixed" : "percent";
      const discountValue = Number(p.discount_value);
      if (!Number.isFinite(discountValue) || discountValue <= 0) return null;
      return {
        menu_item_id: product.id,
        name: product.name,
        image_url: product.image_url,
        price: Number(product.price) || 0,
        discount_type: discountType,
        discount_value: Math.min(discountValue, discountType === "percent" ? 90 : Number(product.price) || 0),
        final_price: Number(Math.max(0, discountType === "fixed"
          ? Number(product.price) - Math.min(discountValue, Number(product.price) || 0)
          : Number(product.price) * (1 - Math.min(discountValue, 90) / 100)).toFixed(2)),
      };
    })
    .filter(Boolean);

  if (!suggestedProducts.length) {
    throw Object.assign(new Error("A sugestão não incluiu produtos válidos do cardápio da empresa."), { status: 502 });
  }

  const audienceType = AUDIENCE_TYPES.has(value.audience_type) ? value.audience_type : "all";
  const suggestedImageUrl = _string(value.image_url, 2000);
  const campaign = {
    company_id: companyId,
    title: _string(value.title, 120),
    description: _string(value.description, 2000),
    image_url: allowedImageUrls.has(suggestedImageUrl)
      ? suggestedImageUrl
      : suggestedProducts[0].image_url || null,
    audience_type: audienceType,
    audience_limit: audienceType === "top_recurrence" ? Math.max(1, Math.min(Number(value.audience_limit) || 50, 500)) : null,
    inactive_days: audienceType === "inactive" ? Math.max(1, Math.min(Number(value.inactive_days) || 30, 3650)) : null,
    schedule_type: "now",
    scheduled_date: null,
    period: null,
    valid_until: _string(value.valid_until, 10) || null,
    products: suggestedProducts,
  };

  if (!campaign.title || !campaign.description) {
    throw Object.assign(new Error("A sugestão retornada pelo n8n está incompleta."), { status: 502 });
  }
  return campaign;
};

const suggestCampaign = async (companyId) => {
  const companyResult = await pool.query("SELECT id FROM companies WHERE id = $1", [companyId]);
  const company = companyResult.rows[0];
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });

  const [productResult, salesResult, clientsResult] = await Promise.all([
    pool.query(
      `SELECT id, name, description, price, image_url
         FROM menu_items
        WHERE company_id = $1 AND deleted_at IS NULL AND available = true
        ORDER BY id`,
      [companyId],
    ),
    pool.query(
      `SELECT o.created_at, o.total, o.status,
              COALESCE(json_agg(json_build_object(
                'menu_item_id', oi.menu_item_id,
                'name', oi.item_name,
                'quantity', oi.quantity,
                'subtotal', oi.subtotal
              ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.company_id = $1
          AND o.created_at >= NOW() - INTERVAL '180 days'
          AND COALESCE(o.status::text, '') NOT IN ('6', '7')
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 500`,
      [companyId],
    ),
    pool.query(
      `WITH client_orders AS (
         SELECT c.id,
                COUNT(o.id) FILTER (WHERE COALESCE(o.status::text, '') NOT IN ('6', '7'))::int AS order_count,
                MAX(o.created_at) FILTER (WHERE COALESCE(o.status::text, '') NOT IN ('6', '7')) AS last_order_at
           FROM clients c
           LEFT JOIN orders o ON o.client_id = c.id AND o.company_id = c.company_id
          WHERE c.company_id = $1
          GROUP BY c.id
       )
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE order_count > 0)::int AS customers_with_orders,
              COUNT(*) FILTER (WHERE order_count > 1)::int AS recurring,
              COUNT(*) FILTER (WHERE last_order_at IS NULL OR last_order_at < NOW() - INTERVAL '30 days')::int AS inactive_30_days,
              COUNT(*) FILTER (WHERE last_order_at IS NULL OR last_order_at < NOW() - INTERVAL '60 days')::int AS inactive_60_days
         FROM client_orders`,
      [companyId],
    ),
  ]);

  const payload = {
    event: "campaign_suggestion",
    products: productResult.rows.map((p) => ({ ...p, price: Number(p.price) || 0 })),
    sales: salesResult.rows,
    clients: clientsResult.rows[0] || { total: 0, customers_with_orders: 0, recurring: 0, inactive_30_days: 0, inactive_60_days: 0 },
    analysis_window_days: 180,
  };

  if (!WEBHOOK_AUTH_USER || !WEBHOOK_AUTH_PASS) {
    throw Object.assign(new Error("A autenticação do webhook n8n não está configurada."), { status: 503 });
  }

  let response;
  try {
    response = await fetch(`${n8nUrlWebhook}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${WEBHOOK_AUTH_USER}:${WEBHOOK_AUTH_PASS}`).toString("base64")}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[campaign-suggestion] webhook request failed: ${error.message}`);
    throw Object.assign(new Error("Não foi possível consultar o n8n agora. Tente novamente."), { status: 502 });
  }

  if (!response.ok) {
    console.error(`[campaign-suggestion] n8n returned HTTP ${response.status}`);
    throw Object.assign(new Error("O serviço de sugestões está indisponível. Tente novamente."), { status: 502 });
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error("O n8n retornou uma resposta inválida."), { status: 502 });
  }
  return _normalizeSuggestion(result, payload.products, companyId);
};

module.exports = { suggestCampaign };
