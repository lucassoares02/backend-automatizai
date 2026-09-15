-- Exclusao completa dos dados locais de UMA empresa.
--
-- IMPORTANTE:
--   1. Faca backup antes de executar.
--   2. Preencha company_id abaixo.
--   3. Execute primeiro com confirm_delete = false e ROLLBACK para revisar a previa.
--   4. Para excluir de fato, altere confirm_delete para true, troque ROLLBACK por
--      COMMIT no fim do arquivo e execute novamente.
--   5. delete_orphan_users remove somente usuarios que pertenciam exclusivamente
--      a esta empresa. Administradores do sistema nunca sao removidos.
--
-- Este script remove dados do PostgreSQL. Arquivos no MinIO e cadastros externos
-- (Pagar.me, Stripe, iFood e Evolution) precisam ser removidos separadamente.

BEGIN;

CREATE TEMP TABLE _company_delete_parameters (
  company_id integer PRIMARY KEY,
  confirm_delete boolean NOT NULL,
  delete_orphan_users boolean NOT NULL
) ON COMMIT DROP;

-- PREENCHA AQUI O ID DA EMPRESA.
INSERT INTO _company_delete_parameters (
  company_id,
  confirm_delete,
  delete_orphan_users
)
VALUES (
  0,     -- company_id: substitua 0 pelo ID real
  false, -- true autoriza a exclusao
  false  -- true remove usuarios sem vinculo com outra empresa
);

DO $$
DECLARE
  target_id integer;
  target_count integer;
BEGIN
  SELECT company_id INTO target_id
  FROM _company_delete_parameters;

  IF target_id IS NULL OR target_id <= 0 THEN
    RAISE EXCEPTION 'Informe um company_id inteiro e maior que zero.';
  END IF;

  SELECT COUNT(*) INTO target_count
  FROM companies
  WHERE id = target_id;

  IF target_count <> 1 THEN
    RAISE EXCEPTION 'Empresa % nao encontrada. Nenhum dado foi alterado.', target_id;
  END IF;
END $$;

CREATE TEMP TABLE _company_delete_target ON COMMIT DROP AS
SELECT
  c.id,
  c.uuid,
  c.slug,
  c.name,
  c.logo_url,
  c.banner_url,
  c.stripe_account_id,
  c.pagarme_recipient_id,
  c.ifood_merchant_id
FROM companies c
JOIN _company_delete_parameters p ON p.company_id = c.id;

-- Bloqueia a empresa alvo contra alteracoes concorrentes durante a exclusao.
SELECT c.id
FROM companies c
JOIN _company_delete_target t ON t.id = c.id
FOR UPDATE;

CREATE TEMP TABLE _company_target_orders ON COMMIT DROP AS
SELECT
  o.id,
  o.pagarme_order_id,
  o.pagarme_charge_id
FROM orders o
JOIN _company_delete_target c ON c.id = o.company_id;

CREATE TEMP TABLE _company_payment_refs ON COMMIT DROP AS
SELECT pagarme_order_id, pagarme_charge_id
FROM _company_target_orders
UNION
SELECT pa.pagarme_order_id, pa.pagarme_charge_id
FROM payment_attempts pa
JOIN _company_target_orders o ON o.id = pa.order_id;

CREATE TEMP TABLE _company_target_clients ON COMMIT DROP AS
SELECT cl.id
FROM clients cl
JOIN _company_delete_target c ON c.id = cl.company_id;

CREATE TEMP TABLE _company_target_menu_items ON COMMIT DROP AS
SELECT mi.id
FROM menu_items mi
JOIN _company_delete_target c ON c.id = mi.company_id;

CREATE TEMP TABLE _company_target_campaigns ON COMMIT DROP AS
SELECT ca.id
FROM campaigns ca
JOIN _company_delete_target c ON c.id = ca.company_id;

CREATE TEMP TABLE _company_target_coupons ON COMMIT DROP AS
SELECT cp.id
FROM coupons cp
JOIN _company_delete_target c ON c.id = cp.company_id;

CREATE TEMP TABLE _company_target_delivery_routes ON COMMIT DROP AS
SELECT dr.id
FROM delivery_routes dr
JOIN _company_delete_target c ON c.id = dr.company_id;

CREATE TEMP TABLE _company_target_option_groups ON COMMIT DROP AS
SELECT pog.id
FROM product_option_groups pog
JOIN _company_delete_target c ON c.id = pog.company_id;

CREATE TEMP TABLE _company_target_promotions ON COMMIT DROP AS
SELECT pr.id
FROM promotions pr
JOIN _company_delete_target c ON c.id = pr.company_id;

