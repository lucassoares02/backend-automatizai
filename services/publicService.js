const axios = require("axios");
const pool = require("../db");
const productOptionsService = require("./productOptionsService");
const purchaseGoalsService = require("./purchaseGoalsService");
const stripeService = require("./stripeService");
const pagarmeService = require("./pagarmeService");
const ordersService = require("./ordersService");
const campaignsService = require("./campaignsService");
const identityService = require("./identityService");
const { normalizePhone } = require("../helpers/phone");
const { generateUniqueOrderTag } = require("../helpers/orderTag");
const { columnExists, tableExists } = require("../helpers/schema");

const MAPS_KEY = process.env.GOOGLE_API_KEY;

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// company_opening_hours.weekday segue a convenção do portal: 1=segunda … 7=domingo.
// JS Date.getDay() usa 0=domingo … 6=sábado. Segunda–sábado coincidem (1–6); só o
// DOMINGO diverge (getDay()=0 vs weekday=7). Este helper casa a linha do dia atual
// de forma robusta às duas convenções (aceita domingo como 0 OU 7) — antes a loja
// aparecia sempre FECHADA aos domingos.
const _isTodayWeekday = (rowWeekday, jsDay) => {
  const wd = Number(rowWeekday);
  if (jsDay === 0) return wd === 0 || wd === 7; // domingo
  return wd === jsDay; // segunda(1) … sábado(6)
};

const _buildAddressLine = (row) => {
  if (!row) return null;
  const parts = [];
  const street = row.street || null;
  const number = row.number || null;
  if (street) {
    parts.push(number ? `${street}, ${number}` : street);
  }
  if (row.neighborhood) parts.push(row.neighborhood);
  if (row.city) parts.push(row.city);
  if (row.state) parts.push(row.state);
  if (row.zip_code) parts.push(row.zip_code);
  return parts.length ? parts.join(", ") : null;
};

