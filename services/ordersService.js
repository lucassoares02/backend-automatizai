const pool = require("../db");
const orderWebhookService = require("./orderWebhookService");
const campaignsService = require("./campaignsService");
const { generateUniqueOrderTag } = require("../helpers/orderTag");
const { columnExists } = require("../helpers/schema");
const STATUS_IN_PROGRESS = [1, 2, 3, 4, 8];
const STATUS_COMPLETED = [5, 9];
const STATUS_CANCELLED = [6, 7];

const ORDER_SELECT = `
  SELECT o.*,
         COALESCE(
           (to_jsonb(o)->>'delivery_fee_pending_agreement')::boolean,
           false
         ) AS delivery_fee_pending_agreement,
         (to_jsonb(o)->>'delivery_distance_meters')::integer AS delivery_distance_meters,
         (to_jsonb(o)->>'delivery_fee_agreement_confirmed_at')::timestamptz
           AS delivery_fee_agreement_confirmed_at,
         c.name  AS client_name,
         c.phone AS client_phone,
         pm.label AS payment_method_label,
         pm.type  AS payment_method_type,
         COALESCE(
           (SELECT json_agg(
              json_build_object(
                'id', oi.id,
                'menu_item_id', oi.menu_item_id,
                'item_name', oi.item_name,
                'name', oi.item_name,
                'quantity', oi.quantity,
                'item_price', oi.item_price,
                'unit_price', oi.item_price,
                'subtotal', oi.subtotal,
                'notes', oi.notes,
                'promotion_id', oi.promotion_id,
                'promotion_group_key', oi.promotion_group_key,
                'options', COALESCE((
                  SELECT json_agg(
                    json_build_object(
                      'menu_item_id', oio.menu_item_id,
                      'group_id', oio.group_id,
                      'group_name', oio.group_name,
                      'option_id', oio.option_id,
                      'option_name', oio.option_name,
                      'additional_price', oio.additional_price,
                      'quantity', oio.quantity
                    ) ORDER BY oio.id
                  ) FROM order_item_options oio WHERE oio.order_item_id = oi.id
                ), '[]'::json)
              ) ORDER BY oi.id
            ) FROM order_items oi WHERE oi.order_id = o.id),
           '[]'::json
         ) AS items,
         (SELECT COUNT(*) FROM order_messages m
          WHERE m.order_id = o.id AND m.sender_type = 'customer' AND m.is_read = false) AS unread_messages_count
  FROM orders o
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
`;

const findByCompany = async (companyId) => {
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.company_id = $1
     GROUP BY o.id, c.name, c.phone, pm.label, pm.type
     ORDER BY o.created_at DESC`,
    [companyId],
  );
  return result.rows;
};

const findTodayByCompany = async (companyId) => {
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.company_id = $1
       AND o.created_at::date = CURRENT_DATE
     GROUP BY o.id, c.name, c.phone, pm.label, pm.type
     ORDER BY o.created_at DESC`,
    [companyId],
  );
  return result.rows;
};