CREATE TEMP TABLE _company_target_purchase_goals ON COMMIT DROP AS
SELECT pg.id
FROM purchase_goals pg
JOIN _company_delete_target c ON c.id = pg.company_id;

CREATE TEMP TABLE _company_target_upsell_rules ON COMMIT DROP AS
SELECT ur.id
FROM upsell_rules ur
JOIN _company_delete_target c ON c.id = ur.company_id;

CREATE TEMP TABLE _company_target_users ON COMMIT DROP AS
SELECT DISTINCT u.id, u.email
FROM users u
JOIN user_companies uc ON uc.user_id = u.id
JOIN _company_delete_target c ON c.id = uc.company_id;

-- Usuarios que podem ser removidos opcionalmente: nao sao administradores e
-- nao possuem vinculo com nenhuma outra empresa.
CREATE TEMP TABLE _company_orphan_users ON COMMIT DROP AS
SELECT tu.id, tu.email
FROM _company_target_users tu
JOIN users u ON u.id = tu.id
WHERE u.is_system_admin = false
  AND NOT EXISTS (
    SELECT 1
    FROM user_companies uc
    JOIN _company_delete_target c ON c.id <> uc.company_id
    WHERE uc.user_id = tu.id
  );

-- URLs sao exibidas na previa para permitir a limpeza manual do MinIO/CDN.
CREATE TEMP TABLE _company_asset_urls ON COMMIT DROP AS
SELECT 'company.logo_url'::text AS source, logo_url AS url
FROM _company_delete_target
WHERE NULLIF(BTRIM(logo_url), '') IS NOT NULL
UNION ALL
SELECT 'company.banner_url', banner_url
FROM _company_delete_target
WHERE NULLIF(BTRIM(banner_url), '') IS NOT NULL
UNION ALL
SELECT 'menu_items.image_url', mi.image_url
FROM menu_items mi
JOIN _company_delete_target c ON c.id = mi.company_id
WHERE NULLIF(BTRIM(mi.image_url), '') IS NOT NULL
UNION ALL
SELECT 'product_option_items.image_url', poi.image_url
FROM product_option_items poi
JOIN _company_target_option_groups g ON g.id = poi.group_id
WHERE NULLIF(BTRIM(poi.image_url), '') IS NOT NULL
UNION ALL
SELECT 'promotions.image_url', pr.image_url
FROM promotions pr
JOIN _company_delete_target c ON c.id = pr.company_id
WHERE NULLIF(BTRIM(pr.image_url), '') IS NOT NULL
UNION ALL
SELECT 'campaigns.image_url', ca.image_url
FROM campaigns ca
JOIN _company_delete_target c ON c.id = ca.company_id
WHERE NULLIF(BTRIM(ca.image_url), '') IS NOT NULL;

-- PREVIA: confirme cuidadosamente nome, UUID, slug e integracoes externas.
SELECT
  id,
  uuid,
  slug,
  name,
  stripe_account_id,
  pagarme_recipient_id,
  ifood_merchant_id
FROM _company_delete_target;