// Aceita o UUID público da empresa OU o id numérico (retrocompatível com os
// links antigos `/order?company={id}`).
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getCompanyPublicMenu = async (companyRef) => {
  const ref = String(companyRef).trim();
  const byUuid = _UUID_RE.test(ref);
  // accepts_scheduling pode não ter sido migrada; sem a coluna devolve false.
  const hasScheduling = await columnExists("companies", "accepts_scheduling");
  const schedulingCol = hasScheduling ? "accepts_scheduling," : "false AS accepts_scheduling,";
  const companyRes = await pool.query(
    `SELECT id, uuid, name, description, phone, status, manual_open,
            logo_url, banner_url, brand_color,
            accepts_delivery, accepts_pickup, ${schedulingCol}
            cuisine_type, dietary_restrictions, custom_dietary_restrictions,
            stripe_account_id, stripe_charges_enabled,
            pagarme_recipient_id, pagarme_charges_enabled
     FROM companies WHERE ${byUuid ? "uuid = $1" : "id = $1"}`,
    [ref],
  );
  const company = companyRes.rows[0];
  if (!company) return null;

  // A partir daqui todas as subconsultas usam o id numérico resolvido.
  const companyId = company.id;

  // Self-heal do status Stripe: a conta está conectada mas ainda marcada como
  // não habilitada localmente. Isso acontece quando o webhook `account.updated`
  // não chegou (ex.: ambiente sem endpoint público / localhost). Sincroniza sob
  // demanda com a Stripe — só ocorre enquanto a conta está pendente; assim que
  // `charges_enabled` vira true, a coluna é persistida e esta chamada não repete.
  let stripeEnabled = company.stripe_charges_enabled === true;
  if (!stripeEnabled && company.stripe_account_id) {
    try {
      const status = await stripeService.refreshAccountStatus(companyId);
      stripeEnabled = status.charges_enabled === true;
    } catch (_) {
      // Falha ao sincronizar com a Stripe não deve derrubar o menu público.
    }
  }

  // Pagar.me (provedor online atual — substitui a Stripe). Mesmo self-heal: se o
  // recebedor existe mas ainda não está marcado como habilitado localmente,
  // sincroniza sob demanda com o Pagar.me.
  let pagarmeEnabled = company.pagarme_charges_enabled === true;
  if (!pagarmeEnabled && company.pagarme_recipient_id) {
    try {
      const status = await pagarmeService.refreshRecipientStatus(companyId);
      pagarmeEnabled = status.charges_enabled === true;
    } catch (_) {
      // Falha ao sincronizar com o Pagar.me não deve derrubar o menu público.
    }
  }

  const hoursRes = await pool.query(
    "SELECT weekday, opens_at, closes_at, is_closed FROM company_opening_hours WHERE company_id = $1 ORDER BY weekday",
    [companyId],
  );

  const now = new Date();
  const weekday = now.getDay(); // 0=Sun…6=Sat
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayHours = hoursRes.rows.find((h) => _isTodayWeekday(h.weekday, weekday));

  let scheduleOpen = false;
  if (todayHours && !todayHours.is_closed) {
    const [oh, om] = String(todayHours.opens_at).split(":").map(Number);
    const [ch, cm] = String(todayHours.closes_at).split(":").map(Number);
    scheduleOpen = currentMinutes >= oh * 60 + om && currentMinutes <= ch * 60 + cm;
  }
  // Override manual (companies.manual_open): TRUE/FALSE forçam; NULL segue horário.
  const isOpen = company.manual_open === true || company.manual_open === false ? company.manual_open : scheduleOpen;

  // Selos do produto: só seleciona a coluna se ela já existir (a migration em
  // DB_CHANGES_NEEDED.md pode não ter sido aplicada). Sem ela, devolve array vazio.
  const hasItemSelos = await columnExists("menu_items", "dietary_restrictions");
  const selosSelect = hasItemSelos
    ? "mi.dietary_restrictions,"
    : "NULL::text[] AS dietary_restrictions,";

  const menuRes = await pool.query(
    `SELECT mi.id, mi.name, mi.description, mi.price, mi.image_url, mi.category_id,
            mi.prep_time_minutes, mi.featured, ${selosSelect}
            mc.name AS category_name, mc.sort_order AS cat_sort,
            EXISTS(
              SELECT 1 FROM product_option_groups pog
              WHERE pog.product_id = mi.id
            ) AS has_options,
            COALESCE((
              SELECT SUM(oi.quantity)
              FROM order_items oi
              JOIN orders o2 ON o2.id = oi.order_id
              WHERE oi.menu_item_id = mi.id
                AND o2.company_id = mi.company_id
                AND o2.status NOT IN (6, 7)
            ), 0) AS sales_count
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.company_id = $1 AND mi.available = true AND mi.deleted_at IS NULL
     ORDER BY COALESCE(mc.sort_order, 9999), mc.id NULLS LAST, COALESCE(mi.display_order, mi.id)`,
    [companyId],
  );

  // Desconto de campanha ativo: aplica o preço promocional (final_price) no menu
  // público para o cliente ver, mantendo o preço original para o "de/por".
  const activeCampaignPrices = await campaignsService.getActivePricesMap(companyId);
  for (const item of menuRes.rows) {
    const camp = activeCampaignPrices.get(Number(item.id));
    if (camp && camp.final_price < Number(item.price ?? 0)) {
      item.original_price = Number(item.price ?? 0);
      item.campaign_price = camp.final_price;
      item.campaign_discount_percent = camp.discount_percent;
      item.price = camp.final_price; // preço efetivo exibido/cobrado
    }
  }

  const categoriesMap = new Map();
  const uncategorized = [];

  for (const item of menuRes.rows) {
    if (item.category_id) {
      if (!categoriesMap.has(item.category_id)) {
        categoriesMap.set(item.category_id, { id: item.category_id, name: item.category_name, items: [] });
      }
      categoriesMap.get(item.category_id).items.push(item);
    } else {
      uncategorized.push(item);
    }
  }

  const promotionsRes = await pool.query(
    `SELECT p.id, p.name, p.description, p.image_url, p.active,
            p.original_price, p.discount_percent, p.final_price,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', pi.id,
                  'menu_item_id', pi.menu_item_id,
                  'quantity', pi.quantity,
                  'name', mi.name,
                  'price', mi.price,
                  'image_url', mi.image_url,
                  'subtotal', (COALESCE(mi.price, 0) * pi.quantity),
                  'has_options', EXISTS (
                    SELECT 1 FROM product_option_groups pog WHERE pog.product_id = pi.menu_item_id
                  )
                )
                ORDER BY pi.id
              ) FILTER (WHERE pi.id IS NOT NULL),
              '[]'
            ) AS items
     FROM promotions p
     LEFT JOIN promotion_items pi ON pi.promotion_id = p.id
     LEFT JOIN menu_items mi ON mi.id = pi.menu_item_id
     WHERE p.company_id = $1 AND p.active = true
     GROUP BY p.id
     ORDER BY p.updated_at DESC, p.id DESC`,
    [companyId],
  );

  const paymentMethodsRes = await pool.query(
    `SELECT id, type, label, description, active
     FROM payment_methods
     WHERE company_id = $1 AND active = true
     ORDER BY id`,
    [companyId],
  );

  const prefsRes = await pool.query(
    `SELECT
       max_distance_meters_delivery,
       kilometer_price,
       max_distance_meters_free_delivery,
       min_price_order,
       min_tax_delivery
     FROM company_preferences
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [companyId],
  );

  const companyAddressRes = await pool.query(
    `SELECT
       street, number, neighborhood, city, state, zip_code,
       latitude, longitude
     FROM company_addresses
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [companyId],
  );

  const companyAddress = companyAddressRes.rows[0] || null;
  const companyAddressText = _buildAddressLine(companyAddress);
  const companyLat = toNumber(companyAddress?.latitude);
  const companyLng = toNumber(companyAddress?.longitude);

  return {
    company,
    is_open: isOpen,
    opening_hours: hoursRes.rows,
    categories: Array.from(categoriesMap.values()),
    uncategorized,
    promotions: promotionsRes.rows,
    payment_methods: paymentMethodsRes.rows,
    // Pagamento online via Stripe (contas conectadas). Mantido por compat.; o
    // provedor ativo passou a ser o Pagar.me.
    stripe: {
      enabled: stripeEnabled,
      publishable_key: stripeEnabled ? (process.env.STRIPE_PUBLISHABLE_KEY || null) : null,
    },
    // Pagamento online via Pagar.me (recebedores + split). `enabled` reflete se o
    // recebedor da loja está ativo. `public_key` (pk_...) é usada no cliente para
    // tokenizar o cartão (pagarme.js) sem expor a secret key.
    pagarme: {
      enabled: pagarmeEnabled,
      public_key: pagarmeEnabled ? (process.env.PAGARME_PUBLIC_KEY || null) : null,
      saved_cards_enabled: pagarmeEnabled && pagarmeService.savedCardsAvailable(),
      three_ds_enabled: pagarmeEnabled && pagarmeService.threeDsAvailable(),
      // Nome exibido na fatura do cartão (env PAGARME_STATEMENT_DESCRIPTOR, com
      // fallback para o nome da loja). O cliente usa no payload 3DS, dentro de
      // credit_card.statement_descriptor, alinhado à cobrança feita no servidor.
      statement_descriptor: pagarmeEnabled ? pagarmeService.statementDescriptor(company.name) : null,
    },
    company_preferences: prefsRes.rows[0] || null,
    company_address: companyAddress
      ? {
          ...companyAddress,
          latitude: companyLat,
          longitude: companyLng,
          formatted_address: companyAddressText,
        }
      : null,
  };
};

const _geocodeAddress = async (addressLine) => {
  if (!MAPS_KEY || !addressLine) return null;
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: addressLine,
        key: MAPS_KEY,
        language: "pt-BR",
        region: "br",
      },
    });
    const loc = data?.results?.[0]?.geometry?.location;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
      return { lat: loc.lat, lng: loc.lng };
    }
    return null;
  } catch (_) {
    return null;
  }
};

