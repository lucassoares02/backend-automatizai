-- Exclusao completa de VARIAS empresas (ex.: empresas de teste) e de tudo que
-- esta relacionado a elas no PostgreSQL.
--
-- COMO USAR:
--   1. Faca backup antes de executar.
--   2. Edite SOMENTE a lista de IDs logo abaixo (ARRAY[...]).
--   3. Execute o arquivo inteiro: psql "$DATABASE_URL" -f DELETE_COMPANIES.sql
--
-- O script roda em uma unica transacao: se qualquer passo falhar (ID
-- inexistente, FK inesperada etc.), nada e alterado.
--
-- Tambem remove os usuarios do portal (tabela users) que pertenciam SOMENTE
-- as empresas excluidas. Administradores do sistema e usuarios com vinculo a
-- outra empresa sao preservados. Identidades globais de clientes
-- (platform_users) sao compartilhadas entre empresas e nao sao removidas.
--
-- Nao remove: arquivos no MinIO/CDN (as URLs sao listadas na saida), workflows
-- do n8n, instancias da Evolution e cadastros no Pagar.me/Stripe/iFood.

BEGIN;

CREATE TEMP TABLE _del_companies ON COMMIT DROP AS
SELECT DISTINCT unnest(
  -- >>>>>>>>>> EDITE AQUI: IDs das empresas a excluir <<<<<<<<<<
  ARRAY[0]::integer[]
) AS id;

-- Validacao: lista nao vazia e todos os IDs existentes.
DO $$
DECLARE
  missing integer[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _del_companies WHERE id > 0) THEN
    RAISE EXCEPTION 'Informe ao menos um ID de empresa valido na lista.';
  END IF;

  SELECT array_agg(d.id ORDER BY d.id) INTO missing
  FROM _del_companies d
  WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = d.id);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Empresas nao encontradas: %. Nenhum dado foi alterado.', missing;
  END IF;
END $$;

-- Bloqueia as empresas contra alteracoes concorrentes.
SELECT c.id FROM companies c JOIN _del_companies d ON d.id = c.id FOR UPDATE;

-- Empresas que serao excluidas.
SELECT c.id, c.name, c.slug, c.uuid,
       c.pagarme_recipient_id, c.stripe_account_id, c.ifood_merchant_id
FROM companies c JOIN _del_companies d ON d.id = c.id
ORDER BY c.id;

-- ---------------------------------------------------------------------------
-- Conjuntos auxiliares (capturados antes de qualquer exclusao)
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _del_orders ON COMMIT DROP AS
SELECT o.id, o.pagarme_order_id, o.pagarme_charge_id
FROM orders o JOIN _del_companies d ON d.id = o.company_id;

CREATE TEMP TABLE _del_payment_refs ON COMMIT DROP AS
SELECT pagarme_order_id, pagarme_charge_id FROM _del_orders
UNION
SELECT pa.pagarme_order_id, pa.pagarme_charge_id
FROM payment_attempts pa JOIN _del_orders o ON o.id = pa.order_id;

CREATE TEMP TABLE _del_clients ON COMMIT DROP AS
SELECT cl.id FROM clients cl JOIN _del_companies d ON d.id = cl.company_id;

CREATE TEMP TABLE _del_coupons ON COMMIT DROP AS
SELECT cp.id FROM coupons cp JOIN _del_companies d ON d.id = cp.company_id;

CREATE TEMP TABLE _del_delivery_routes ON COMMIT DROP AS
SELECT dr.id FROM delivery_routes dr JOIN _del_companies d ON d.id = dr.company_id;

CREATE TEMP TABLE _del_campaigns ON COMMIT DROP AS
SELECT ca.id FROM campaigns ca JOIN _del_companies d ON d.id = ca.company_id;

CREATE TEMP TABLE _del_option_groups ON COMMIT DROP AS
SELECT pog.id
FROM product_option_groups pog
WHERE pog.company_id IN (SELECT id FROM _del_companies)
   OR pog.product_id IN (
     SELECT mi.id FROM menu_items mi JOIN _del_companies d ON d.id = mi.company_id
   );

