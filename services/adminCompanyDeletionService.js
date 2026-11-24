const pool = require("../db");
const evolution = require("./evolutionService");
const n8n = require("./n8nService");
const pagarmeService = require("./pagarmeService");

// Exclusão completa de UMA empresa pelo admin do sistema (Minha Conta →
// Configurações → Excluir empresas). Versão em código de api/DELETE_COMPANIES.sql,
// atualizada com as tabelas criadas depois do script. Tudo roda em uma única
// transação: se qualquer passo falhar (FK inesperada, sobra de company_id),
// nada é alterado.
//
// Também remove os usuários do portal que pertenciam SOMENTE a esta empresa.
// Admins do sistema e usuários vinculados a outra empresa são preservados.
// Identidades globais de clientes (platform_users) não são removidas.
//
// Após o COMMIT, faz a limpeza externa em modo best-effort: cancela assinaturas
// no Pagar.me e apaga instâncias da Evolution e workflows do n8n. Arquivos no
// MinIO e cadastros de recebedor (Pagar.me/Stripe/iFood) não são removidos.

const _error = (code, message) => Object.assign(new Error(message), { code });

// Mesmo rótulo que o portal mostra para lojas sem nome.
const expectedConfirmation = (company) => {
  const name = typeof company.name === "string" ? company.name.trim() : "";
  return name || `Loja #${company.id}`;
};

const ORDERS = "SELECT id FROM orders WHERE company_id = $1";
const CLIENTS = "SELECT id FROM clients WHERE company_id = $1";
const MENU_ITEMS = "SELECT id FROM menu_items WHERE company_id = $1";
const PROFESSIONALS = "SELECT id FROM professionals WHERE company_id = $1";
const SUBSCRIPTIONS = `SELECT id FROM customer_subscriptions
  WHERE company_id = $1 OR client_id IN (${CLIENTS}) OR menu_item_id IN (${MENU_ITEMS})`;