const find = async (id) => {
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.id = $1
     GROUP BY o.id, c.name, c.phone, pm.label, pm.type`,
    [id],
  );
  return result.rows[0] || null;
};

const summarize = async (companyId) => {
  const result = await pool.query(
    `WITH latest_status AS (
       SELECT DISTINCT ON (order_id)
         order_id,
         CASE WHEN status ~ '^[0-9]+$' THEN status::int ELSE NULL END AS status_code
       FROM order_status_history
       ORDER BY order_id, created_at DESC
     )
     SELECT
       COUNT(*)                                                                                      AS total,
       COUNT(*) FILTER (WHERE o.created_at::date = CURRENT_DATE)                                    AS today,
       COUNT(*) FILTER (WHERE ls.status_code IS NULL OR ls.status_code = ANY($2::int[]))            AS in_progress,
       COUNT(*) FILTER (WHERE ls.status_code = ANY($3::int[]))                                      AS completed,
       COUNT(*) FILTER (WHERE ls.status_code = ANY($4::int[]))                                      AS cancelled,
       COALESCE(SUM(o.total), 0)                                                                     AS total_value,
       COALESCE(SUM(o.total) FILTER (WHERE o.created_at::date = CURRENT_DATE), 0)                   AS today_value,
       COALESCE(SUM(o.total) FILTER (WHERE ls.status_code IS NULL OR ls.status_code = ANY($2::int[])), 0) AS in_progress_value,
       COALESCE(SUM(o.total) FILTER (WHERE ls.status_code = ANY($3::int[])), 0)                     AS completed_value,
       COALESCE(SUM(o.total) FILTER (WHERE ls.status_code = ANY($4::int[])), 0)                     AS cancelled_value
     FROM orders o
     LEFT JOIN latest_status ls ON ls.order_id = o.id
     WHERE o.company_id = $1`,
    [companyId, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_CANCELLED],
  );
  return result.rows[0];
};

const create = async (data) => {
  const { company_id, client_id, notes, items, payment_method_id, delivery_address } = data;

  // delivery_type é BOOLEAN no DB (TRUE = entrega, FALSE = retirada).
  // Aceita boolean direto, ou string 'delivery'/'pickup' por compatibilidade.
  let delivery_type;
  if (data.delivery_type === false || data.delivery_type === "pickup") {
    delivery_type = false;
  } else if (data.delivery_type === true || data.delivery_type === "delivery") {
    delivery_type = true;
  } else {
    delivery_type = null;
  }

  const delivery_fee = Number(data.delivery_fee ?? 0);
  const discount = Number(data.discount ?? 0);
  const subtotal = items.reduce((sum, i) => sum + Number(i.subtotal), 0);
  const total = subtotal + delivery_fee - discount;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tag = await generateUniqueOrderTag(client);
    const orderRes = await client.query(
      `INSERT INTO orders
         (company_id, client_id, status, notes, subtotal, delivery_fee, discount, total,
          payment_method_id, delivery_address, delivery_type, tag)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        company_id,
        client_id,
        notes ?? null,
        subtotal,
        delivery_fee,
        discount,
        total,
        payment_method_id ?? null,
        delivery_address ?? null,
        delivery_type ?? null,
        tag,
      ],
    );
    const order = orderRes.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.menu_item_id ?? null, item.name, item.quantity, item.unit_price, item.subtotal],
      );
    }

    await client.query("COMMIT");
    return await find(order.id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// ─── Upsert simplificado (id do cardápio + quantidade) ──────────────────────────
// Cria (order nula) ou edita (order = id) um pedido a partir de uma lista enxuta
// de itens { id, quantity }. O preço NUNCA vem do cliente: é resolvido no servidor
// a partir de menu_items.price (com desconto de campanha ativo quando houver),
// restrito à empresa. Na edição, as quantidades são SOMADAS aos itens já existentes.
// Retorna { order_id, tag, products, total }.

// Normaliza e agrega a lista recebida em Map(menu_item_id -> quantity). Rejeita
// entradas sem id ou com quantidade inválida.
const _normalizeCartItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error("items é obrigatório e deve ter ao menos um item."), { status: 400 });
  }
  const qtyById = new Map();
  for (const raw of items) {
    const id = Number(raw?.id ?? raw?.menu_item_id);
    const qty = Number(raw?.quantity);
    if (!Number.isInteger(id) || id <= 0) {
      throw Object.assign(new Error("Cada item precisa de um id numérico válido."), { status: 400 });
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      throw Object.assign(new Error(`Quantidade inválida para o item ${id}.`), { status: 400 });
    }
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }
  return qtyById;
};