const calculatePublicDeliveryFee = async ({ company_id, destination_lat, destination_lng }) => {
  const companyAddressRes = await pool.query(
    `SELECT id, latitude, longitude, street, number, neighborhood, city, state, zip_code
     FROM company_addresses
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [company_id],
  );
  const prefsRes = await pool.query(
    `SELECT
       max_distance_meters_delivery,
       kilometer_price,
       max_distance_meters_free_delivery,
       min_price_order,
       min_tax_delivery
     FROM company_preferences
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [company_id],
  );

  const companyAddress = companyAddressRes.rows[0] || null;
  const prefs = prefsRes.rows[0] || {};
  if (!companyAddress) {
    return {
      ok: false,
      reason: "company_address_missing",
      message: "Endereço da empresa não configurado.",
    };
  }

  let originLat = toNumber(companyAddress.latitude);
  let originLng = toNumber(companyAddress.longitude);

  // Fallback: geocodificar o endereço da empresa se lat/lng não estão salvos
  if (originLat === null || originLng === null) {
    const addressLine = _buildAddressLine(companyAddress);
    const geo = await _geocodeAddress(addressLine);
    if (geo) {
      originLat = geo.lat;
      originLng = geo.lng;
      // Persistir para próximas chamadas
      try {
        await pool.query(`UPDATE company_addresses SET latitude = $1, longitude = $2 WHERE id = $3`, [originLat, originLng, companyAddress.id]);
      } catch (_) {
        // não-fatal: usamos o valor geocoded em memória mesmo se o UPDATE falhar
      }
    }
  }

  const destLat = toNumber(destination_lat);
  const destLng = toNumber(destination_lng);
  if (originLat === null || originLng === null || destLat === null || destLng === null) {
    return {
      ok: false,
      reason: "invalid_coordinates",
      message: "Não foi possível localizar o endereço da empresa. Confira o cadastro do endereço com CEP e número.",
    };
  }
  if (!MAPS_KEY) {
    return {
      ok: false,
      reason: "maps_key_missing",
      message: "Google API key não configurada.",
    };
  }

  const { data } = await axios.get("https://maps.googleapis.com/maps/api/distancematrix/json", {
    params: {
      origins: `${originLat},${originLng}`,
      destinations: `${destLat},${destLng}`,
      key: MAPS_KEY,
      language: "pt-BR",
      units: "metric",
    },
  });

  console.log(data);

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK") {
    return {
      ok: false,
      reason: "distance_not_found",
      message: "Não foi possível calcular a distância de entrega.",
    };
  }

  const distanceMeters = toNumber(element.distance?.value) ?? 0;
  const distanceKm = distanceMeters / 1000;
  const kilometerPrice = toNumber(prefs.kilometer_price) ?? 0;
  const maxDistance = toNumber(prefs.max_distance_meters_delivery);
  const freeDistance = toNumber(prefs.max_distance_meters_free_delivery);
  const minTax = toNumber(prefs.min_tax_delivery) ?? 0;

  const exceedsMax = maxDistance !== null && distanceMeters > maxDistance;
  const isFree = freeDistance !== null && distanceMeters <= freeDistance;
  let deliveryFee = 0;
  if (!isFree) {
    deliveryFee = distanceKm * kilometerPrice;
    if (minTax > 0) {
      deliveryFee = Math.max(minTax, deliveryFee);
    }
  }

  return {
    ok: !exceedsMax,
    reason: exceedsMax ? "distance_exceeded" : null,
    message: exceedsMax ? "Endereço fora da área de entrega." : null,
    distance_meters: distanceMeters,
    distance_text: element.distance?.text || `${distanceKm.toFixed(1)} km`,
    duration_text: element.duration?.text || null,
    delivery_fee: Number(deliveryFee.toFixed(2)),
    is_free_delivery: isFree,
    max_distance_meters_delivery: maxDistance,
    max_distance_meters_free_delivery: freeDistance,
    kilometer_price: kilometerPrice,
    min_tax_delivery: minTax,
    min_price_order: toNumber(prefs.min_price_order),
  };
};

// Busca mínima do cliente por telefone. Não devolve documento, e-mail, endereço
// nem notas: telefone não é um fator de autenticação suficiente para expor PII.
const findClientByPhone = async (phone, companyId) => {
  const norm = normalizePhone(phone);
  if (!norm) {
    // Telefone fora do padrão: cai no match exato (retrocompatível).
    const r = await pool.query(
      `SELECT cl.id, cl.company_id, cl.name, cl.phone
       FROM clients cl
       WHERE cl.phone = $1 AND cl.company_id = $2 AND cl.deactivated_at IS NULL
       ORDER BY (cl.user_id IS NOT NULL) DESC, cl.id ASC
       LIMIT 1`,
      [phone, companyId],
    );
    return r.rows[0] || null;
  }
  const result = await pool.query(
    `SELECT cl.id, cl.company_id, cl.name, cl.phone
     FROM clients cl
     WHERE cl.company_id = $2 AND cl.deactivated_at IS NULL
       AND normalize_phone(cl.phone) = $1
     ORDER BY (cl.user_id IS NOT NULL) DESC, cl.id ASC
     LIMIT 1`,
    [norm, companyId],
  );
  return result.rows[0] || null;
};

// Cadastro no fluxo público: NÃO cria mais um client por endereço.
// Resolve a identidade global pelo telefone e devolve o client (company_id, user_id)
// — criando-o só se ainda não existir. O endereço, quando enviado, é salvo na
// camada global (user_addresses), nunca em clients.
const createPublicClient = async ({ company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code, latitude, longitude }) => {
  if (!phone) {
    // Sem telefone não há como resolver identidade; mantém client "solto" (raro).
    const r = await pool.query(
      `INSERT INTO clients (company_id, name, phone) VALUES ($1, $2, NULL) RETURNING *`,
      [company_id, name ?? "Cliente"],
    );
    return r.rows[0];
  }

  const { client, userId } = await identityService.resolveClientByPhone({
    companyId: Number(company_id),
    phone: String(phone),
    name: name ? String(name) : null,
  });

  // Se veio endereço junto do cadastro, persiste como endereço salvo do usuário.
  if (street) {
    try {
      await identityService.createAddress(userId, {
        label: "Casa", street, number, complement, neighborhood,
        city, state, zip: zip_code, latitude, longitude,
      });
    } catch (e) {
      console.error("createPublicClient: falha ao salvar endereço do usuário:", e.message);
    }
  }
  return client;
};