// Ordem respeita as FKs sem ON DELETE CASCADE (ex.: payment_attempts.order_id,
// appointments.professional_id RESTRICT, silence_hook_jobs.order_id).
const DELETE_STEPS = [
  // Pagamentos e pedidos. Eventos de webhook não têm FK; a correlação usa os
  // IDs do Pagar.me capturados antes de apagar pedidos e tentativas.
  ["payment_webhook_events", `
    WITH refs AS (
      SELECT pagarme_order_id, pagarme_charge_id FROM orders WHERE company_id = $1
      UNION
      SELECT pa.pagarme_order_id, pa.pagarme_charge_id
        FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id
       WHERE o.company_id = $1
    )
    DELETE FROM payment_webhook_events pwe
     WHERE pwe.provider = 'pagarme'
       AND EXISTS (
         SELECT 1 FROM refs ref
          WHERE (
              NULLIF(ref.pagarme_order_id, '') IS NOT NULL
              AND ref.pagarme_order_id IN (
                pwe.payload #>> '{data,id}',
                pwe.payload #>> '{data,order_id}',
                pwe.payload #>> '{data,order,id}',
                pwe.payload #>> '{data,charge,order_id}',
                pwe.payload #>> '{data,charges,0,order_id}',
                pwe.payload #>> '{data,order,charges,0,order_id}'
              )
            )
            OR (
              NULLIF(ref.pagarme_charge_id, '') IS NOT NULL
              AND ref.pagarme_charge_id IN (
                pwe.payload #>> '{data,id}',
                pwe.payload #>> '{data,charge,id}',
                pwe.payload #>> '{data,charges,0,id}',
                pwe.payload #>> '{data,order,charges,0,id}'
              )
            )
       )`],
  ["payment_attempts", `DELETE FROM payment_attempts WHERE order_id IN (${ORDERS})`],
  ["silence_hook_jobs", `DELETE FROM silence_hook_jobs
    WHERE company_id = $1 OR order_id IN (${ORDERS})`],
  // appointment_photos sai em cascata.
  ["appointments", `DELETE FROM appointments
    WHERE company_id = $1 OR order_id IN (${ORDERS}) OR professional_id IN (${PROFESSIONALS})`],
  ["order_reviews", `DELETE FROM order_reviews
    WHERE company_id = $1 OR order_id IN (${ORDERS}) OR client_id IN (${CLIENTS})`],
  ["coupon_redemptions", `DELETE FROM coupon_redemptions
    WHERE order_id IN (${ORDERS})
       OR coupon_id IN (SELECT id FROM coupons WHERE company_id = $1)
       OR client_id IN (${CLIENTS})`],
  ["customer_tracking_sessions", `DELETE FROM customer_tracking_sessions
    WHERE company_id = $1 OR order_id IN (${ORDERS}) OR customer_id IN (${CLIENTS})`],
  ["delivery_route_orders", `DELETE FROM delivery_route_orders
    WHERE order_id IN (${ORDERS})
       OR route_id IN (SELECT id FROM delivery_routes WHERE company_id = $1)`],
  ["order_item_options", `DELETE FROM order_item_options
    WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${ORDERS}))`],
  ["order_status_history", `DELETE FROM order_status_history WHERE order_id IN (${ORDERS})`],
  ["order_messages", `DELETE FROM order_messages
    WHERE company_id = $1 OR order_id IN (${ORDERS})`],
  ["merchant_notifications", `DELETE FROM merchant_notifications
    WHERE company_id = $1 OR order_id IN (${ORDERS}) OR subscription_id IN (${SUBSCRIPTIONS})`],
  ["order_items", `DELETE FROM order_items WHERE order_id IN (${ORDERS})`],
  ["orders", "DELETE FROM orders WHERE company_id = $1"],

  // Assinaturas (canceladas no Pagar.me depois do COMMIT).
  ["subscription_invoices", `DELETE FROM subscription_invoices
    WHERE subscription_id IN (${SUBSCRIPTIONS})`],
  ["customer_subscriptions", `DELETE FROM customer_subscriptions WHERE id IN (${SUBSCRIPTIONS})`],

  // Campanhas, cardápio, promoções, upsell e serviços.
  ["campaign_clients", `DELETE FROM campaign_clients
    WHERE campaign_id IN (SELECT id FROM campaigns WHERE company_id = $1)
       OR client_id IN (${CLIENTS})`],
  ["campaign_products", `DELETE FROM campaign_products
    WHERE campaign_id IN (SELECT id FROM campaigns WHERE company_id = $1)`],
  ["campaigns", "DELETE FROM campaigns WHERE company_id = $1"],
  ["upsell_rule_items", `DELETE FROM upsell_rule_items
    WHERE rule_id IN (SELECT id FROM upsell_rules WHERE company_id = $1)
       OR menu_item_id IN (${MENU_ITEMS})`],
  ["upsell_rules", `DELETE FROM upsell_rules
    WHERE company_id = $1 OR trigger_item_id IN (${MENU_ITEMS})`],
  ["promotion_items", `DELETE FROM promotion_items
    WHERE promotion_id IN (SELECT id FROM promotions WHERE company_id = $1)
       OR menu_item_id IN (${MENU_ITEMS})`],
  ["promotions", "DELETE FROM promotions WHERE company_id = $1"],
  ["purchase_goal_categories", `DELETE FROM purchase_goal_categories
    WHERE purchase_goal_id IN (SELECT id FROM purchase_goals WHERE company_id = $1)`],
  ["purchase_goals", "DELETE FROM purchase_goals WHERE company_id = $1"],
  ["product_option_items", `DELETE FROM product_option_items
    WHERE group_id IN (
      SELECT id FROM product_option_groups
       WHERE company_id = $1 OR product_id IN (${MENU_ITEMS})
    )`],
  ["product_option_groups", `DELETE FROM product_option_groups
    WHERE company_id = $1 OR product_id IN (${MENU_ITEMS})`],
  ["professional_services", `DELETE FROM professional_services WHERE professional_id IN (${PROFESSIONALS})`],
  ["professional_working_hours", `DELETE FROM professional_working_hours WHERE professional_id IN (${PROFESSIONALS})`],
  ["professional_time_off", `DELETE FROM professional_time_off WHERE professional_id IN (${PROFESSIONALS})`],
  ["professionals", "DELETE FROM professionals WHERE company_id = $1"],
  ["menu_item_images", `DELETE FROM menu_item_images WHERE menu_item_id IN (${MENU_ITEMS})`],
  // Fichas técnicas, serviços relacionados e itens inclusos saem em cascata.
  ["menu_items", "DELETE FROM menu_items WHERE company_id = $1"],
  ["menu_categories", "DELETE FROM menu_categories WHERE company_id = $1"],

  // Clientes, entregas, cupons e configurações da empresa.
  ["coupons", "DELETE FROM coupons WHERE company_id = $1"],
  ["clients", "DELETE FROM clients WHERE company_id = $1"],
  ["delivery_routes", "DELETE FROM delivery_routes WHERE company_id = $1"],
  ["delivery_drivers", "DELETE FROM delivery_drivers WHERE company_id = $1"],
  ["payment_methods", "DELETE FROM payment_methods WHERE company_id = $1"],
  ["order_status_notifications", "DELETE FROM order_status_notifications WHERE company_id = $1"],
  ["additional_info", "DELETE FROM additional_info WHERE company_id = $1"],
  ["ai_ignored_phone_numbers", "DELETE FROM ai_ignored_phone_numbers WHERE company_id = $1"],
  ["company_addresses", "DELETE FROM company_addresses WHERE company_id = $1"],
  ["company_opening_hours", "DELETE FROM company_opening_hours WHERE company_id = $1"],
  ["company_preferences", "DELETE FROM company_preferences WHERE company_id = $1"],
  ["addresses", "DELETE FROM addresses WHERE company_id = $1"],

  // WhatsApp, IA e analytics (tabelas sem FK para companies).
  ["n8n_message_queue", "DELETE FROM n8n_message_queue WHERE company_id = $1"],
  ["incoming_messages", "DELETE FROM incoming_messages WHERE company_id = $1"],
  ["conversation_state", "DELETE FROM conversation_state WHERE company_id = $1"],
  ["silence_hook_configs", "DELETE FROM silence_hook_configs WHERE company_id = $1"],
  ["connections", "DELETE FROM connections WHERE company_id = $1"],
  ["ai_usage_turn_providers", `DELETE FROM ai_usage_turn_providers
    WHERE turn_id IN (SELECT id FROM ai_usage_turns WHERE company_id = $1)`],
  ["ai_usage_turns", "DELETE FROM ai_usage_turns WHERE company_id = $1"],
  ["tracking_events", "DELETE FROM tracking_events WHERE company_id = $1"],
  ["search_analytics", "DELETE FROM search_analytics WHERE company_id = $1"],
];