CREATE TEMP TABLE _del_promotions ON COMMIT DROP AS
SELECT pr.id FROM promotions pr JOIN _del_companies d ON d.id = pr.company_id;

CREATE TEMP TABLE _del_purchase_goals ON COMMIT DROP AS
SELECT pg.id FROM purchase_goals pg JOIN _del_companies d ON d.id = pg.company_id;

CREATE TEMP TABLE _del_upsell_rules ON COMMIT DROP AS
SELECT ur.id FROM upsell_rules ur JOIN _del_companies d ON d.id = ur.company_id;

CREATE TEMP TABLE _del_professionals ON COMMIT DROP AS
SELECT p.id FROM professionals p JOIN _del_companies d ON d.id = p.company_id;

CREATE TEMP TABLE _del_ai_turns ON COMMIT DROP AS
SELECT t.id FROM ai_usage_turns t JOIN _del_companies d ON d.id = t.company_id;

-- Usuarios do portal sem vinculo com nenhuma empresa fora da lista.
CREATE TEMP TABLE _del_users ON COMMIT DROP AS
SELECT DISTINCT u.id, u.email
FROM users u
JOIN user_companies uc ON uc.user_id = u.id
JOIN _del_companies d ON d.id = uc.company_id
WHERE COALESCE(u.is_system_admin, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM user_companies other
    WHERE other.user_id = u.id
      AND other.company_id NOT IN (SELECT id FROM _del_companies)
  );

-- Arquivos que continuarao no armazenamento externo (limpeza manual).
SELECT 'companies.logo_url' AS source, c.logo_url AS url
FROM companies c JOIN _del_companies d ON d.id = c.id
WHERE NULLIF(BTRIM(c.logo_url), '') IS NOT NULL
UNION ALL
SELECT 'companies.banner_url', c.banner_url
FROM companies c JOIN _del_companies d ON d.id = c.id
WHERE NULLIF(BTRIM(c.banner_url), '') IS NOT NULL
UNION ALL
SELECT 'menu_items.image_url', mi.image_url
FROM menu_items mi JOIN _del_companies d ON d.id = mi.company_id
WHERE NULLIF(BTRIM(mi.image_url), '') IS NOT NULL
UNION ALL
SELECT 'menu_item_images.url', mii.url
FROM menu_item_images mii
JOIN menu_items mi ON mi.id = mii.menu_item_id
JOIN _del_companies d ON d.id = mi.company_id
WHERE NULLIF(BTRIM(mii.url), '') IS NOT NULL
UNION ALL
SELECT 'product_option_items.image_url', poi.image_url
FROM product_option_items poi JOIN _del_option_groups g ON g.id = poi.group_id
WHERE NULLIF(BTRIM(poi.image_url), '') IS NOT NULL
UNION ALL
SELECT 'promotions.image_url', pr.image_url
FROM promotions pr JOIN _del_companies d ON d.id = pr.company_id
WHERE NULLIF(BTRIM(pr.image_url), '') IS NOT NULL
UNION ALL
SELECT 'campaigns.image_url', ca.image_url
FROM campaigns ca JOIN _del_companies d ON d.id = ca.company_id
WHERE NULLIF(BTRIM(ca.image_url), '') IS NOT NULL
ORDER BY 1, 2;

-- Conexoes WhatsApp (instancias Evolution / workflows n8n a remover manualmente).
SELECT cn.company_id, cn.id, cn.instance_name, cn.status
FROM connections cn JOIN _del_companies d ON d.id = cn.company_id
ORDER BY cn.company_id, cn.id;

-- Usuarios do portal que serao removidos.
SELECT id, email FROM _del_users ORDER BY email;

-- ---------------------------------------------------------------------------
-- Pagamentos e pedidos
-- ---------------------------------------------------------------------------

