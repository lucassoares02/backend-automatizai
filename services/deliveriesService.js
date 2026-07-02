const pool = require("../db");
const axios = require("axios");

const MAPS_KEY = process.env.GOOGLE_API_KEY;

// Status 4 = ENTREGA ("Saiu para entrega") — ver DB_CHANGES_NEEDED.md
const STATUS_IN_ROUTE = 4;

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─── Geocode (mesmo padrão de publicService) ─────────────────────────────────
const _geocodeAddress = async (addressLine) => {
  if (!MAPS_KEY || !addressLine) return null;
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: addressLine, key: MAPS_KEY, language: "pt-BR", region: "br" },
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

// ─── Origem: endereço da loja (lat/lng com fallback de geocode persistido) ───
const _getCompanyOrigin = async (companyId) => {
  const res = await pool.query(
    `SELECT id, latitude, longitude, street, number, neighborhood, city, state, zip_code
     FROM company_addresses
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [companyId],
  );
  const addr = res.rows[0];
  if (!addr) return null;

  let lat = toNumber(addr.latitude);
  let lng = toNumber(addr.longitude);
  if (lat === null || lng === null) {
    const line = [addr.street, addr.number, addr.neighborhood, addr.city, addr.state, addr.zip_code]
      .filter(Boolean)
      .join(", ");
    const geo = await _geocodeAddress(line);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      try {
        await pool.query(`UPDATE company_addresses SET latitude = $1, longitude = $2 WHERE id = $3`, [lat, lng, addr.id]);
      } catch (_) {
        // não-fatal
      }
    }
  }
  if (lat === null || lng === null) return null;
  return {
    lat,
    lng,
    label: [addr.street, addr.number].filter(Boolean).join(", ") || "Loja",
  };
};

// Distância em linha reta (Haversine) — estimativa exibida nos cards
const _haversineKm = (lat1, lng1, lat2, lng2) => {
  const rad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ─── Compatibilidade de schema ───────────────────────────────────────────────
// As colunas orders.delivery_lat/delivery_lng vêm de uma migration anterior
// ("orders — Coordenadas de entrega" no DB_CHANGES_NEEDED.md) que pode não
// estar aplicada. Detecta uma vez e degrada para clients.latitude/longitude.
let _ordersHasCoordColumns = null;

const _checkOrdersCoordColumns = async () => {
  if (_ordersHasCoordColumns !== null) return _ordersHasCoordColumns;
  try {
    const res = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name = 'delivery_lat'
       LIMIT 1`,
    );
    _ordersHasCoordColumns = res.rowCount > 0;
  } catch (_) {
    _ordersHasCoordColumns = false;
  }
  return _ordersHasCoordColumns;
};

// ─── Pedidos em rota (status = 4, somente entrega) ───────────────────────────
const _selectInRouteOrders = async (companyId, orderIds = null) => {
  const hasCoordCols = await _checkOrdersCoordColumns();
  const coordFields = hasCoordCols
    ? "o.delivery_lat, o.delivery_lng,"
    : "NULL::numeric AS delivery_lat, NULL::numeric AS delivery_lng,";
  const idsFilter = orderIds && orderIds.length ? "AND o.id = ANY($2::int[])" : "";
  const params = idsFilter ? [companyId, orderIds] : [companyId];
  const result = await pool.query(
    `SELECT o.id, o.tag, o.total, o.status, o.created_at, o.delivery_address,
            ${coordFields} o.estimated_delivery_minutes,
            c.id    AS client_id,
            c.name  AS client_name,
            c.phone AS client_phone,
            c.neighborhood,
            c.latitude  AS client_lat,
            c.longitude AS client_lng
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.company_id = $1
       AND o.status = ${STATUS_IN_ROUTE}
       AND o.delivery_type = TRUE
       ${idsFilter}
     ORDER BY o.created_at ASC`,
    params,
  );
  return result.rows || [];
};

// Resolve coordenadas do pedido: snapshot do pedido → cliente → geocode do
// endereço textual. O geocode é persistido em orders.delivery_lat/lng quando
// as colunas existem; senão, em clients.latitude/longitude (fallback).
const _resolveOrderCoords = async (row) => {
  let lat = toNumber(row.delivery_lat) ?? toNumber(row.client_lat);
  let lng = toNumber(row.delivery_lng) ?? toNumber(row.client_lng);
  if ((lat === null || lng === null) && row.delivery_address) {
    const geo = await _geocodeAddress(row.delivery_address);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      try {
        if (await _checkOrdersCoordColumns()) {
          await pool.query(`UPDATE orders SET delivery_lat = $1, delivery_lng = $2 WHERE id = $3`, [lat, lng, row.id]);
        } else if (row.client_id) {
          await pool.query(`UPDATE clients SET latitude = $1, longitude = $2 WHERE id = $3`, [lat, lng, row.client_id]);
        }
      } catch (_) {
        // não-fatal
      }
    }
  }
  return { lat, lng };
};