// Usuários do portal sem vínculo com nenhuma outra empresa (nunca admins).
const EXCLUSIVE_USERS_SQL = `
  SELECT DISTINCT u.id
    FROM users u
    JOIN user_companies uc ON uc.user_id = u.id
   WHERE uc.company_id = $1
     AND COALESCE(u.is_system_admin, false) = false
     AND NOT EXISTS (
       SELECT 1 FROM user_companies other
        WHERE other.user_id = u.id AND other.company_id <> $1
     )`;

// Conferência final: nenhuma tabela pode ter sobrado com o company_id excluído.
const _assertNothingLeft = async (client, companyId) => {
  const tables = await client.query(
    `SELECT col.table_name
       FROM information_schema.columns col
       JOIN information_schema.tables t
         ON t.table_schema = col.table_schema
        AND t.table_name = col.table_name
        AND t.table_type = 'BASE TABLE'
      WHERE col.table_schema = 'public' AND col.column_name = 'company_id'`,
  );
  for (const { table_name: table } of tables.rows) {
    const quoted = `"${String(table).replace(/"/g, '""')}"`;
    const res = await client.query(
      `SELECT COUNT(*)::int AS n FROM public.${quoted} WHERE company_id = $1`,
      [companyId],
    );
    if (res.rows[0]?.n > 0) {
      throw _error("LEFTOVER_ROWS", `Restaram ${res.rows[0].n} registro(s) em ${table}`);
    }
  }
};