const updatePublicClient = async ({ id, name, phone }) => {
  // Prova de posse: o cliente só pode editar o próprio cadastro provando conhecer
  // o telefone atualmente registrado (o app público sempre envia o telefone do
  // próprio cliente). Impede IDOR — editar o cadastro de outro cliente por id.
  // Endereço saiu de clients (FASE E) → é gerido por /public/addresses (user_addresses).
  const normalized = _normalizePhone(phone);
  if (!normalized) return { _forbidden: true };

  const result = await pool.query(
    `UPDATE clients
     SET name = $2, phone = $3, updated_at = NOW()
     WHERE id = $1
       AND normalize_phone(COALESCE(phone, '')) = $4
     RETURNING *`,
    // $3: salva o telefone canônico (com 55). $4: compara de forma canônica
    // (funciona quer o telefone salvo esteja com ou sem 55).
    [id, name, normalized, normalized],
  );
  // Nenhuma linha → id inexistente OU telefone não confere (acesso negado).
  if (!result.rows[0]) return { _forbidden: true };
  return result.rows[0];
};

// Snapshot imutável para a cobrança: um pedido não pode trocar de endereço quando
// o cliente altera sua agenda de endereços depois do checkout.
const _deliveryAddressSnapshot = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (field, limit) => {
    const raw = String(value[field] ?? "").trim();
    return raw ? raw.slice(0, limit) : null;
  };
  const snapshot = {
    street: text("street", 255),
    number: text("number", 32),
    complement: text("complement", 128),
    neighborhood: text("neighborhood", 128),
    city: text("city", 100),
    state: text("state", 2)?.toUpperCase() || null,
    zip: String(value.zip ?? value.zip_code ?? "").replace(/\D/g, "").slice(0, 8) || null,
  };
  return snapshot.street && snapshot.city && snapshot.state && snapshot.zip ? snapshot : null;
};

