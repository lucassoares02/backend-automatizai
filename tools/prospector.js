/**
 * Prospector de leads de delivery — AutomatizAI
 * ------------------------------------------------------------
 * Busca comerciantes de delivery de alimentos no Google Maps (Places API New)
 * próximos de Morada de Laranjeiras (Serra-ES), enriquece cada lead
 * (WhatsApp provável, plataforma de pedido, iFood, cardápio online) e
 * exporta um CSV pronto para prospecção.
 *
 * Uso (a partir da pasta /api):
 *   node tools/prospector.js
 *   node tools/prospector.js --raio=8 --limite=300
 *   node tools/prospector.js --lat=-20.1783 --lng=-40.2567 --raio=10
 *   node tools/prospector.js --verify-whatsapp        (valida WhatsApp via Evolution API)
 *   node tools/prospector.js --out=./tools/leads.csv
 *
 * Requisitos:
 *   - GOOGLE_MAPS_API_KEY no .env COM a "Places API (New)" habilitada no Google Cloud.
 *   - (Opcional) EVOLUTION_API_URL + TOKEN_EVOLUTION + EVOLUTION_INSTANCE para --verify-whatsapp.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// --------------------------------------------------------------------------
// Configuração
// --------------------------------------------------------------------------
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Centro padrão: Morada de Laranjeiras, Serra-ES
const DEFAULT_CENTER = { lat: -20.1783, lng: -40.2567 };

const args = parseArgs(process.argv.slice(2));
const CENTER = {
  lat: args.lat ? Number(args.lat) : DEFAULT_CENTER.lat,
  lng: args.lng ? Number(args.lng) : DEFAULT_CENTER.lng,
};
const RADIUS_KM = args.raio ? Number(args.raio) : 8;      // raio da busca (km)
const RADIUS_M = Math.min(RADIUS_KM * 1000, 50000);       // Places API: máx 50km
const LIMIT = args.limite ? Number(args.limite) : Infinity;
const VERIFY_WHATSAPP = Boolean(args['verify-whatsapp']);
const OUT_PATH = args.out
  ? path.resolve(args.out)
  : path.resolve(__dirname, `leads-serra-${new Date().toISOString().slice(0, 10)}.csv`);

// Categorias de comida (pt-BR) para cobrir o máximo de tipos de delivery.
const FOOD_QUERIES = [
  'restaurante delivery',
  'delivery de comida',
  'pizzaria',
  'hamburgueria',
  'lanchonete',
  'açaí',
  'marmita comida caseira',
  'restaurante japonês sushi',
  'esfiha comida árabe',
  'comida saudável fit',
  'padaria',
  'sorveteria',
  'bar petiscos porções',
  'churrascaria espetinho',
  'sorveteria doceria',
];

// Plataformas de pedido conhecidas (detecção pela URL do site).
const PLATFORMS = [
  { nome: 'iFood',        re: /ifood\.com/i,                          proprietaria: false },
  { nome: 'Goomer',       re: /goomer/i,                              proprietaria: true },
  { nome: 'Anota AI',     re: /anota\.?ai|anotaai/i,                  proprietaria: true },
  { nome: 'CardápioWeb',  re: /cardapioweb/i,                         proprietaria: true },
  { nome: 'Delivery Much',re: /deliverymuch/i,                        proprietaria: false },
  { nome: 'Aiqfome',      re: /aiqfome/i,                             proprietaria: false },
  { nome: 'Neemo',        re: /neemo/i,                               proprietaria: true },
  { nome: 'Saipos',       re: /saipos/i,                              proprietaria: true },
  { nome: 'Menew',        re: /menew/i,                               proprietaria: true },
  { nome: 'Consumer',     re: /consumer\.com\.br/i,                   proprietaria: true },
  { nome: 'Instagram',    re: /instagram\.com/i,                      proprietaria: false, social: true },
  { nome: 'Linktree',     re: /linktr\.ee|linktree/i,                 proprietaria: false, social: true },
];

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.delivery',
  'places.dineIn',
  'places.takeout',
  'places.priceLevel',
  'nextPageToken',
].join(',');

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
(async function main() {
  if (!API_KEY) {
    console.error('❌ GOOGLE_MAPS_API_KEY não encontrada no .env');
    process.exit(1);
  }

  console.log('🔎 Prospector de leads — AutomatizAI');
  console.log(`   Centro: ${CENTER.lat}, ${CENTER.lng}  |  Raio: ${RADIUS_KM} km`);
  console.log(`   Categorias: ${FOOD_QUERIES.length}\n`);

  const byId = new Map();

  for (const query of FOOD_QUERIES) {
    process.stdout.write(`  • "${query}" ... `);
    let found = 0;
    try {
      for await (const place of searchAll(query)) {
        if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') continue;
        const dist = haversineKm(CENTER, place.location);
        if (dist > RADIUS_KM) continue; // locationBias não é filtro rígido → cortamos aqui
        if (!byId.has(place.id)) {
          byId.set(place.id, { ...place, _dist: dist, _queries: new Set([query]) });
          found++;
        } else {
          byId.get(place.id)._queries.add(query);
        }
      }
      console.log(`${found} novos`);
    } catch (err) {
      console.log('erro');
      handlePlacesError(err);
    }
    await sleep(200);
  }

  let leads = Array.from(byId.values()).map(enrich);

  // Filtra apenas quem tem telefone (sem contato não é lead acionável).
  leads = leads.filter((l) => l.telefone);

  // Verificação real de WhatsApp (opcional).
  if (VERIFY_WHATSAPP) {
    await verifyWhatsappBatch(leads);
  }

  leads = leads
    .map(scoreLead)
    .sort((a, b) => b.lead_score - a.lead_score || (b.num_avaliacoes || 0) - (a.num_avaliacoes || 0))
    .slice(0, LIMIT);

  writeCsv(leads, OUT_PATH);

  console.log(`\n✅ ${leads.length} leads salvos em:\n   ${OUT_PATH}`);
  printSummary(leads);
})().catch((err) => {
  console.error('\n❌ Falha inesperada:', err.message);
  process.exit(1);
});

// --------------------------------------------------------------------------
// Places API — busca com paginação
// --------------------------------------------------------------------------
async function* searchAll(textQuery) {
  let pageToken = null;
  for (let page = 0; page < 3; page++) { // máx 60 resultados por categoria
    const body = {
      textQuery,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      locationBias: {
        circle: { center: { latitude: CENTER.lat, longitude: CENTER.lng }, radius: RADIUS_M },
      },
    };
    if (pageToken) body.pageToken = pageToken;

    const { data } = await axios.post(PLACES_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      timeout: 20000,
    });

    for (const p of data.places || []) yield p;

    pageToken = data.nextPageToken;
    if (!pageToken) break;
    await sleep(1500); // token leva um instante para ficar válido
  }
}

// --------------------------------------------------------------------------
// Enriquecimento
// --------------------------------------------------------------------------
function enrich(place) {
  const phoneRaw = place.nationalPhoneNumber || place.internationalPhoneNumber || '';
  const { telefone, whatsappProvavel, e164 } = parsePhone(phoneRaw);
  const site = place.websiteUri || '';

  const detected = PLATFORMS.filter((pl) => pl.re.test(site));
  const temIfood = detected.some((d) => d.nome === 'iFood') ? 'sim' : (site ? 'não detectado' : 'desconhecido');
  const proprietarias = detected.filter((d) => d.proprietaria);
  const soSocial = detected.length > 0 && detected.every((d) => d.social);

  return {
    place_id: place.id,
    nome: place.displayName?.text || '',
    categoria: place.primaryTypeDisplayName?.text || (place.types || [])[0] || '',
    endereco: place.formattedAddress || '',
    telefone,
    telefone_e164: e164,
    whatsapp_provavel: whatsappProvavel ? 'sim' : 'não',
    whatsapp_verificado: '',           // preenchido por --verify-whatsapp
    site,
    tem_ifood: temIfood,
    plataforma_pedido: detected.map((d) => d.nome).join(' | ') || '',
    tem_cardapio_online: (proprietarias.length > 0 || temIfood === 'sim') ? 'sim' : (site ? 'talvez' : 'não'),
    tem_plataforma_propria: proprietarias.length > 0,
    so_social: soSocial,
    delivery: place.delivery === true ? 'sim' : place.delivery === false ? 'não' : 'desconhecido',
    _delivery_bool: place.delivery,
    nota: place.rating || '',
    num_avaliacoes: place.userRatingCount || 0,
    distancia_km: Number(place._dist.toFixed(2)),
    categorias_encontrado: Array.from(place._queries || []).join(', '),
    google_maps_url: place.googleMapsUri || '',
    _whatsappProvavel: whatsappProvavel,
    _temIfood: temIfood,
  };
}

// --------------------------------------------------------------------------
// Scoring — melhor lead p/ AutomatizAI (canal de pedidos no WhatsApp)
// --------------------------------------------------------------------------
function scoreLead(l) {
  let score = 0;
  const motivos = [];

  const temWhats = l.whatsapp_verificado === 'sim' || (l.whatsapp_verificado === '' && l._whatsappProvavel);
  if (temWhats) { score += 3; motivos.push('atende no WhatsApp'); }

  if (l._delivery_bool === true) { score += 2; motivos.push('faz delivery'); }

  if (!l.tem_plataforma_propria) {
    score += 2;
    motivos.push('sem plataforma própria de pedidos (oportunidade)');
  } else {
    score -= 2;
    motivos.push('já usa plataforma própria (venda mais difícil)');
  }

  if (l._temIfood === 'sim' && !l.tem_plataforma_propria) {
    score += 1;
    motivos.push('depende do iFood — pitch: reduzir comissão com canal próprio');
  }

  if (l.so_social) { score += 1; motivos.push('só divulga no Instagram/Linktree'); }

  if (l.num_avaliacoes >= 30) { score += 1; motivos.push('negócio ativo/estabelecido'); }
  else if (l.num_avaliacoes < 5) { score -= 1; motivos.push('pouca presença online'); }

  l.lead_score = score;
  l.motivo = motivos.join('; ');
  return l;
}

// --------------------------------------------------------------------------
// WhatsApp real via Evolution API (opcional)
// --------------------------------------------------------------------------
async function verifyWhatsappBatch(leads) {
  const base = process.env.EVOLUTION_API_URL;
  const token = process.env.TOKEN_EVOLUTION || process.env.API_KEY_EVOLUTION;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!base || !token || !instance) {
    console.warn('\n⚠️  --verify-whatsapp ignorado: defina EVOLUTION_API_URL, TOKEN_EVOLUTION e EVOLUTION_INSTANCE no .env');
    return;
  }

  const targets = leads.filter((l) => l.telefone_e164);
  console.log(`\n📱 Verificando WhatsApp de ${targets.length} números via Evolution API (em lotes)...`);

  const CHUNK = 20;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const slice = targets.slice(i, i + CHUNK);
    try {
      const { data } = await axios.post(
        `${base.replace(/\/$/, '')}/chat/whatsappNumbers/${instance}`,
        { numbers: slice.map((l) => l.telefone_e164) },
        { headers: { apikey: token, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const map = new Map((data || []).map((r) => [onlyDigits(r.number), r.exists]));
      for (const l of slice) {
        const exists = map.get(onlyDigits(l.telefone_e164));
        l.whatsapp_verificado = exists === true ? 'sim' : exists === false ? 'não' : '';
      }
    } catch (err) {
      console.warn(`   lote ${i / CHUNK + 1}: erro (${err.response?.status || err.message})`);
    }
    await sleep(1200); // evita flood na instância
  }
}

// --------------------------------------------------------------------------
// CSV
// --------------------------------------------------------------------------
function writeCsv(leads, outPath) {
  const cols = [
    ['nome', 'Nome'],
    ['categoria', 'Categoria'],
    ['telefone', 'Telefone'],
    ['whatsapp_provavel', 'WhatsApp (provável)'],
    ['whatsapp_verificado', 'WhatsApp (verificado)'],
    ['delivery', 'Delivery'],
    ['tem_ifood', 'Tem iFood'],
    ['plataforma_pedido', 'Plataforma de pedido'],
    ['tem_cardapio_online', 'Cardápio online'],
    ['site', 'Site'],
    ['nota', 'Nota'],
    ['num_avaliacoes', 'Nº avaliações'],
    ['distancia_km', 'Distância (km)'],
    ['endereco', 'Endereço'],
    ['lead_score', 'Score'],
    ['motivo', 'Por que é lead'],
    ['google_maps_url', 'Google Maps'],
    ['place_id', 'Place ID'],
  ];
  const header = cols.map((c) => csvCell(c[1])).join(',');
  const rows = leads.map((l) => cols.map((c) => csvCell(l[c[0]])).join(','));
  const csv = '﻿' + [header, ...rows].join('\r\n'); // BOM p/ Excel abrir acentos certo
  fs.writeFileSync(outPath, csv, 'utf8');
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// --------------------------------------------------------------------------
// Utils
// --------------------------------------------------------------------------
function parsePhone(raw) {
  const digits = onlyDigits(raw);
  let national = digits;
  if (national.startsWith('55') && national.length > 11) national = national.slice(2);
  // national esperado: DDD (2) + numero (8 ou 9)
  const isMobile = national.length === 11 && national[2] === '9';
  const e164 = national.length >= 10 ? '55' + national : '';
  return {
    telefone: raw || '',
    whatsappProvavel: isMobile,
    e164,
  };
}

function haversineKm(a, b) {
  if (!b || b.latitude == null) return Infinity;
  const R = 6371;
  const dLat = deg(b.latitude - a.lat);
  const dLng = deg(b.longitude - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg(a.lat)) * Math.cos(deg(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
const deg = (d) => (d * Math.PI) / 180;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function handlePlacesError(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.error?.message || err.message;
  if (status === 403) {
    console.error(`     → 403: verifique se a "Places API (New)" está HABILITADA e se a chave permite este uso. (${msg})`);
  } else if (status === 400) {
    console.error(`     → 400: ${msg}`);
  } else {
    console.error(`     → ${status || ''} ${msg}`);
  }
}

function printSummary(leads) {
  const n = leads.length || 1;
  const whats = leads.filter((l) => l._whatsappProvavel).length;
  const ifood = leads.filter((l) => l._temIfood === 'sim').length;
  const semPlat = leads.filter((l) => !l.tem_plataforma_propria).length;
  const top = leads.slice(0, 10);
  console.log('\n📊 Resumo:');
  console.log(`   WhatsApp provável: ${whats}/${leads.length}`);
  console.log(`   Já no iFood:       ${ifood}/${leads.length}`);
  console.log(`   Sem plataforma própria (melhor pitch): ${semPlat}/${leads.length}`);
  console.log('\n🏆 Top 10 leads:');
  top.forEach((l, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. [${l.lead_score}] ${l.nome} — ${l.telefone} (${l.distancia_km}km)`);
  });
}