// Busca o preço autoritativo (com campanha) e o nome de cada item, restrito à
// empresa. Lança 400 se algum id não pertencer à empresa / estiver excluído.
const _resolveMenuItems = async (companyId, ids) => {
  const activeCampaignPrices = await campaignsService.getActivePricesMap(companyId);
  const r = await pool.query(
    `SELECT id, name, price FROM menu_items
     WHERE company_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
    [companyId, ids],
  );
  const byId = new Map();
  for (const row of r.rows) {
    const base = Number(row.price ?? 0);
    const camp = activeCampaignPrices.get(Number(row.id));
    const price = camp ? Math.min(base, camp.final_price) : base;
    byId.set(Number(row.id), { name: row.name, price });
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw Object.assign(
      new Error(`Itens não encontrados nesta empresa: ${missing.join(", ")}.`),
      { status: 400 },
    );
  }
  return byId;
};

// Monta a resposta enxuta a partir do pedido persistido.
const _cartResponse = (order) => ({
  order_id: order.id,
  tag: order.tag,
  products: (order.items || []).map((it) => ({
    menu_item_id: it.menu_item_id,
    name: it.item_name,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    subtotal: Number(it.subtotal),
  })),
  total: Number(order.total),
});

// Orçamento (preview): resolve preços e calcula o total SEM tocar no banco.
// Mesma entrada enxuta do upsert ({ id, quantity }) — mas não cria/edita pedido.
// Retorna { products, subtotal, total, items_count }.
const quoteCart = async ({ company_id, items }) => {
  const companyId = Number(company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw Object.assign(new Error("company_id é obrigatório."), { status: 400 });
  }
  const qtyById = _normalizeCartItems(items);
  const ids = [...qtyById.keys()];
  const menuById = await _resolveMenuItems(companyId, ids);

  const products = ids.map((id) => {
    const { name, price } = menuById.get(id);
    const quantity = qtyById.get(id);
    return {
      menu_item_id: id,
      name,
      quantity,
      unit_price: price,
      subtotal: Number((price * quantity).toFixed(2)),
    };
  });
  const subtotal = Number(products.reduce((sum, p) => sum + p.subtotal, 0).toFixed(2));

  return {
    products,
    subtotal,
    // Sem pedido persistido não há taxa de entrega/desconto: total = subtotal.
    total: subtotal,
    items_count: products.reduce((sum, p) => sum + p.quantity, 0),
  };
};

const upsertCart = async ({ order: orderId, company_id, client_id, items }) => {
  const companyId = Number(company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw Object.assign(new Error("company_id é obrigatório."), { status: 400 });
  }
  const qtyById = _normalizeCartItems(items);
  const ids = [...qtyById.keys()];
  const menuById = await _resolveMenuItems(companyId, ids);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let order;
    if (orderId == null) {
      // ── CRIAÇÃO ──────────────────────────────────────────────────────────
      const clientId = Number(client_id);
      if (!Number.isInteger(clientId) || clientId <= 0) {
        throw Object.assign(new Error("client_id é obrigatório para criar o pedido."), { status: 400 });
      }
      const subtotal = ids.reduce((sum, id) => sum + menuById.get(id).price * qtyById.get(id), 0);
      const tag = await generateUniqueOrderTag(client);
      const orderRes = await client.query(
        `INSERT INTO orders
           (company_id, client_id, status, subtotal, delivery_fee, discount, total, tag)
         VALUES ($1, $2, 1, $3, 0, 0, $3, $4)
         RETURNING id`,
        [companyId, clientId, subtotal, tag],
      );
      const newId = orderRes.rows[0].id;
      for (const id of ids) {
        const { name, price } = menuById.get(id);
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [newId, id, name, qtyById.get(id), price, price * qtyById.get(id)],
        );
      }
      order = { id: newId };
    } else {
      // ── EDIÇÃO (soma quantidades) ────────────────────────────────────────
      const existingRes = await client.query(
        "SELECT id, company_id, delivery_fee, discount FROM orders WHERE id = $1 FOR UPDATE",
        [orderId],
      );
      const existing = existingRes.rows[0];
      if (!existing) {
        throw Object.assign(new Error("Pedido não encontrado."), { status: 404 });
      }
      if (Number(existing.company_id) !== companyId) {
        throw Object.assign(new Error("Pedido não pertence a esta empresa."), { status: 403 });
      }
      for (const id of ids) {
        const { name, price } = menuById.get(id);
        // Soma à linha existente do mesmo item (sem promoção); senão, cria nova.
        // Alvo em UMA linha só (a mais antiga) — evita duplicar caso o pedido já
        // tenha mais de uma linha do mesmo item. O RHS do SET usa o valor ANTIGO
        // de quantity (semântica do UPDATE no PostgreSQL), então o subtotal fica
        // correto.
        const upd = await client.query(
          `UPDATE order_items
             SET quantity = quantity + $2,
                 subtotal = (quantity + $2) * item_price
           WHERE id = (
             SELECT id FROM order_items
             WHERE order_id = $1 AND menu_item_id = $3 AND promotion_id IS NULL
             ORDER BY id LIMIT 1
           )`,
          [orderId, qtyById.get(id), id],
        );
        if (upd.rowCount === 0) {
          await client.query(
            `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [orderId, id, name, qtyById.get(id), price, price * qtyById.get(id)],
          );
        }
      }
      // Recalcula os totais a partir das linhas persistidas.
      const sumRes = await client.query(
        "SELECT COALESCE(SUM(subtotal), 0) AS subtotal FROM order_items WHERE order_id = $1",
        [orderId],
      );
      const subtotal = Number(sumRes.rows[0].subtotal);
      const total = subtotal + Number(existing.delivery_fee || 0) - Number(existing.discount || 0);
      await client.query(
        "UPDATE orders SET subtotal = $2, total = $3, updated_at = NOW() WHERE id = $1",
        [orderId, subtotal, total],
      );
      order = { id: existing.id };
    }

    await client.query("COMMIT");
    return _cartResponse(await find(order.id));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const updateStatus = async (id, status, cancelReason) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const currentResult = await client.query(
      `SELECT
         o.status,
         o.payment_status,
         o.payment_provider,
         COALESCE(
           (to_jsonb(o)->>'delivery_fee_pending_agreement')::boolean,
           false
         ) AS delivery_fee_pending_agreement,
         (to_jsonb(o)->>'delivery_fee_agreement_confirmed_at')::timestamptz
           AS delivery_fee_agreement_confirmed_at
       FROM orders o
       WHERE o.id = $1
       FOR UPDATE`,
      [id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }

    const isCancellation = STATUS_CANCELLED.includes(Number(status));
    if (
      current.delivery_fee_pending_agreement === true &&
      !current.delivery_fee_agreement_confirmed_at &&
      !isCancellation
    ) {
      throw Object.assign(
        new Error("Confirme que o frete foi combinado antes de mudar a etapa do pedido."),
        { status: 409 },
      );
    }
    const isOnlinePaymentPending =
      Number(current.status) === 10 &&
      ["pagarme", "stripe"].includes(String(current.payment_provider || "")) &&
      !["paid", "refunded"].includes(String(current.payment_status || ""));
    if (isOnlinePaymentPending && !isCancellation) {
      throw Object.assign(
        new Error("Aguarde a confirmação do pagamento antes de mudar a etapa do pedido."),
        { status: 409 },
      );
    }

    const result = await client.query(
      `UPDATE orders
       SET status = $2,
           cancel_reason = CASE WHEN $2 = ANY($4::int[]) THEN $3 ELSE cancel_reason END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, cancelReason ?? null, STATUS_CANCELLED],
    );

    const order = result.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO order_status_history (order_id, status, notes)
       VALUES ($1, $2, $3)`,
      [id, String(status), cancelReason ?? null],
    );

    await client.query("COMMIT");

    // Fire-and-forget: o service decide se o status dispara e nunca lança —
    // falha do n8n não pode impactar a atualização do pedido.
    orderWebhookService.notifyStatusChange(order, Number(status));

    return order;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const confirmDeliveryFeeAgreement = async (id, deliveryFee) => {
  const amount = Number(deliveryFee);
  if (!Number.isFinite(amount) || amount < 0 || amount > 99999.99) {
    throw Object.assign(
      new Error("Informe um valor de frete válido."),
      { status: 400 },
    );
  }
  if (!(await columnExists("orders", "delivery_fee_agreement_confirmed_at"))) {
    throw Object.assign(
      new Error("A confirmação do frete aguarda a aplicação da alteração de banco."),
      { status: 503 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT
         o.id,
         o.total,
         o.delivery_fee,
         o.payment_status,
         o.pagarme_charge_id,
         COALESCE(
           (to_jsonb(o)->>'delivery_fee_pending_agreement')::boolean,
           false
         ) AS delivery_fee_pending_agreement,
         (to_jsonb(o)->>'delivery_fee_agreement_confirmed_at')::timestamptz
           AS delivery_fee_agreement_confirmed_at
       FROM orders o
       WHERE o.id = $1
       FOR UPDATE`,
      [id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw Object.assign(new Error("Pedido não encontrado."), { status: 404 });
    }
    if (current.delivery_fee_pending_agreement !== true) {
      throw Object.assign(
        new Error("Este pedido não possui frete pendente de combinação."),
        { status: 409 },
      );
    }
    if (current.delivery_fee_agreement_confirmed_at) {
      throw Object.assign(
        new Error("O frete deste pedido já foi definido."),
        { status: 409 },
      );
    }
    if (
      ["paid", "refunded", "refund_pending", "chargedback"].includes(
        String(current.payment_status || ""),
      ) ||
      current.pagarme_charge_id
    ) {
      throw Object.assign(
        new Error("Não é possível alterar o frete depois que a cobrança foi iniciada."),
        { status: 409 },
      );
    }

    const total = Number(
      (
        Number(current.total || 0) -
        Number(current.delivery_fee || 0) +
        amount
      ).toFixed(2),
    );
    const result = await client.query(
      `UPDATE orders
       SET delivery_fee = $2,
           total = $3,
           delivery_fee_agreement_confirmed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, Number(amount.toFixed(2)), total],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const remove = async (id) => {
  const result = await pool.query("DELETE FROM orders WHERE id = $1 RETURNING *", [id]);
  return result.rows[0];
};

module.exports = {
  findByCompany,
  findTodayByCompany,
  find,
  summarize,
  create,
  upsertCart,
  quoteCart,
  updateStatus,
  confirmDeliveryFeeAgreement,
  remove,
};