const createPublicOrder = async (data) => {
  const { company_id, client_id, notes, items, scheduled_for, payment_method_id } = data;
  // Provedor de pagamento online ('pagarme' | 'stripe'). Gravado já na criação
  // para que o pedido nasça com "pagamento pendente" e o cliente pague online.
  const ONLINE_PROVIDERS = ["pagarme", "stripe"];
  const payment_provider = ONLINE_PROVIDERS.includes(data.payment_provider) ? data.payment_provider : null;

  // Tipo de entrega — coluna BOOLEAN no DB (TRUE = entrega, FALSE = retirada).
  // O payload da API público continua aceitando "delivery" | "pickup".
  const isPickup = data.delivery_type === "pickup" || data.delivery_type === false;
  const delivery_type_bool = !isPickup; // TRUE = delivery

  // Garante que o método escolhido é aceito pela empresa.
  const acceptsRes = await pool.query(
    "SELECT accepts_delivery, accepts_pickup FROM companies WHERE id = $1",
    [company_id],
  );
  const accepts = acceptsRes.rows[0];
  if (accepts) {
    if (isPickup && accepts.accepts_pickup === false) {
      throw new Error("Esta empresa não aceita pedidos para retirada.");
    }
    if (!isPickup && accepts.accepts_delivery === false) {
      throw new Error("Esta empresa não aceita pedidos para entrega.");
    }
  }

  // Em retirada: zera taxa e ignora endereço (snapshot vazio).
  // A taxa nunca pode ser negativa (clamp), evitando "desconto" via taxa.
  const delivery_address = isPickup ? null : (data.delivery_address ?? null);
  const delivery_address_snapshot = isPickup ? null : _deliveryAddressSnapshot(data.delivery_address_snapshot);
  const delivery_fee = isPickup ? 0 : Math.max(0, Number(data.delivery_fee ?? 0));

  // ─── Preços autoritativos do servidor ───────────────────────────────────────
  // NUNCA confiar no `unit_price` enviado pelo cliente. Buscamos o preço real de
  // cada produto (menu_items.price) e de cada combo (promotions.final_price)
  // diretamente no banco, restritos à empresa do pedido. Isso impede fraude de
  // preço (comprar por centavos) sem alterar o payload da API pública.
  const menuItemIds = [...new Set(items.map((i) => i.menu_item_id).filter(Boolean).map(Number))];
  const promotionIds = [...new Set(items.map((i) => i.promotion_id).filter(Boolean).map(Number))];

  const menuPriceById = new Map();
  // Preço "cheio" (sem campanha) por item — usado para ratear o desconto do combo
  // proporcionalmente, coerente com como `promotions.original_price` foi calculado.
  const rawMenuPriceById = new Map();
  if (menuItemIds.length) {
    // Preço autoritativo com desconto de campanha aplicado quando ativo — é isso
    // que faz o desconto "valer de verdade" no valor cobrado do cliente.
    const activeCampaignPrices = await campaignsService.getActivePricesMap(company_id);
    const r = await pool.query(
      "SELECT id, price FROM menu_items WHERE company_id = $1 AND id = ANY($2::int[])",
      [company_id, menuItemIds],
    );
    for (const row of r.rows) {
      const base = Number(row.price ?? 0);
      const camp = activeCampaignPrices.get(Number(row.id));
      rawMenuPriceById.set(Number(row.id), base);
      menuPriceById.set(Number(row.id), camp ? Math.min(base, camp.final_price) : base);
    }
  }
  // Combo: guarda final_price E original_price para ratear o desconto entre os
  // itens do combo (o final_price é o preço do COMBO INTEIRO, não de cada item).
  const promoInfoById = new Map();
  if (promotionIds.length) {
    const r = await pool.query(
      "SELECT id, final_price, original_price FROM promotions WHERE company_id = $1 AND id = ANY($2::int[])",
      [company_id, promotionIds],
    );
    for (const row of r.rows) {
      promoInfoById.set(Number(row.id), {
        final: Number(row.final_price ?? 0),
        original: Number(row.original_price ?? 0),
      });
    }
  }

  // Validate purchase goal discounts the client is asking for
  const goalRequests = items
    .filter((it) => it.menu_item_id && it.purchase_goal_id)
    .map((it) => ({ menu_item_id: it.menu_item_id, purchase_goal_id: it.purchase_goal_id }));
  const goalMap = await purchaseGoalsService.validateGoalDiscounts(company_id, goalRequests);

  // Validate & enrich items with options snapshots + goal discount
  const enrichedItems = [];
  for (const item of items) {
    let optionsSnapshot = [];
    let extraPerUnit = 0;
    if (item.menu_item_id && Array.isArray(item.options) && item.options.length > 0) {
      const result = await productOptionsService.validateSelections(item.menu_item_id, item.options);
      optionsSnapshot = result.snapshot;
      extraPerUnit = result.extraTotalPerUnit;
    } else if (item.menu_item_id) {
      // Garante obrigatórios mesmo se cliente não enviou nada
      await productOptionsService.validateSelections(item.menu_item_id, []);
    }

    // Combos: valida e captura as opções de cada item interno do combo. As
    // opções obrigatórias dos sub-itens são exigidas aqui (validateSelections
    // lança se faltarem). O preço do combo permanece o promocional (as opções
    // dos sub-itens não somam preço extra ao combo).
    let comboOptions = [];
    if (item.promotion_id && Array.isArray(item.promotion_items)) {
      for (const sub of item.promotion_items) {
        if (!sub || !sub.menu_item_id) continue;
        const subSelections = Array.isArray(sub.options) ? sub.options : [];
        const result = await productOptionsService.validateSelections(sub.menu_item_id, subSelections);
        if (result.snapshot.length > 0) {
          comboOptions.push({ menu_item_id: sub.menu_item_id, snapshot: result.snapshot });
        }
      }
    }

    const qty = Number(item.quantity ?? 1);

    // Preço base resolvido no servidor (ignora o unit_price do cliente).
    let baseUnit;
    if (item.promotion_id) {
      const promoInfo = promoInfoById.get(Number(item.promotion_id));
      if (!promoInfo) {
        throw new Error("Promoção inválida para esta empresa.");
      }
      if (item.menu_item_id != null) {
        // Combo no formato EXPANDIDO (um pedido-item por produto do combo): o
        // final_price é o preço do combo INTEIRO, então rateamos entre os itens
        // proporcionalmente ao preço cheio de cada um. Assim a soma do grupo é o
        // preço do combo (× quantidade), e não o preço do combo em CADA item.
        // Peso = preço do servidor; cai para o unit_price enviado só como
        // PROPORÇÃO (o total do grupo é fixado pelo ratio, sem risco de fraude).
        const weight = rawMenuPriceById.has(Number(item.menu_item_id))
          ? rawMenuPriceById.get(Number(item.menu_item_id))
          : Number(item.unit_price ?? 0);
        const ratio = promoInfo.original > 0 ? promoInfo.final / promoInfo.original : 1;
        baseUnit = Number((weight * ratio).toFixed(2));
      } else {
        // Combo em LINHA ÚNICA (sem menu_item_id): cobra o preço do combo.
        baseUnit = promoInfo.final;
      }
    } else if (item.menu_item_id) {
      if (!menuPriceById.has(Number(item.menu_item_id))) {
        throw new Error("Item inválido para esta empresa.");
      }
      baseUnit = menuPriceById.get(Number(item.menu_item_id));
    } else {
      throw new Error("Item de pedido sem referência de produto.");
    }

    const goalInfo = goalMap.get(Number(item.menu_item_id));

    let goalDiscountPct = null;
    let goalDiscountPerUnit = 0;
    let goalId = null;
    if (goalInfo && goalInfo.percentage > 0) {
      goalDiscountPct = goalInfo.percentage;
      goalId = goalInfo.goalId;
      // Aplica desconto somente sobre o preço base do produto (não sobre os adicionais)
      goalDiscountPerUnit = Number((baseUnit * (goalDiscountPct / 100)).toFixed(2));
    }

    const finalUnit = Number((baseUnit + extraPerUnit - goalDiscountPerUnit).toFixed(2));
    const subtotal = Number((finalUnit * qty).toFixed(2));
    const goalDiscountAmount = goalDiscountPerUnit > 0 ? Number((goalDiscountPerUnit * qty).toFixed(2)) : null;

    enrichedItems.push({
      ...item,
      unit_price: finalUnit,
      base_unit_price: baseUnit,
      subtotal,
      _options_snapshot: optionsSnapshot,
      _combo_options: comboOptions,
      _purchase_goal_id: goalId,
      _goal_discount_percentage: goalDiscountPct,
      _goal_discount_amount: goalDiscountAmount,
    });
  }

  const subtotalOrder = enrichedItems.reduce((sum, i) => sum + Number(i.subtotal), 0);
  // Desconto total: somatório dos descontos por item (goals) + desconto manual eventual
  const goalsDiscount = enrichedItems.reduce(
    (sum, i) => sum + Number(i._goal_discount_amount || 0),
    0,
  );
  // Descontos arbitrários enviados pelo cliente são ignorados. Apenas os
  // descontos de metas (goals), validados no servidor, são aplicados — eles já
  // estão embutidos no subtotal por item via goalDiscountPerUnit.
  const manualDiscount = 0;
  const discount = Number((goalsDiscount + manualDiscount).toFixed(2));

  // Taxa de serviço: valor fixo cobrado do cliente SOMENTE em pagamento online
  // (Pagar.me/Stripe). Receita da plataforma — decidida no servidor (não confia no
  // client). Entra no total (é o que o cliente vê e o que o provedor cobra) e é
  // guardada em orders.service_fee. No split/application_fee é retida pela plataforma.
  const SERVICE_FEE_AMOUNT = Number(process.env.PUBLIC_SERVICE_FEE_AMOUNT ?? 1.49);
  const service_fee = payment_provider ? Number(SERVICE_FEE_AMOUNT.toFixed(2)) : 0;

  const total = Number((subtotalOrder + delivery_fee - manualDiscount + service_fee).toFixed(2));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tag = await generateUniqueOrderTag(client);
    // Status inicial: pedidos com pagamento online nascem em "Pagamento Pendente"
    // (10) e só vão para "Aguardando" (1) quando o pagamento é confirmado. Pedidos
    // sem provedor online (dinheiro/na entrega) começam direto em "Aguardando".
    const initialStatus = payment_provider ? 10 : 1;
    // Sub-método online escolhido pelo cliente ('pix' | 'card'). Só faz sentido
    // quando há provedor online; caso contrário fica NULL.
    const onlineMethod = payment_provider && ["pix", "card"].includes(data.online_payment_method)
      ? data.online_payment_method
      : null;
    const hasDeliverySnapshot = await columnExists("orders", "delivery_address_snapshot");
    const snapshotColumn = hasDeliverySnapshot ? ", delivery_address_snapshot" : "";
    const snapshotPlaceholder = hasDeliverySnapshot ? ", $16::jsonb" : "";
    const orderParams = [
      company_id,
      client_id,
      notes ?? null,
      subtotalOrder,
      delivery_fee,
      discount,
      total,
      payment_method_id ?? null,
      delivery_address,
      delivery_type_bool,
      scheduled_for ?? null,
      tag,
      payment_provider,
      service_fee,
      onlineMethod,
    ];
    if (hasDeliverySnapshot) orderParams.push(delivery_address_snapshot ? JSON.stringify(delivery_address_snapshot) : null);
    const orderRes = await client.query(
      `INSERT INTO orders (
         company_id, client_id, status, notes, subtotal, delivery_fee, discount, total,
         payment_method_id, delivery_address, delivery_type, scheduled_for, tag, payment_provider,
         service_fee, online_payment_method${snapshotColumn}
       )
       VALUES ($1, $2, ${initialStatus}, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15${snapshotPlaceholder}) RETURNING *`,
      orderParams,
    );
    const order = orderRes.rows[0];

    for (const item of enrichedItems) {
      const itemRes = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal, notes, promotion_id, promotion_group_key, purchase_goal_id, goal_discount_percentage, goal_discount_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          order.id,
          item.menu_item_id ?? null,
          item.name,
          item.quantity,
          item.unit_price,
          item.subtotal,
          item.notes ?? null,
          item.promotion_id ?? null,
          item.promotion_group_key ?? null,
          item._purchase_goal_id ?? null,
          item._goal_discount_percentage ?? null,
          item._goal_discount_amount ?? null,
        ],
      );
      const orderItemId = itemRes.rows[0].id;

      for (const opt of item._options_snapshot || []) {
        await client.query(
          `INSERT INTO order_item_options
             (order_item_id, menu_item_id, group_id, group_name, option_id, option_name, additional_price, quantity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            orderItemId,
            item.menu_item_id ?? null,
            opt.group_id ?? null,
            opt.group_name,
            opt.option_id ?? null,
            opt.option_name,
            Number(opt.additional_price ?? 0),
            Math.max(1, Number(opt.quantity ?? 1)),
          ],
        );
      }

      // Combos: persiste as opções de cada item interno, atribuídas ao sub-item
      // via menu_item_id (o order_item do combo tem menu_item_id nulo).
      for (const combo of item._combo_options || []) {
        for (const opt of combo.snapshot || []) {
          await client.query(
            `INSERT INTO order_item_options
               (order_item_id, menu_item_id, group_id, group_name, option_id, option_name, additional_price, quantity)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              orderItemId,
              combo.menu_item_id ?? null,
              opt.group_id ?? null,
              opt.group_name,
              opt.option_id ?? null,
              opt.option_name,
              Number(opt.additional_price ?? 0),
              Math.max(1, Number(opt.quantity ?? 1)),
            ],
          );
        }
      }
    }

    await client.query("INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)", [order.id, String(initialStatus)]);
    await client.query("COMMIT");
    return order;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// Troca o submétodo de um pedido online antes que qualquer cobrança fique ativa.
