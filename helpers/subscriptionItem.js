// Assinaturas (Fase 1): configuração do plano recorrente no próprio item do
// catálogo (menu_items.subscription_*) — migration "Assinaturas (Fase 1)" em
// DB_CHANGES_NEEDED.md. Normalizadores puros + regra de acesso; sem banco.
//
// Regras do produto (decididas com o negócio):
// - cobrança só no cartão de crédito, split 95% loja / 5% Arbian, sem taxa fixa;
// - sem prazo (perpétua) ou com N cobranças (ex.: 12 mensais = 1 ano);
// - serviço: limite de usos por ciclo de cobrança (null = ilimitado).
//
// Itens de assinatura ficam fora das vendas avulsas (cardápio, carrinho,
// agendamento, catálogo da IA). Na vitrine pública aparecem só numa seção
// própria (`subscriptions`), com o plano, quando SUBSCRIPTIONS_RELEASED=true
// ou quando a loja está em SUBSCRIPTIONS_PREVIEW_COMPANY_IDS (teste por loja).

const INTERVALS = ["week", "month", "year"];
const MAX_DURATION_CYCLES = 120;
const MAX_USAGE_LIMIT = 100;

const SUBSCRIPTION_COLUMNS = [
  "subscription_enabled",
  "subscription_interval",
  "subscription_duration_cycles",
  "subscription_usage_limit",
];

const _badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const _optionalInt = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
};

/** Flag de liberação geral (comerciantes e vitrine pública). */
const subscriptionsReleased = () => String(process.env.SUBSCRIPTIONS_RELEASED || "").toLowerCase() === "true";

/** Lojas liberadas antes da liberação geral (ex.: SUBSCRIPTIONS_PREVIEW_COMPANY_IDS=25,31). */
const subscriptionPreviewCompanyIds = () =>
  String(process.env.SUBSCRIPTIONS_PREVIEW_COMPANY_IDS || "")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);

/** Vitrine e contratação: liberação geral ou loja em teste. */
const subscriptionsReleasedFor = (companyId) =>
  subscriptionsReleased() || subscriptionPreviewCompanyIds().includes(Number(companyId));

/**
 * Por enquanto só admins do sistema cadastram assinaturas. Para liberar a todos
 * os comerciantes: SUBSCRIPTIONS_RELEASED=true na API e
 * kSubscriptionsReleasedToAll = true no portal.
 */
const canManageSubscriptions = (req) => req?.isSystemAdmin === true || subscriptionsReleased();

const hasSubscriptionPayload = (data) =>
  SUBSCRIPTION_COLUMNS.some((k) => Object.prototype.hasOwnProperty.call(data || {}, k));

/**
 * Normaliza a configuração da assinatura. Desligada zera os demais campos; o
 * limite de usos só vale para serviços.
 */
const normalizeSubscriptionFields = (data, { isService = false } = {}) => {
  const enabled = data?.subscription_enabled === true;
  if (!enabled) {
    return { enabled: false, interval: null, durationCycles: null, usageLimit: null };
  }

  const interval = INTERVALS.includes(data.subscription_interval) ? data.subscription_interval : null;
  if (!interval) throw _badRequest("Escolha a frequência da cobrança da assinatura.");

  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw _badRequest("A assinatura precisa de um preço maior que zero.");
  }

  const durationCycles = _optionalInt(data.subscription_duration_cycles);
  if (Number.isNaN(durationCycles) || (durationCycles !== null && (durationCycles < 1 || durationCycles > MAX_DURATION_CYCLES))) {
    throw _badRequest(`O prazo da assinatura deve ficar entre 1 e ${MAX_DURATION_CYCLES} cobranças.`);
  }

  let usageLimit = null;
  if (isService) {
    usageLimit = _optionalInt(data.subscription_usage_limit);
    if (Number.isNaN(usageLimit) || (usageLimit !== null && (usageLimit < 1 || usageLimit > MAX_USAGE_LIMIT))) {
      throw _badRequest(`O limite de usos por ciclo deve ficar entre 1 e ${MAX_USAGE_LIMIT}.`);
    }
  }

  return { enabled: true, interval, durationCycles, usageLimit };
};

/** Filtro SQL que tira itens de assinatura das vendas avulsas. */
const notSubscriptionSql = (alias) => {
  const col = alias ? `${alias}.subscription_enabled` : "subscription_enabled";
  return `AND COALESCE(${col}, false) = false`;
};

/**
 * Item de assinatura no formato da vitrine pública (Fase 3). Devolve null quando
 * o plano está incompleto (sem frequência válida ou sem preço).
 */
const publicSubscriptionPlan = (row) => {
  if (!row || !INTERVALS.includes(row.subscription_interval)) return null;
  const price = Number(row.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const isService = row.item_type === "service";
  const duration = _optionalInt(row.subscription_duration_cycles);
  const usage = isService ? _optionalInt(row.subscription_usage_limit) : null;
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || null,
    price,
    image_url: row.image_url || null,
    images: Array.isArray(row.images) ? row.images : [],
    item_type: isService ? "service" : "product",
    has_options: row.has_options === true,
    interval: row.subscription_interval,
    duration_cycles: Number.isInteger(duration) && duration > 0 ? duration : null,
    usage_limit: Number.isInteger(usage) && usage > 0 ? usage : null,
  };
};

module.exports = {
  INTERVALS,
  SUBSCRIPTION_COLUMNS,
  subscriptionsReleased,
  subscriptionPreviewCompanyIds,
  subscriptionsReleasedFor,
  canManageSubscriptions,
  hasSubscriptionPayload,
  publicSubscriptionPlan,
  normalizeSubscriptionFields,
  notSubscriptionSql,
};
