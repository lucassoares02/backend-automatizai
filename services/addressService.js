const axios = require('axios');
const pool = require('../db');

const MAPS_KEY = process.env.GOOGLE_API_KEY;
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

const autocomplete = async (input, sessionToken) => {
  const params = {
    input,
    key: MAPS_KEY,
    language: 'pt-BR',
    components: 'country:br',
  };
  if (sessionToken) params.sessiontoken = sessionToken;

  const { data } = await axios.get(`${PLACES_BASE}/autocomplete/json`, { params });
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places Autocomplete error: ${data.status}`);
  }
  return (data.predictions || []).map((p) => ({
    placeId: p.place_id,
    description: p.description,
    mainText: p.structured_formatting?.main_text,
    secondaryText: p.structured_formatting?.secondary_text,
  }));
};

const details = async (placeId, sessionToken) => {
  const params = {
    place_id: placeId,
    key: MAPS_KEY,
    language: 'pt-BR',
    fields: 'place_id,formatted_address,geometry,address_components,name',
  };
  if (sessionToken) params.sessiontoken = sessionToken;

  const { data } = await axios.get(`${PLACES_BASE}/details/json`, { params });
  if (data.status !== 'OK') throw new Error(`Places Details error: ${data.status}`);

  const r = data.result;
  const comps = r.address_components || [];

  const get = (types) =>
    comps.find((c) => types.every((t) => c.types.includes(t)))?.long_name ?? null;

  return {
    placeId: r.place_id,
    formattedAddress: r.formatted_address,
    lat: r.geometry?.location?.lat ?? null,
    lng: r.geometry?.location?.lng ?? null,
    street: get(['route']),
    number: get(['street_number']),
    neighborhood: get(['sublocality_level_1']) ?? get(['sublocality']),
    city: get(['administrative_area_level_2']) ?? get(['locality']),
    state: get(['administrative_area_level_1']),
    zipCode: get(['postal_code']),
    country: get(['country']),
  };
};

const findByCompany = async (companyId) => {
  const result = await pool.query(
    'SELECT * FROM addresses WHERE company_id = $1 ORDER BY created_at DESC',
    [companyId],
  );
  return result.rows;
};

const create = async (data) => {
  const {
    company_id, label, street, number, complement,
    neighborhood, city, state, zip_code, country,
    lat, lng, place_id, formatted_address,
  } = data;

  const result = await pool.query(
    `INSERT INTO addresses
      (company_id, label, street, number, complement, neighborhood, city, state,
       zip_code, country, lat, lng, place_id, formatted_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [company_id, label, street, number, complement,
     neighborhood, city, state, zip_code, country,
     lat, lng, place_id, formatted_address],
  );
  return result.rows[0];
};

const remove = async (id) => {
  const result = await pool.query('DELETE FROM addresses WHERE id = $1 RETURNING *', [id]);
  return result.rows[0] || null;
};

module.exports = { autocomplete, details, findByCompany, create, remove };