-- PREVIA: quantidade dos principais registros que serao removidos.
SELECT resource, row_count
FROM (
  VALUES
    ('additional_info', (SELECT COUNT(*) FROM additional_info WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('addresses', (SELECT COUNT(*) FROM addresses WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('ai_ignored_phone_numbers', (SELECT COUNT(*) FROM ai_ignored_phone_numbers WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('campaigns', (SELECT COUNT(*) FROM campaigns WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('clients', (SELECT COUNT(*) FROM clients WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('company_addresses', (SELECT COUNT(*) FROM company_addresses WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('company_opening_hours', (SELECT COUNT(*) FROM company_opening_hours WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('company_preferences', (SELECT COUNT(*) FROM company_preferences WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('connections', (SELECT COUNT(*) FROM connections WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('coupons', (SELECT COUNT(*) FROM coupons WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('customer_tracking_sessions', (SELECT COUNT(*) FROM customer_tracking_sessions WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('delivery_drivers', (SELECT COUNT(*) FROM delivery_drivers WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('delivery_routes', (SELECT COUNT(*) FROM delivery_routes WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('incoming_messages', (SELECT COUNT(*) FROM incoming_messages WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('menu_categories', (SELECT COUNT(*) FROM menu_categories WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('menu_items', (SELECT COUNT(*) FROM menu_items WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('n8n_message_queue', (SELECT COUNT(*) FROM n8n_message_queue WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('order_messages', (SELECT COUNT(*) FROM order_messages WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('order_status_notifications', (SELECT COUNT(*) FROM order_status_notifications WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('orders', (SELECT COUNT(*) FROM orders WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('payment_methods', (SELECT COUNT(*) FROM payment_methods WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('product_option_groups', (SELECT COUNT(*) FROM product_option_groups WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('promotions', (SELECT COUNT(*) FROM promotions WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('purchase_goals', (SELECT COUNT(*) FROM purchase_goals WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('search_analytics', (SELECT COUNT(*) FROM search_analytics WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('tracking_events', (SELECT COUNT(*) FROM tracking_events WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('upsell_rules', (SELECT COUNT(*) FROM upsell_rules WHERE company_id = (SELECT id FROM _company_delete_target))),
    ('user_companies', (SELECT COUNT(*) FROM user_companies WHERE company_id = (SELECT id FROM _company_delete_target)))
) AS counts(resource, row_count)
ORDER BY resource;

-- PREVIA: arquivos que continuarao existindo no armazenamento externo.
SELECT source, url
FROM _company_asset_urls
ORDER BY source, url;

-- PREVIA: usuarios vinculados. orphan_if_company_is_deleted indica quem pode
-- ser removido quando delete_orphan_users = true.
SELECT
  tu.id,
  tu.email,
  EXISTS (SELECT 1 FROM _company_orphan_users ou WHERE ou.id = tu.id)
    AS orphan_if_company_is_deleted
FROM _company_target_users tu
ORDER BY tu.email;

DO $$
BEGIN
  IF NOT (SELECT confirm_delete FROM _company_delete_parameters) THEN
    RAISE EXCEPTION
      'Modo de previa: confirm_delete=false. Nenhum dado foi removido. Execute ROLLBACK, revise a previa e habilite a confirmacao.';
  END IF;
END $$;

-- Eventos de webhook nao possuem FK para pedidos. A correlacao usa os IDs do
-- pedido e da cobranca armazenados antes da exclusao.
DELETE FROM payment_webhook_events pwe
WHERE pwe.provider = 'pagarme'
  AND EXISTS (
    SELECT 1
    FROM _company_payment_refs ref
    WHERE
      (
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
      OR
      (
        NULLIF(ref.pagarme_charge_id, '') IS NOT NULL
        AND ref.pagarme_charge_id IN (
          pwe.payload #>> '{data,id}',
          pwe.payload #>> '{data,charge,id}',
          pwe.payload #>> '{data,charges,0,id}',
          pwe.payload #>> '{data,order,charges,0,id}'
        )
      )
  );

-- Dependencias de pedidos que bloqueiam ou antecedem a exclusao dos pais.
DELETE FROM payment_attempts pa
USING _company_target_orders o
WHERE pa.order_id = o.id;

DELETE FROM order_item_options oio
USING order_items oi, _company_target_orders o
WHERE oio.order_item_id = oi.id
  AND oi.order_id = o.id;

DELETE FROM order_status_history osh
USING _company_target_orders o
WHERE osh.order_id = o.id;

DELETE FROM order_messages om
USING _company_delete_target c
WHERE om.company_id = c.id
   OR EXISTS (
     SELECT 1 FROM _company_target_orders o WHERE o.id = om.order_id
   );

DELETE FROM delivery_route_orders dro
WHERE EXISTS (
    SELECT 1 FROM _company_target_orders o WHERE o.id = dro.order_id
  )
  OR EXISTS (
    SELECT 1 FROM _company_target_delivery_routes r WHERE r.id = dro.route_id
  );

DELETE FROM coupon_redemptions cr
WHERE EXISTS (
    SELECT 1 FROM _company_target_orders o WHERE o.id = cr.order_id
  )
  OR EXISTS (
    SELECT 1 FROM _company_target_coupons c WHERE c.id = cr.coupon_id
  )
  OR EXISTS (
    SELECT 1 FROM _company_target_clients c WHERE c.id = cr.client_id
  );

DELETE FROM order_items oi
USING _company_target_orders o
WHERE oi.order_id = o.id;

DELETE FROM orders o
USING _company_delete_target c
WHERE o.company_id = c.id;

-- Dependencias de campanhas, cardapio, promocoes e upsell.
DELETE FROM campaign_clients cc
WHERE EXISTS (
    SELECT 1 FROM _company_target_campaigns c WHERE c.id = cc.campaign_id
  )
  OR EXISTS (
    SELECT 1 FROM _company_target_clients c WHERE c.id = cc.client_id
  );

DELETE FROM campaign_products cp
USING _company_target_campaigns c
WHERE cp.campaign_id = c.id;

DELETE FROM purchase_goal_categories pgc
USING _company_target_purchase_goals pg
WHERE pgc.purchase_goal_id = pg.id;

DELETE FROM product_option_items poi
USING _company_target_option_groups pog
WHERE poi.group_id = pog.id;

DELETE FROM promotion_items pi
USING _company_target_promotions p
WHERE pi.promotion_id = p.id;

DELETE FROM upsell_rule_items uri
USING _company_target_upsell_rules ur
WHERE uri.rule_id = ur.id;

-- Filas e mensagens nao possuem chaves estrangeiras para companies.
DELETE FROM n8n_message_queue q
USING _company_delete_target c
WHERE q.company_id = c.id;

DELETE FROM incoming_messages im
USING _company_delete_target c
WHERE im.company_id = c.id;

-- Dados diretamente pertencentes a empresa.
DELETE FROM customer_tracking_sessions s
USING _company_delete_target c
WHERE s.company_id = c.id;

DELETE FROM tracking_events e
USING _company_delete_target c
WHERE e.company_id = c.id;

DELETE FROM search_analytics sa
USING _company_delete_target c
WHERE sa.company_id = c.id;

DELETE FROM campaigns ca
USING _company_delete_target c
WHERE ca.company_id = c.id;

DELETE FROM coupons cp
USING _company_delete_target c
WHERE cp.company_id = c.id;

DELETE FROM delivery_routes dr
USING _company_delete_target c
WHERE dr.company_id = c.id;

DELETE FROM delivery_drivers dd
USING _company_delete_target c
WHERE dd.company_id = c.id;

DELETE FROM promotions pr
USING _company_delete_target c
WHERE pr.company_id = c.id;

DELETE FROM purchase_goals pg
USING _company_delete_target c
WHERE pg.company_id = c.id;

DELETE FROM upsell_rules ur
USING _company_delete_target c
WHERE ur.company_id = c.id;

DELETE FROM product_option_groups pog
USING _company_delete_target c
WHERE pog.company_id = c.id;

DELETE FROM menu_items mi
USING _company_delete_target c
WHERE mi.company_id = c.id;

DELETE FROM menu_categories mc
USING _company_delete_target c
WHERE mc.company_id = c.id;

DELETE FROM clients cl
USING _company_delete_target c
WHERE cl.company_id = c.id;

DELETE FROM payment_methods pm
USING _company_delete_target c
WHERE pm.company_id = c.id;

DELETE FROM order_status_notifications osn
USING _company_delete_target c
WHERE osn.company_id = c.id;

DELETE FROM additional_info ai
USING _company_delete_target c
WHERE ai.company_id = c.id;

DELETE FROM ai_ignored_phone_numbers aip
USING _company_delete_target c
WHERE aip.company_id = c.id;

DELETE FROM company_addresses ca
USING _company_delete_target c
WHERE ca.company_id = c.id;

DELETE FROM company_opening_hours coh
USING _company_delete_target c
WHERE coh.company_id = c.id;

-- Estas tabelas nao possuem FK com ON DELETE CASCADE na base atual.
DELETE FROM company_preferences cp
USING _company_delete_target c
WHERE cp.company_id = c.id;

DELETE FROM addresses a
USING _company_delete_target c
WHERE a.company_id = c.id;

DELETE FROM connections cn
USING _company_delete_target c
WHERE cn.company_id = c.id;

-- Remove os vinculos antes da empresa. Contas compartilhadas sao preservadas.
DELETE FROM user_companies uc
USING _company_delete_target c
WHERE uc.company_id = c.id;

DELETE FROM companies c
USING _company_delete_target target
WHERE c.id = target.id;

-- Opcional: remove contas administrativas que ficaram sem qualquer empresa.
DELETE FROM logs l
USING _company_orphan_users ou, _company_delete_parameters p
WHERE p.delete_orphan_users = true
  AND l.user_id = ou.id;

DELETE FROM users u
USING _company_orphan_users ou, _company_delete_parameters p
WHERE p.delete_orphan_users = true
  AND u.id = ou.id
  AND NOT EXISTS (
    SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM companies c
    JOIN _company_delete_target target ON target.id = c.id
  ) THEN
    RAISE EXCEPTION 'A empresa ainda existe; a transacao sera revertida.';
  END IF;
END $$;

SELECT
  id AS deleted_company_id,
  name AS deleted_company_name,
  'Exclusao preparada. Confirme a transacao no fim do arquivo.' AS result
FROM _company_delete_target;

-- MODO SEGURO PADRAO: nenhuma exclusao e persistida.
ROLLBACK;

-- Para a exclusao definitiva, com backup ja realizado, comente o ROLLBACK
-- acima e descomente a linha abaixo:
-- COMMIT;