-- Eventos de webhook nao possuem FK; a correlacao usa os IDs do Pagar.me.
DELETE FROM payment_webhook_events pwe
WHERE pwe.provider = 'pagarme'
  AND EXISTS (
    SELECT 1
    FROM _del_payment_refs ref
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
  );

DELETE FROM payment_attempts pa USING _del_orders o WHERE pa.order_id = o.id;

-- Agendamentos: antes de pedidos e profissionais (FK RESTRICT em professional_id).
DELETE FROM appointments a
WHERE a.company_id IN (SELECT id FROM _del_companies)
   OR a.order_id IN (SELECT id FROM _del_orders)
   OR a.professional_id IN (SELECT id FROM _del_professionals);

DELETE FROM order_reviews r
WHERE r.company_id IN (SELECT id FROM _del_companies)
   OR r.order_id IN (SELECT id FROM _del_orders)
   OR r.client_id IN (SELECT id FROM _del_clients);

DELETE FROM coupon_redemptions cr
WHERE cr.order_id IN (SELECT id FROM _del_orders)
   OR cr.coupon_id IN (SELECT id FROM _del_coupons)
   OR cr.client_id IN (SELECT id FROM _del_clients);

DELETE FROM customer_tracking_sessions s
WHERE s.company_id IN (SELECT id FROM _del_companies)
   OR s.order_id IN (SELECT id FROM _del_orders)
   OR s.customer_id IN (SELECT id FROM _del_clients);

DELETE FROM delivery_route_orders dro
WHERE dro.order_id IN (SELECT id FROM _del_orders)
   OR dro.route_id IN (SELECT id FROM _del_delivery_routes);

DELETE FROM order_item_options oio
USING order_items oi, _del_orders o
WHERE oio.order_item_id = oi.id AND oi.order_id = o.id;

DELETE FROM order_status_history osh USING _del_orders o WHERE osh.order_id = o.id;

DELETE FROM order_messages om
WHERE om.company_id IN (SELECT id FROM _del_companies)
   OR om.order_id IN (SELECT id FROM _del_orders);

DELETE FROM order_items oi USING _del_orders o WHERE oi.order_id = o.id;

DELETE FROM orders o USING _del_orders d WHERE o.id = d.id;

-- ---------------------------------------------------------------------------
-- Campanhas, cardapio, promocoes, upsell, servicos
-- ---------------------------------------------------------------------------

DELETE FROM campaign_clients cc
WHERE cc.campaign_id IN (SELECT id FROM _del_campaigns)
   OR cc.client_id IN (SELECT id FROM _del_clients);

DELETE FROM campaign_products cp USING _del_campaigns c WHERE cp.campaign_id = c.id;

DELETE FROM campaigns ca USING _del_campaigns c WHERE ca.id = c.id;

DELETE FROM upsell_rule_items uri USING _del_upsell_rules ur WHERE uri.rule_id = ur.id;
DELETE FROM upsell_rules ur USING _del_upsell_rules d WHERE ur.id = d.id;

DELETE FROM promotion_items pi USING _del_promotions p WHERE pi.promotion_id = p.id;
DELETE FROM promotions pr USING _del_promotions d WHERE pr.id = d.id;

DELETE FROM purchase_goal_categories pgc
USING _del_purchase_goals pg WHERE pgc.purchase_goal_id = pg.id;
DELETE FROM purchase_goals pg USING _del_purchase_goals d WHERE pg.id = d.id;

DELETE FROM product_option_items poi USING _del_option_groups g WHERE poi.group_id = g.id;
DELETE FROM product_option_groups pog USING _del_option_groups d WHERE pog.id = d.id;

DELETE FROM professional_services ps USING _del_professionals p WHERE ps.professional_id = p.id;
DELETE FROM professional_working_hours pwh USING _del_professionals p WHERE pwh.professional_id = p.id;
DELETE FROM professional_time_off pto USING _del_professionals p WHERE pto.professional_id = p.id;
DELETE FROM professionals pr USING _del_professionals d WHERE pr.id = d.id;