// Cartão e PIX têm a mesma taxa de serviço, então o total do pedido não muda.
// Nunca permitimos a troca depois de uma cobrança criada, pois um PIX pendente ou
// uma transação em análise pode ser confirmado pelo provedor a qualquer momento.
const changePendingOnlinePaymentMethod = async ({
  orderId,
  companyId,
  clientId,
  onlinePaymentMethod,
}) => {
  const method = String(onlinePaymentMethod || "").trim().toLowerCase();
  if (!["card", "pix"].includes(method)) {
    throw Object.assign(new Error("Escolha cartão ou PIX para continuar."), { status: 400 });
  }
  if (!(await tableExists("payment_attempts"))) {
    throw Object.assign(new Error("A troca de pagamento está indisponível no momento."), { status: 503 });
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const orderRes = await db.query(
      `SELECT id, company_id, client_id, status, payment_status, payment_provider,
              online_payment_method, pagarme_charge_id
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [Number(orderId)],
    );
    const order = orderRes.rows[0];
    if (!order || Number(order.company_id) !== Number(companyId) || Number(order.client_id) !== Number(clientId)) {
      throw Object.assign(new Error("Pedido não encontrado."), { status: 404 });
    }
    if (order.payment_provider !== "pagarme" || Number(order.status) !== 10 || ["paid", "refunded", "refund_pending", "chargedback"].includes(String(order.payment_status || ""))) {
      throw Object.assign(new Error("Este pedido não pode mais ter a forma de pagamento alterada."), { status: 409 });
    }

    const activeAttempt = await db.query(
      `SELECT id
       FROM payment_attempts
       WHERE order_id = $1
         AND provider = 'pagarme'
         AND method <> 'refund'
         AND status IN ('processing', 'pending', 'review_required')
         AND (method <> 'pix' OR expires_at IS NULL OR expires_at > now())
       LIMIT 1
       FOR UPDATE`,
      [order.id],
    );
    if (order.pagarme_charge_id || activeAttempt.rows[0]) {
      throw Object.assign(
        new Error("Já existe uma cobrança em andamento para este pedido. Aguarde a confirmação antes de trocar a forma de pagamento."),
        { status: 409 },
      );
    }

    const updated = await db.query(
      `UPDATE orders
       SET online_payment_method = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, online_payment_method, total`,
      [order.id, method],
    );
    await db.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
};

const _PUBLIC_ORDER_SELECT = `
  SELECT
    o.id, o.uuid, o.company_id, o.client_id, o.status, o.notes,
    o.subtotal, o.delivery_fee, o.discount, o.service_fee, o.total,
    o.delivery_address, o.delivery_type, o.tag,
    o.payment_status, o.payment_provider, o.online_payment_method,
    o.scheduled_for, o.created_at, o.updated_at,
    c.name AS client_name, c.phone AS client_phone,
    co.name AS company_name, co.brand_color, co.logo_url, co.phone AS company_phone,
    (SELECT ca.latitude FROM company_addresses ca WHERE ca.company_id = o.company_id ORDER BY ca.id DESC LIMIT 1) AS company_lat,
    (SELECT ca.longitude FROM company_addresses ca WHERE ca.company_id = o.company_id ORDER BY ca.id DESC LIMIT 1) AS company_lng,
    (
      SELECT NULLIF(TRIM(BOTH ', ' FROM CONCAT_WS(', ',
        NULLIF(TRIM(CONCAT_WS(' ', ca.street, ca.number)), ''),
        NULLIF(ca.neighborhood, ''),
        NULLIF(CONCAT_WS(' / ', NULLIF(ca.city, ''), NULLIF(ca.state, '')), ''),
        NULLIF(CASE WHEN COALESCE(ca.zip_code, '') <> '' THEN 'CEP ' || ca.zip_code END, '')
      )), '')
      FROM company_addresses ca WHERE ca.company_id = o.company_id ORDER BY ca.id DESC LIMIT 1
    ) AS company_address,
    pm.label AS payment_method_label, pm.type AS payment_method_type,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', oi.id,
            'menu_item_id', oi.menu_item_id,
            'name', oi.item_name,
            'quantity', oi.quantity,
            'unit_price', oi.item_price,
            'subtotal', oi.subtotal,
            'notes', oi.notes,
            'promotion_id', oi.promotion_id,
            'promotion_group_key', oi.promotion_group_key,
            'purchase_goal_id', oi.purchase_goal_id,
            'goal_discount_percentage', oi.goal_discount_percentage,
            'goal_discount_amount', oi.goal_discount_amount,
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
          )
          ORDER BY oi.id
        )
        FROM order_items oi
        WHERE oi.order_id = o.id
      ),
      '[]'::json
    ) AS items,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'status', sh.status,
            'notes', sh.notes,
            'created_at', sh.created_at
          )
          ORDER BY sh.created_at
        )
        FROM order_status_history sh
        WHERE sh.order_id = o.id
      ),
      '[]'::json
    ) AS status_history
  FROM orders o
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN companies co ON co.id = o.company_id
  LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
