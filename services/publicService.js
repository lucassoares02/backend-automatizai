const axios = require("axios");
const pool = require("../db");

const MAPS_KEY = process.env.GOOGLE_API_KEY;

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

const getCompanyPublicMenu = async (companyId) => {
  const companyRes = await pool.query(
    `SELECT id, name, description, phone, status,
            logo_url, banner_url, brand_color
     FROM companies WHERE id = $1`,
    [companyId],
  );
  const company = companyRes.rows[0];
  if (!company) return null;

  const hoursRes = await pool.query(
    "SELECT weekday, opens_at, closes_at, is_closed FROM company_opening_hours WHERE company_id = $1 ORDER BY weekday",
    [companyId],
  );

  const now = new Date();
  const weekday = now.getDay(); // 0=Sun…6=Sat
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayHours = hoursRes.rows.find((h) => h.weekday === weekday);

  let isOpen = false;
  if (todayHours && !todayHours.is_closed) {
    const [oh, om] = String(todayHours.opens_at).split(":").map(Number);
    const [ch, cm] = String(todayHours.closes_at).split(":").map(Number);
    isOpen = currentMinutes >= oh * 60 + om && currentMinutes <= ch * 60 + cm;
  }

  const menuRes = await pool.query(
    `SELECT mi.id, mi.name, mi.description, mi.price, mi.image_url, mi.category_id,
            mi.prep_time_minutes, mi.featured,
            mc.name AS category_name, mc.sort_order AS cat_sort
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.company_id = $1 AND mi.available = true
     ORDER BY COALESCE(mc.sort_order, 9999), mc.id NULLS LAST, COALESCE(mi.display_order, mi.id)`,
    [companyId],
  );

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
                  'subtotal', (COALESCE(mi.price, 0) * pi.quantity)
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

const findClientByPhone = async (phone, companyId) => {
  const result = await pool.query("SELECT * FROM clients WHERE phone = $1 AND company_id = $2 LIMIT 1", [phone, companyId]);
  return result.rows[0] || null;
};

const createPublicClient = async ({ company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code }) => {
  if (phone) {
    const existing = await findClientByPhone(phone, company_id);
    if (existing) return existing;
  }
  const result = await pool.query(
    `INSERT INTO clients (company_id, name, phone, street, number, complement, neighborhood, city, state, zip_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      company_id,
      name,
      phone ?? null,
      street ?? null,
      number ?? null,
      complement ?? null,
      neighborhood ?? null,
      city ?? null,
      state ?? null,
      zip_code ?? null,
    ],
  );
  return result.rows[0];
};

const updatePublicClient = async ({ id, name, phone, street, number, complement, neighborhood, city, state, zip_code }) => {
  const result = await pool.query(
    `UPDATE clients
     SET name = $2, phone = $3, street = $4, number = $5, complement = $6,
         neighborhood = $7, city = $8, state = $9, zip_code = $10, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      name,
      phone ?? null,
      street ?? null,
      number ?? null,
      complement ?? null,
      neighborhood ?? null,
      city ?? null,
      state ?? null,
      zip_code ?? null,
    ],
  );
  return result.rows[0];
};

const createPublicOrder = async (data) => {
  const { company_id, client_id, notes, items, delivery_address, scheduled_for, payment_method_id } = data;
  const delivery_fee = Number(data.delivery_fee ?? 0);
  const discount = Number(data.discount ?? 0);
  const subtotal = items.reduce((sum, i) => sum + Number(i.subtotal), 0);
  const total = subtotal + delivery_fee - discount;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query(
      `INSERT INTO orders (company_id, client_id, status, notes, subtotal, delivery_fee, discount, total, payment_method_id, delivery_address, scheduled_for, tag)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, 'public') RETURNING *`,
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
        scheduled_for ?? null,
      ],
    );
    const order = orderRes.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, item_price, subtotal, notes, promotion_id, promotion_group_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ],
      );
    }

    await client.query("INSERT INTO order_status_history (order_id, status) VALUES ($1, 1)", [order.id]);
    await client.query("COMMIT");
    return order;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const _PUBLIC_ORDER_SELECT = `
  SELECT
    o.id, o.company_id, o.client_id, o.status, o.notes,
    o.subtotal, o.delivery_fee, o.discount, o.total,
    o.delivery_address, o.scheduled_for, o.created_at, o.updated_at,
    c.name AS client_name, c.phone AS client_phone,
    co.name AS company_name, co.brand_color, co.logo_url, co.phone AS company_phone,
    (SELECT ca.latitude FROM company_addresses ca WHERE ca.company_id = o.company_id ORDER BY ca.id DESC LIMIT 1) AS company_lat,
    (SELECT ca.longitude FROM company_addresses ca WHERE ca.company_id = o.company_id ORDER BY ca.id DESC LIMIT 1) AS company_lng,
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
            'promotion_group_key', oi.promotion_group_key
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

const _normalizePhone = (phone) => String(phone || "").replace(/\D/g, "");

const getPublicOrder = async ({ id, phone }) => {
  const result = await pool.query(`${_PUBLIC_ORDER_SELECT} WHERE o.id = $1 LIMIT 1`, [id]);
  const row = result.rows[0] || null;
  if (!row) return null;
  if (phone) {
    const rowPhone = _normalizePhone(row.client_phone);
    const reqPhone = _normalizePhone(phone);
    if (rowPhone && reqPhone && rowPhone !== reqPhone) return null;
  }
  return row;
};

const findPublicOrdersByPhone = async ({ company_id, phone }) => {
  const normalized = _normalizePhone(phone);
  if (!normalized) return [];
  const result = await pool.query(
    `${_PUBLIC_ORDER_SELECT}
     WHERE o.company_id = $1
       AND REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = $2
     ORDER BY o.created_at DESC
     LIMIT 50`,
    [company_id, normalized],
  );
  return result.rows;
};

module.exports = {
  getCompanyPublicMenu,
  findClientByPhone,
  createPublicClient,
  updatePublicClient,
  createPublicOrder,
  calculatePublicDeliveryFee,
  getPublicOrder,
  findPublicOrdersByPhone,
};
