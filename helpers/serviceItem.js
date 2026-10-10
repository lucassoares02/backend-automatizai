// Normalizadores puros dos "serviços" do catálogo (menu_items.item_type =
// 'service'), da galeria de fotos e da agenda dos profissionais. Sem acesso ao
// banco para poderem ser testados isoladamente.

const ITEM_TYPES = ["product", "service"];
const PRICE_TYPES = ["fixed", "from"];
const MIN_DURATION = 5;
const MAX_DURATION = 1440;
const MAX_BUFFER = 240;
const MAX_IMAGES = 12;

const _badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const _optionalInt = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * Tipo do item + campos específicos de serviço. Para produto, zera os campos de
 * serviço (duração nula, intervalo 0, preço fixo).
 */
const normalizeServiceFields = ({ item_type, duration_minutes, buffer_minutes, price_type }) => {
  const itemType = ITEM_TYPES.includes(item_type) ? item_type : "product";
  if (itemType === "product") {
    return { itemType, durationMinutes: null, bufferMinutes: 0, priceType: "fixed" };
  }

  const duration = _optionalInt(duration_minutes);
  if (duration === null || Number.isNaN(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    throw _badRequest(`Informe a duração do serviço entre ${MIN_DURATION} e ${MAX_DURATION} minutos.`);
  }

  const buffer = _optionalInt(buffer_minutes) ?? 0;
  if (Number.isNaN(buffer) || buffer < 0 || buffer > MAX_BUFFER) {
    throw _badRequest(`O intervalo após o serviço deve ficar entre 0 e ${MAX_BUFFER} minutos.`);
  }

  return {
    itemType,
    durationMinutes: duration,
    bufferMinutes: buffer,
    priceType: PRICE_TYPES.includes(price_type) ? price_type : "fixed",
  };
};

/**
 * Galeria: aceita ["url", ...] ou [{ url }, ...]. Mantém a ordem recebida, sem
 * vazios nem duplicadas. Retorna null quando o payload não traz galeria (o
 * chamador então preserva as fotos atuais).
 */
const normalizeImageUrls = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const urls = [];
  for (const entry of value) {
    const raw = typeof entry === "string" ? entry : entry?.url;
    if (typeof raw !== "string") continue;
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (urls.length > MAX_IMAGES) {
    throw _badRequest(`Cada item pode ter no máximo ${MAX_IMAGES} fotos.`);
  }
  return urls;
};

/** Lista de ids inteiros positivos, sem duplicados. null quando ausente. */
const normalizeIdList = (value) => {
  if (!Array.isArray(value)) return null;
  const ids = new Set();
  for (const v of value) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return [...ids];
};

const _TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const _toMinutes = (time) => {
  const m = _TIME_RE.exec(String(time || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const _fmt = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Jornada semanal do profissional: [{ weekday 0-6, start_time "HH:MM", end_time }].
 * Valida início < fim e rejeita turnos sobrepostos no mesmo dia.
 */
const normalizeWorkingHours = (value) => {
  if (!Array.isArray(value)) throw _badRequest("Envie a jornada como uma lista de turnos.");
  const rows = value.map((entry) => {
    const weekday = Number(entry?.weekday);
    const start = _toMinutes(entry?.start_time);
    const end = _toMinutes(entry?.end_time);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw _badRequest("Dia da semana inválido na jornada.");
    }
    if (start === null || end === null) throw _badRequest("Horário inválido na jornada (use HH:MM).");
    if (end <= start) throw _badRequest("O fim do turno deve ser depois do início.");
    return { weekday, start, end };
  });

  rows.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.weekday === cur.weekday && cur.start < prev.end) {
      throw _badRequest("Há turnos sobrepostos no mesmo dia da jornada.");
    }
  }
  return rows.map((r) => ({ weekday: r.weekday, start_time: _fmt(r.start), end_time: _fmt(r.end) }));
};

/** Folga/bloqueio: datas ISO válidas com fim depois do início. */
const normalizeTimeOff = ({ starts_at, ends_at, reason }) => {
  const start = new Date(starts_at);
  const end = new Date(ends_at);
  if (!starts_at || !ends_at || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw _badRequest("Informe início e fim da folga.");
  }
  if (end <= start) throw _badRequest("O fim da folga deve ser depois do início.");
  const text = typeof reason === "string" ? reason.trim() : "";
  return { startsAt: start.toISOString(), endsAt: end.toISOString(), reason: text || null };
};

module.exports = {
  MAX_IMAGES,
  normalizeServiceFields,
  normalizeImageUrls,
  normalizeIdList,
  normalizeWorkingHours,
  normalizeTimeOff,
};