`;

// Canoniza o telefone para E.164 BR (55 + DDD + número). Fallback para os
// dígitos crus quando o número não é válido (evita null em comparações).
const _normalizePhone = (phone) => normalizePhone(phone) || String(phone || "").replace(/\D/g, "");

// Aceita o UUID público do pedido OU o id numérico (retrocompatível).
const _ORDER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A expiração é um atributo da tentativa PIX, não do pedido. Mantemos o status
// do pedido em "pagamento pendente" para que cliente e estabelecimento decidam
// pelo cancelamento nos fluxos já existentes, mas a interface não deve oferecer
// um QR Code vencido como se ainda pudesse ser pago.
const _getLatestPixExpiration = async (orderId) => {
  if (!(await tableExists("payment_attempts"))) return null;
  const result = await pool.query(
    `SELECT expires_at
     FROM payment_attempts
     WHERE order_id = $1
       AND provider = 'pagarme'
       AND method = 'pix'
       AND expires_at IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId],
  );
  return result.rows[0]?.expires_at || null;
};

const getPublicOrder = async ({ id, phone }) => {
  const ref = String(id).trim();
  const byUuid = _ORDER_UUID_RE.test(ref);

  // Acesso por UUID (não enumerável) dispensa telefone — é o link de rastreio.
  // Acesso por id numérico (enumerável) EXIGE telefone correspondente, para
  // impedir IDOR/enumeração de pedidos e vazamento de PII.
  const reqPhone = _normalizePhone(phone);
  if (!byUuid && !reqPhone) return null;

  const result = await pool.query(
    `${_PUBLIC_ORDER_SELECT} WHERE ${byUuid ? "o.uuid = $1" : "o.id = $1"} LIMIT 1`,
    [ref],
  );
  const row = result.rows[0] || null;
  if (!row) return null;

  // Sempre que um telefone for informado, ele precisa bater com o do pedido.
  if (reqPhone) {
    const rowPhone = _normalizePhone(row.client_phone);
    if (rowPhone !== reqPhone) return null;
  }
  row.payment_expires_at = await _getLatestPixExpiration(row.id);
  return row;
};

// Status que o cliente ainda pode cancelar: antes de "Saiu para entrega" (4).
//  1 = aguardando  · 2 = confirmado · 3 = preparando · 10 = pagamento pendente
// Bloqueado a partir de 4 (em entrega), 8 (pronto p/ retirada) e finais (5/6/7/9).
const _CLIENT_CANCELLABLE_STATUSES = [1, 2, 3, 10];

/**
 * Cancelamento do pedido PELO CLIENTE (fluxo público). Valida a posse do pedido
 * (reusa a mesma regra do getPublicOrder: UUID dispensa telefone; id numérico
 * exige telefone correspondente), garante que o pedido ainda não saiu para
 * entrega e, quando houve pagamento ONLINE confirmado via Pagar.me, solicita o
 * estorno antes de marcar o pedido como cancelado (status 6, com o motivo).
 *
 * Retorna { ok, code?, message?, refunded, paidOnline }.
 */
const cancelPublicOrder = async ({ id, phone, reason }) => {
  const order = await getPublicOrder({ id, phone });
  if (!order) return { ok: false, code: 404, message: "Pedido não encontrado." };

  const status = Number(order.status);
  if (status === 6 || status === 7) {
    return { ok: false, code: 409, message: "Este pedido já foi cancelado." };
  }
  if (!_CLIENT_CANCELLABLE_STATUSES.includes(status)) {
    return {
      ok: false,
      code: 409,
      message: "Este pedido já está em preparo avançado/entrega e não pode mais ser cancelado por aqui. Fale com o estabelecimento.",
    };
  }

  // Estorno: apenas quando houve pagamento ONLINE confirmado via Pagar.me.
  let refunded = false;
  let refundPending = false;
  const paidOnline = order.payment_provider === "pagarme" && order.payment_status === "paid";
  if (paidOnline) {
    // getPublicOrder não expõe o charge id (dado interno) — busca sob demanda.
    const chg = await pool.query("SELECT pagarme_charge_id FROM orders WHERE id = $1", [order.id]);
    const chargeId = chg.rows[0]?.pagarme_charge_id;
    if (chargeId) {
      try {
        const result = await pagarmeService.requestRefundForOrder(order.id, chargeId);
        refunded = result.status === "refunded";
        refundPending = !refunded;
      } catch (err) {
        // O pedido pode ser cancelado, mas o reembolso fica explicitamente em
        // pendência para conciliação operacional, sem prometer que ele ocorreu.
        console.error("Falha ao solicitar estorno Pagar.me (pedido " + order.id + "):", err.message);
        refundPending = true;
        await pool.query("UPDATE orders SET payment_status = 'refund_pending' WHERE id = $1", [order.id]);
      }
    }
  }

  // Marca como cancelado (status 6) com o motivo; dispara webhook + histórico.
  await ordersService.updateStatus(order.id, 6, reason || null);

  return { ok: true, refunded, refundPending, paidOnline };
};