const getActiveDeliveries = async (companyId) => {
  const origin = await _getCompanyOrigin(companyId);
  const rows = await _selectInRouteOrders(companyId);

  const orders = [];
  for (const row of rows) {
    const { lat, lng } = await _resolveOrderCoords(row);
    orders.push({
      id: row.id,
      tag: row.tag,
      client_name: row.client_name,
      client_phone: row.client_phone,
      neighborhood: row.neighborhood,
      delivery_address: row.delivery_address,
      total: toNumber(row.total),
      status: row.status,
      created_at: row.created_at,
      estimated_delivery_minutes: row.estimated_delivery_minutes,
      lat,
      lng,
      has_location: lat !== null && lng !== null,
      distance_km:
        origin && lat !== null && lng !== null
          ? Math.round(_haversineKm(origin.lat, origin.lng, lat, lng) * 10) / 10
          : null,
    });
  }

  return { origin, orders };
};

// ─── Rota otimizada (Google Routes API v2) ───────────────────────────────────
//
// A Directions API legada não está habilitada no projeto Google; usamos a
// Routes API v2 (computeRoutes), que é a substituta oficial.
//
// Estratégia: origem = loja; destino = parada mais distante da loja (linha
// reta); demais paradas viram `intermediates` com `optimizeWaypointOrder` —
// o Google devolve a melhor sequência (menor tempo total), não a ordem de
// criação dos pedidos.
const _routesLatLng = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

// Durações da Routes API vêm como string "1244s"
const _parseDurationSeconds = (d) => {
  const n = parseInt(String(d || "").replace("s", ""), 10);
  return Number.isFinite(n) ? n : null;
};

const _requestOptimizedRoute = async (origin, stops) => {
  if (!MAPS_KEY) {
    const err = new Error("Google API key não configurada.");
    err.code = "maps_key_missing";
    throw err;
  }

  let destinationIdx = 0;
  let maxDist = -1;
  stops.forEach((s, i) => {
    const d = _haversineKm(origin.lat, origin.lng, s.lat, s.lng);
    if (d > maxDist) {
      maxDist = d;
      destinationIdx = i;
    }
  });
  const destination = stops[destinationIdx];
  const waypoints = stops.filter((_, i) => i !== destinationIdx);

  const body = {
    origin: _routesLatLng(origin),
    destination: _routesLatLng(destination),
    travelMode: "DRIVE",
    languageCode: "pt-BR",
    regionCode: "BR",
  };
  if (waypoints.length) {
    body.intermediates = waypoints.map(_routesLatLng);
    body.optimizeWaypointOrder = true;
  }

  let data;
  try {
    const res = await axios.post("https://routes.googleapis.com/directions/v2:computeRoutes", body, {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": MAPS_KEY,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline," +
          "routes.optimizedIntermediateWaypointIndex,routes.legs.distanceMeters,routes.legs.duration",
      },
    });
    data = res.data;
  } catch (e) {
    const err = new Error("Não foi possível gerar a rota.");
    err.code = "directions_failed";
    err.details = e?.response?.data?.error?.message || e.message;
    throw err;
  }

  const route = data?.routes?.[0];
  if (!route) {
    const err = new Error("Não foi possível gerar a rota.");
    err.code = "directions_failed";
    err.details = "empty_route";
    throw err;
  }

  // Sequência final: intermediates na ordem otimizada + destino por último.
  // Sem índice de otimização (ex.: 1 parada), mantém a ordem enviada.
  const waypointOrder = route.optimizedIntermediateWaypointIndex || [];
  const orderedWaypoints = waypointOrder.length ? waypointOrder.map((i) => waypoints[i]) : waypoints;
  const orderedStops = [...orderedWaypoints, destination];

  const legs = route.legs || [];
  const stopsWithLegs = orderedStops.map((s, i) => ({
    ...s,
    distance_meters: toNumber(legs[i]?.distanceMeters),
    duration_seconds: _parseDurationSeconds(legs[i]?.duration),
  }));

  return {
    stops: stopsWithLegs,
    total_distance_meters:
      toNumber(route.distanceMeters) ?? legs.reduce((sum, l) => sum + (toNumber(l?.distanceMeters) || 0), 0),
    total_duration_seconds:
      _parseDurationSeconds(route.duration) ?? legs.reduce((sum, l) => sum + (_parseDurationSeconds(l?.duration) || 0), 0),
    overview_polyline: route.polyline?.encodedPolyline || null,
  };
};