const _cleanupExternal = async ({ instances, subscriptionIds }, externals) => {
  const failures = [];
  for (const subId of subscriptionIds) {
    try {
      await externals.cancelSubscription(subId);
    } catch (err) {
      failures.push(`Pagar.me assinatura ${subId}: ${err.message}`);
    }
  }
  for (const instance of instances) {
    try {
      await externals.deleteInstance(instance);
    } catch (err) {
      failures.push(`Evolution ${instance}: ${err.message}`);
    }
    try {
      await externals.removeWorkflow(instance);
    } catch (err) {
      failures.push(`n8n ${instance}: ${err.message}`);
    }
  }
  return failures;
};

const DEFAULT_EXTERNALS = {
  cancelSubscription: (id) => pagarmeService.cancelSubscription(id),
  deleteInstance: (instance) => evolution.deleteInstance(instance),
  removeWorkflow: (instance) => n8n.remove(instance),
};

const deleteCompany = async (companyId, confirmName, { db = pool, externals = DEFAULT_EXTERNALS } = {}) => {
  const client = await db.connect();
  let summary;
  let external;
  try {
    await client.query("BEGIN");

    // Bloqueia a empresa contra alterações concorrentes durante a exclusão.
    const companyRes = await client.query(
      "SELECT id, name FROM companies WHERE id = $1 FOR UPDATE",
      [companyId],
    );
    const company = companyRes.rows[0];
    if (!company) throw _error("STORE_NOT_FOUND", "Loja não encontrada");

    const typed = typeof confirmName === "string" ? confirmName.trim() : "";
    if (typed !== expectedConfirmation(company)) {
      throw _error("NAME_MISMATCH", "O nome digitado não confere com o nome da empresa");
    }

    // Capturados antes da exclusão para a limpeza externa pós-COMMIT.
    const connRes = await client.query(
      "SELECT instance_name FROM connections WHERE company_id = $1 AND NULLIF(BTRIM(instance_name), '') IS NOT NULL",
      [companyId],
    );
    const subsRes = await client.query(
      `SELECT pagarme_subscription_id FROM customer_subscriptions
        WHERE id IN (${SUBSCRIPTIONS})
          AND status IN ('pending', 'active', 'paused')
          AND NULLIF(pagarme_subscription_id, '') IS NOT NULL`,
      [companyId],
    );
    external = {
      instances: connRes.rows.map((r) => r.instance_name),
      subscriptionIds: subsRes.rows.map((r) => r.pagarme_subscription_id),
    };

    const usersRes = await client.query(EXCLUSIVE_USERS_SQL, [companyId]);
    const userIds = usersRes.rows.map((r) => r.id);

    const removed = {};
    for (const [table, sql] of DELETE_STEPS) {
      const res = await client.query(sql, [companyId]);
      if (res.rowCount) removed[table] = res.rowCount;
    }

    await client.query("DELETE FROM user_companies WHERE company_id = $1", [companyId]);
    let removedUsers = 0;
    if (userIds.length) {
      await client.query("DELETE FROM logs WHERE user_id = ANY($1::int[])", [userIds]);
      const delUsers = await client.query(
        `DELETE FROM users u
          WHERE u.id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id)`,
        [userIds],
      );
      removedUsers = delUsers.rowCount;
    }

    await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
    await _assertNothingLeft(client, companyId);

    await client.query("COMMIT");
    summary = { id: company.id, name: company.name, removed, removed_users: removedUsers };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const externalFailures = await _cleanupExternal(external, externals);
  return { ...summary, external_failures: externalFailures };
};

module.exports = { deleteCompany, expectedConfirmation, DELETE_STEPS };