const findPublicOrdersByPhone = async ({ company_id, phone }) => {
  const normalized = _normalizePhone(phone);
  if (!normalized) return [];
  const result = await pool.query(
    `${_PUBLIC_ORDER_SELECT}
     WHERE o.company_id = $1
       AND normalize_phone(COALESCE(c.phone, '')) = $2
     ORDER BY o.created_at DESC
     LIMIT 50`,
    [company_id, normalized],
  );
  return result.rows;
};

// ─── Marketplace público de restaurantes (/order) ───────────────────────────
// Lista todas as empresas com cardápio publicado, enriquecidas com métricas
// para ranking (pedidos/faturamento), tempo médio de preparo, taxa/pedido
// mínimo e status aberto/fechado. Também devolve promoções ativas para a
// vitrine. Sem autenticação — dados estritamente públicos.
const _isOpenNow = (hours) => {
  const now = new Date();
  const weekday = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const today = hours.find((h) => _isTodayWeekday(h.weekday, weekday));
  if (!today || today.is_closed) return false;
  const [oh, om] = String(today.opens_at).split(":").map(Number);
  const [ch, cm] = String(today.closes_at).split(":").map(Number);
  if (![oh, om, ch, cm].every(Number.isFinite)) return false;
  return currentMinutes >= oh * 60 + om && currentMinutes <= ch * 60 + cm;
};

const listPublicRestaurants = async () => {
  // Ranking: pedidos válidos (não cancelados/rejeitados) > faturamento > mais
  // recentes — melhor métrica disponível na estrutura atual.
  const restaurantsRes = await pool.query(
    `SELECT c.id, c.uuid, c.name, c.description, c.logo_url, c.banner_url, c.brand_color,
            c.cuisine_type,
            (SELECT COUNT(*)::int FROM orders o
              WHERE o.company_id = c.id AND o.status NOT IN (6, 7)) AS orders_count,
            (SELECT COALESCE(SUM(o.total), 0)::float FROM orders o
              WHERE o.company_id = c.id AND o.status NOT IN (6, 7)) AS revenue_total,
            (SELECT ROUND(AVG(mi.prep_time_minutes))::int FROM menu_items mi
              WHERE mi.company_id = c.id AND mi.available = true AND mi.deleted_at IS NULL
                AND mi.prep_time_minutes IS NOT NULL AND mi.prep_time_minutes > 0) AS avg_prep_minutes,
            (SELECT COUNT(*)::int FROM menu_items mi
              WHERE mi.company_id = c.id AND mi.available = true AND mi.deleted_at IS NULL) AS items_count,
            (SELECT cp.min_price_order FROM company_preferences cp
              WHERE cp.company_id = c.id ORDER BY cp.id DESC LIMIT 1) AS min_price_order,
            (SELECT cp.min_tax_delivery FROM company_preferences cp
              WHERE cp.company_id = c.id ORDER BY cp.id DESC LIMIT 1) AS min_tax_delivery,
            EXISTS(SELECT 1 FROM promotions p
              WHERE p.company_id = c.id AND p.active = true) AS has_promotions
     FROM companies c
     WHERE EXISTS (SELECT 1 FROM menu_items mi
                   WHERE mi.company_id = c.id AND mi.available = true AND mi.deleted_at IS NULL)
     ORDER BY orders_count DESC, revenue_total DESC, c.id DESC`,
  );
  const restaurants = restaurantsRes.rows;

  // Horários de todas as empresas listadas em uma query só → aberto/fechado.
  const ids = restaurants.map((r) => r.id);
  let hoursByCompany = new Map();
  if (ids.length > 0) {
    const hoursRes = await pool.query(
      `SELECT company_id, weekday, opens_at, closes_at, is_closed
       FROM company_opening_hours WHERE company_id = ANY($1::int[])`,
      [ids],
    );
    hoursByCompany = hoursRes.rows.reduce((map, h) => {
      if (!map.has(h.company_id)) map.set(h.company_id, []);
      map.get(h.company_id).push(h);
      return map;
    }, new Map());
  }

  for (const r of restaurants) {
    r.is_open = _isOpenNow(hoursByCompany.get(r.id) || []);
    r.min_price_order = toNumber(r.min_price_order);
    r.min_tax_delivery = toNumber(r.min_tax_delivery);
    r.revenue_total = toNumber(r.revenue_total) ?? 0;
  }

  // Promoções ativas para a vitrine "Promoções imperdíveis".
  const promosRes = await pool.query(
    `SELECT p.id, p.company_id, p.name, p.image_url,
            p.discount_percent, p.original_price, p.final_price,
            c.name AS company_name, c.logo_url AS company_logo
     FROM promotions p
     JOIN companies c ON c.id = p.company_id
     WHERE p.active = true
       AND EXISTS (SELECT 1 FROM menu_items mi
                   WHERE mi.company_id = p.company_id AND mi.available = true AND mi.deleted_at IS NULL)
     ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
     LIMIT 12`,
  );

  return { restaurants, promotions: promosRes.rows };
};

module.exports = {
  getCompanyPublicMenu,
  findClientByPhone,
  createPublicClient,
  updatePublicClient,
  createPublicOrder,
  changePendingOnlinePaymentMethod,
  calculatePublicDeliveryFee,
  getPublicOrder,
  cancelPublicOrder,
  findPublicOrdersByPhone,
  listPublicRestaurants,
};