const _buildGoogleMapsUrl = (origin, stops) => {
  const last = stops[stops.length - 1];
  const mid = stops.slice(0, -1);
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: `${last.lat},${last.lng}`,
    travelmode: "driving",
  });
  if (mid.length) params.set("waypoints", mid.map((s) => `${s.lat},${s.lng}`).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
};

const createRoute = async ({ company_id, driver_id, order_ids }) => {
  const origin = await _getCompanyOrigin(company_id);
  if (!origin) {
    const err = new Error("Endereço da empresa sem localização válida. Configure o endereço da loja.");
    err.code = "company_origin_missing";
    throw err;
  }

  // Valida motoboy da empresa
  const driverRes = await pool.query(`SELECT id, name FROM delivery_drivers WHERE id = $1 AND company_id = $2`, [driver_id, company_id]);
  const driver = driverRes.rows[0];
  if (!driver) {
    const err = new Error("Motoboy não encontrado para esta empresa.");
    err.code = "driver_not_found";
    throw err;
  }

  // Pedidos em rota da empresa dentro da seleção
  const rows = await _selectInRouteOrders(company_id, order_ids);
  if (!rows.length) {
    const err = new Error("Nenhum pedido em entrega válido na seleção.");
    err.code = "orders_not_found";
    throw err;
  }

  const stops = [];
  for (const row of rows) {
    const { lat, lng } = await _resolveOrderCoords(row);
    if (lat === null || lng === null) {
      const err = new Error(`Pedido ${row.tag || `#${row.id}`} sem localização válida.`);
      err.code = "order_without_location";
      throw err;
    }
    stops.push({ order_id: row.id, tag: row.tag, client_name: row.client_name, lat, lng });
  }

  const optimized = await _requestOptimizedRoute(origin, stops);
  const googleMapsUrl = _buildGoogleMapsUrl(origin, optimized.stops);

  // Persiste rota + paradas em transação
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const routeRes = await client.query(
      `INSERT INTO delivery_routes
         (company_id, driver_id, status, total_distance_meters, total_duration_seconds,
          stops_count, origin_lat, origin_lng, overview_polyline, google_maps_url)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        company_id,
        driver_id,
        optimized.total_distance_meters,
        optimized.total_duration_seconds,
        optimized.stops.length,
        origin.lat,
        origin.lng,
        optimized.overview_polyline,
        googleMapsUrl,
      ],
    );
    const route = routeRes.rows[0];

    for (let i = 0; i < optimized.stops.length; i++) {
      const s = optimized.stops[i];
      await client.query(
        `INSERT INTO delivery_route_orders (route_id, order_id, stop_order, lat, lng, distance_meters, duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [route.id, s.order_id, i + 1, s.lat, s.lng, s.distance_meters, s.duration_seconds],
      );
    }
    await client.query("COMMIT");

    return {
      ...route,
      driver_name: driver.name,
      origin,
      stops: optimized.stops.map((s, i) => ({
        order_id: s.order_id,
        tag: s.tag,
        client_name: s.client_name,
        stop_order: i + 1,
        lat: s.lat,
        lng: s.lng,
        distance_meters: s.distance_meters,
        duration_seconds: s.duration_seconds,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ─── Histórico de rotas ──────────────────────────────────────────────────────
const listRoutes = async (companyId, { days = 7 } = {}) => {
  const result = await pool.query(
    `SELECT r.*,
            d.name AS driver_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'order_id', ro.order_id,
                       'stop_order', ro.stop_order,
                       'lat', ro.lat,
                       'lng', ro.lng,
                       'distance_meters', ro.distance_meters,
                       'duration_seconds', ro.duration_seconds,
                       'tag', o.tag,
                       'client_name', c.name
                     ) ORDER BY ro.stop_order)
              FROM delivery_route_orders ro
              JOIN orders o ON o.id = ro.order_id
              JOIN clients c ON c.id = o.client_id
              WHERE ro.route_id = r.id
            ), '[]') AS stops
     FROM delivery_routes r
     LEFT JOIN delivery_drivers d ON d.id = r.driver_id
     WHERE r.company_id = $1
       AND r.created_at >= NOW() - ($2 || ' days')::interval
     ORDER BY r.created_at DESC`,
    [companyId, String(days)],
  );
  return result.rows || [];
};

module.exports = { getActiveDeliveries, createRoute, listRoutes };