DELETE FROM menu_item_images mii
USING menu_items mi, _del_companies d
WHERE mii.menu_item_id = mi.id AND mi.company_id = d.id;

DELETE FROM menu_items mi USING _del_companies d WHERE mi.company_id = d.id;
DELETE FROM menu_categories mc USING _del_companies d WHERE mc.company_id = d.id;

-- ---------------------------------------------------------------------------
-- Clientes, entregas, cupons e configuracoes da empresa
-- ---------------------------------------------------------------------------

DELETE FROM coupons cp USING _del_coupons d WHERE cp.id = d.id;
DELETE FROM clients cl USING _del_clients d WHERE cl.id = d.id;

DELETE FROM delivery_routes dr USING _del_delivery_routes d WHERE dr.id = d.id;
DELETE FROM delivery_drivers dd USING _del_companies d WHERE dd.company_id = d.id;

DELETE FROM payment_methods pm USING _del_companies d WHERE pm.company_id = d.id;
DELETE FROM order_status_notifications osn USING _del_companies d WHERE osn.company_id = d.id;
DELETE FROM additional_info ai USING _del_companies d WHERE ai.company_id = d.id;
DELETE FROM ai_ignored_phone_numbers aip USING _del_companies d WHERE aip.company_id = d.id;
DELETE FROM company_addresses ca USING _del_companies d WHERE ca.company_id = d.id;
DELETE FROM company_opening_hours coh USING _del_companies d WHERE coh.company_id = d.id;
DELETE FROM company_preferences cp USING _del_companies d WHERE cp.company_id = d.id;
DELETE FROM addresses a USING _del_companies d WHERE a.company_id = d.id;

-- ---------------------------------------------------------------------------
-- WhatsApp, IA e analytics (tabelas sem FK para companies)
-- ---------------------------------------------------------------------------

DELETE FROM n8n_message_queue q USING _del_companies d WHERE q.company_id = d.id;
DELETE FROM incoming_messages im USING _del_companies d WHERE im.company_id = d.id;
DELETE FROM connections cn USING _del_companies d WHERE cn.company_id = d.id;

DELETE FROM ai_usage_turn_providers tp USING _del_ai_turns t WHERE tp.turn_id = t.id;
DELETE FROM ai_usage_turns t USING _del_ai_turns d WHERE t.id = d.id;

DELETE FROM tracking_events e USING _del_companies d WHERE e.company_id = d.id;
DELETE FROM search_analytics sa USING _del_companies d WHERE sa.company_id = d.id;

-- ---------------------------------------------------------------------------
-- Usuarios e a propria empresa
-- ---------------------------------------------------------------------------

DELETE FROM user_companies uc USING _del_companies d WHERE uc.company_id = d.id;

DELETE FROM logs l USING _del_users u WHERE l.user_id = u.id;

DELETE FROM users u
USING _del_users d
WHERE u.id = d.id
  AND NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id);

DELETE FROM companies c USING _del_companies d WHERE c.id = d.id;

-- Conferencia final: nada pode ter sobrado com company_id das empresas excluidas.
DO $$
DECLARE
  r record;
  leftover bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM companies c JOIN _del_companies d ON d.id = c.id) THEN
    RAISE EXCEPTION 'Alguma empresa ainda existe; a transacao sera revertida.';
  END IF;

  FOR r IN
    SELECT col.table_name
    FROM information_schema.columns col
    JOIN information_schema.tables t
      ON t.table_schema = col.table_schema
     AND t.table_name = col.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE col.table_schema = 'public'
      AND col.column_name = 'company_id'
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM public.%I WHERE company_id IN (SELECT id FROM _del_companies)',
      r.table_name
    ) INTO leftover;

    IF leftover > 0 THEN
      RAISE EXCEPTION 'Restaram % registro(s) em %; a transacao sera revertida.',
        leftover, r.table_name;
    END IF;
  END LOOP;
END $$;

SELECT 'Empresas excluidas: ' || string_agg(id::text, ', ' ORDER BY id) AS result
FROM _del_companies;

COMMIT;
