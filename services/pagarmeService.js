const axios = require("axios");
const crypto = require("crypto");
const net = require("net");
const pool = require("../db");
const identityService = require("./identityService");
const { columnExists, tableExists } = require("../helpers/schema");
const { createPaymentSession } = require("../helpers/publicPaymentSession");

// ─── Cliente Pagar.me (API v5 — "Core API") ────────────────────────────────────
// Modelo marketplace: cada empresa é um RECEBEDOR (recipient) no Pagar.me; o
// valor do pedido é dividido (split) entre o recebedor da LOJA e o recebedor da
// PLATAFORMA, que retém a taxa. Autenticação: HTTP Basic com a secret key
// (sk_...) como usuário e senha em branco.
//
// Inicialização preguiçosa: ambientes sem Pagar.me continuam subindo; só as
// rotas Pagar.me é que falham (503) quando a chave não está configurada.

const API_URL = (process.env.PAGARME_API_URL || "https://api.pagar.me/core/v5").replace(/\/$/, "");

let _http = null;
const getHttp = () => {
  if (_http) return _http;
  const key = process.env.PAGARME_SECRET_KEY;
  if (!key) {
    throw Object.assign(new Error("Pagar.me não configurado (PAGARME_SECRET_KEY ausente)."), { status: 503 });
  }
  _http = axios.create({
    baseURL: API_URL,
    // Basic auth: secret key como usuário, senha vazia.
    auth: { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });
  return _http;
};

// Achata o objeto/array `errors` do Pagar.me em uma string legível para
// diagnóstico (ex.: "request.register_information.birthdate: campo inválido").
const _formatErrors = (errors) => {
  if (!errors) return "";
  if (Array.isArray(errors)) {
    return errors
      .map((e) => (typeof e === "string" ? e : e?.message || JSON.stringify(e)))
      .join("; ");
  }
  if (typeof errors === "object") {
    return Object.entries(errors)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(" | ");
  }
  return String(errors);
};

// O provedor devolve "Invalid request payload" para vários campos. Essa frase
// não ajuda quem está pagando e os detalhes crus podem mudar entre versões da
// API. Traduzimos apenas as validações conhecidas do checkout e preservamos o
// corpo original exclusivamente no log redigido abaixo.
const _friendlyPaymentValidationMessage = (data, fallback) => {
  const message = String(data?.message || "").trim();
  const details = _formatErrors(data?.errors || data?.details);
  const context = `${message} ${details}`.toLowerCase();
  const isGenericValidation = /invalid request payload|the request is invalid|request is invalid|validation error/.test(context);
  const isCheckoutFailure = /pagamento|cart[aã]o|pix/i.test(String(fallback || ""));

  if ((isGenericValidation || isCheckoutFailure) && /billing|billing_address|zip_code|line_1|line_2|\baddress\b/.test(context)) {
    return "Informe um endereço de cobrança completo: rua, número, bairro, cidade, estado e CEP.";
  }
  if ((isGenericValidation || isCheckoutFailure) && /\bemail\b/.test(context)) {
    return "Informe um e-mail válido do titular para concluir o pagamento.";
  }
  if ((isGenericValidation || isCheckoutFailure) && /document|\bcpf\b|\bcnpj\b/.test(context)) {
    return "Informe um CPF ou CNPJ válido do titular para concluir o pagamento.";
  }
  if ((isGenericValidation || isCheckoutFailure) && /card_token|card_id|\bcard\b|\bcvv\b|exp_month|exp_year|holder_name/.test(context)) {
    return "Revise os dados do cartão e tente novamente.";
  }
  if (isGenericValidation) {
    return "Não foi possível validar os dados do pagamento. Revise as informações e tente novamente.";
  }
  return message || fallback || "Erro no Pagar.me";
};

// Normaliza erros do axios para o padrão { message, status } do projeto. Os
// detalhes técnicos ficam no log redigido; para o checkout devolvemos uma
// orientação segura e acionável em vez de texto cru do provedor.
const _wrap = (error, fallback) => {
  const status = error?.response?.status || error?.status || 500;
  const data = error?.response?.data;
  const apiMsg = _friendlyPaymentValidationMessage(data, error?.message || fallback);
  // Respostas podem conter PII e dados sensíveis do meio de pagamento.
  if (data) console.error("Pagar.me API error body:", JSON.stringify(_redact(data)));
  const err = new Error(apiMsg || fallback || "Erro no Pagar.me");
  err.status = status >= 400 && status < 500 ? status : 502;
  return err;
};

// Remove recursivamente campos null/undefined/string-vazia de um objeto — o
// Pagar.me recusa (400 "The request is invalid.") quando campos opcionais chegam
// com valor null. Arrays são preservados (apenas prunados item a item).
const _pruneEmpty = (value) => {
  if (Array.isArray(value)) {
    return value.map(_pruneEmpty);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      out[k] = _pruneEmpty(v);
    }
    return out;
  }
  return value;
};

// O Pagar.me exige birthdate no formato MM/DD/YYYY. O formulário envia AAAA-MM-DD;
// converte aqui de forma robusta (aceita AAAA-MM-DD e AAAA/MM/DD; se já vier com
// barra no formato americano, passa direto).
const _normalizeBirthdate = (s) => {
  const v = String(s || "").trim();
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); // AAAA-MM-DD
  if (m) {
    const mm = m[2].padStart(2, "0");
    const dd = m[3].padStart(2, "0");
    return `${mm}/${dd}/${m[1]}`;
  }
  return v; // já em MM/DD/YYYY (ou formato que o Pagar.me valida)
};

// address/main_address: complementary e reference_point são subcampos exigidos
// pelo Pagar.me quando o endereço é enviado. Preenche placeholder quando vazios.
const _normalizeAddress = (addr) => {
  if (!addr || typeof addr !== "object") return addr;
  const a = { ...addr };
  const fill = (k) => {
    if (a[k] == null || String(a[k]).trim() === "") a[k] = "N/A";
  };
  fill("complementary");
  fill("reference_point");
  return a;
};

// Normaliza register_information antes de enviar: data no formato do Pagar.me e
// subcampos obrigatórios do endereço preenchidos.
const _normalizeRegisterInformation = (ri) => {
  if (!ri || typeof ri !== "object") return ri;
  const out = { ...ri };
  if (out.birthdate) out.birthdate = _normalizeBirthdate(out.birthdate);
  if (out.address) out.address = _normalizeAddress(out.address);
  if (out.main_address) out.main_address = _normalizeAddress(out.main_address);
  return out;
};

const PLATFORM_FEE_PERCENT = Number(process.env.PAGARME_PLATFORM_FEE_PERCENT ?? 10);
const PLATFORM_RECIPIENT_ID = process.env.PAGARME_PLATFORM_RECIPIENT_ID || null;
const APP_URL = (process.env.PUBLIC_APP_URL || process.env.ORIGIN || "").replace(/\/$/, "");
// Valor mínimo de saque (em REAIS). Configurável — ajuste para o mínimo real da
// sua conta Pagar.me. Default conservador de R$ 1,00.
const MIN_WITHDRAWAL = Number(process.env.PAGARME_MIN_WITHDRAWAL_AMOUNT ?? 1);
const SAVED_CARDS_ENABLED = String(process.env.PAGARME_SAVED_CARDS_ENABLED || "false").toLowerCase() === "true";
const WEBHOOK_AUTH_REQUIRED = String(process.env.PAGARME_WEBHOOK_AUTH_REQUIRED || "true").toLowerCase() !== "false";
// Texto exibido na fatura do cartão do cliente (soft/statement descriptor).
// Fixo e global para todas as lojas — máx. 13 caracteres, só letras/números/espaço.
// Se não configurado, cai no nome da empresa (comportamento anterior).
const STATEMENT_DESCRIPTOR = String(process.env.PAGARME_STATEMENT_DESCRIPTOR || "").trim();
const _buildStatementDescriptor = (fallback) =>
  String(STATEMENT_DESCRIPTOR || fallback || "Loja").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 13);
const THREE_DS_ENABLED = String(process.env.PAGARME_3DS_ENABLED || "false").toLowerCase() === "true";
const THREE_DS_API_URL = (process.env.PAGARME_3DS_API_URL || (
  /^(sk|pk)_test_/.test(String(process.env.PAGARME_SECRET_KEY || ""))
    ? "https://3ds-sdx.stone.com.br/v2"
    : "https://3ds.stone.com.br/v2"
)).replace(/\/$/, "");

// Perfil comercial informado pela Pagar.me no documento fornecido pela Arbian:
// "Taxas e Prazos (e-Commerce)", emitido em 15/08/2026 para a conta
// 38.034.794/0001-87. Estas são condições contratuais da conta, e não valores
// estimados pela aplicação. A taxa REAL de cada recebível continua vindo de
// `GET /payables`; o perfil abaixo serve para explicar a regra antes da venda.
const PAGARME_CONTRACT_FEE_PROFILE = Object.freeze({
  source: {
    name: "Pagar.me — Taxas e Prazos (e-Commerce)",
    issued_at: "2026-08-15",
    account_document: "38.034.794/0001-87",
    scope: "pagarme_account",
  },
  currency: "BRL",
  processing: {
    fixed: 0.55,
    rule: "Por transação aprovada",
  },
  antifraud_credit: {
    fixed: 0.44,
    rule: "Por transação de crédito",
  },
  pix: {
    percentage: 1.09,
    settlement: "No mesmo dia, após pagamento e conciliação",
  },
  credit_card: {
    brands: ["Visa", "Mastercard", "Elo", "Amex", "Hipercard"],
    rates: [
      { installments_from: 1, installments_to: 1, percentage: 3.19 },
      { installments_from: 2, installments_to: 6, percentage: 4.49 },
      { installments_from: 7, installments_to: 18, percentage: 4.99 },
    ],
    settlement: "Na data de vencimento de cada parcela; em fins de semana e feriados, no próximo dia útil",
  },
  debit_card: {
    available: false,
    message: "Informação não disponível no documento de taxas atual.",
  },
  boleto: {
    fixed: 3.19,
    refund_fixed: 3.19,
    settlement: "Em 2 dias úteis após pagamento e conciliação",
  },
  anticipation: {
    enabled: false,
    percentage: null,
    message: "Antecipação automática inativa; taxa não informada no documento.",
  },
  transfer: {
    fixed: 3.67,
    rule: "Transferência para outras contas",
  },
});

const _redact = (value) => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(_redact);
  const sensitive = /(?:authorization|token|card|document|email|phone|cvv|number)/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitive.test(key) ? "[redacted]" : _redact(item),
  ]));
};

const _paymentLog = (event, data = {}) => {
  console.info("pagarme.payment", { event, ..._redact(data) });
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

// "active" é o único status em que o recebedor pode transacionar.
const _isActiveStatus = (status) => String(status || "").toLowerCase() === "active";

// A API v5 exige os três campos para atualizar transfer_settings, inclusive
// quando a transferência automática está desligada. Mantemos a validação na
// service para que qualquer chamador receba o mesmo contrato seguro.
const _normalizeTransferSettings = (settings) => {
  if (!settings || typeof settings !== "object" || typeof settings.transfer_enabled !== "boolean") {
    throw Object.assign(new Error("transfer_enabled deve ser verdadeiro ou falso."), { status: 400 });
  }

  const interval = String(settings.transfer_interval || "").trim().toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(interval)) {
    throw Object.assign(new Error("transfer_interval deve ser daily, weekly ou monthly."), { status: 400 });
  }

  const day = Number(settings.transfer_day);
  if (!Number.isInteger(day)) {
    throw Object.assign(new Error("transfer_day deve ser um número inteiro."), { status: 400 });
  }
  if (interval === "daily" && day !== 0) {
    throw Object.assign(new Error("Para transferências diárias, transfer_day deve ser 0."), { status: 400 });
  }
  if (interval === "weekly" && (day < 1 || day > 5)) {
    throw Object.assign(new Error("Para transferências semanais, transfer_day deve estar entre 1 e 5."), { status: 400 });
  }
  if (interval === "monthly" && (day < 1 || day > 31)) {
    throw Object.assign(new Error("Para transferências mensais, transfer_day deve estar entre 1 e 31."), { status: 400 });
  }

  // A documentação aceita os nomes minúsculos; a API também devolve os enums
  // com inicial maiúscula em algumas contas. Padronizamos o envio no formato
  // usado no restante da integração atual.
  return {
    transfer_enabled: settings.transfer_enabled,
    transfer_interval: interval[0].toUpperCase() + interval.slice(1),
    transfer_day: day,
  };
};

const _publicTransferSettings = (settings) => {
  if (!settings || typeof settings !== "object") return null;
  const interval = String(settings.transfer_interval || "").toLowerCase();
  return {
    transfer_enabled: settings.transfer_enabled === true || settings.transfer_enabled === "true",
    transfer_interval: ["daily", "weekly", "monthly"].includes(interval) ? interval : null,
    transfer_day: Number.isInteger(Number(settings.transfer_day)) ? Number(settings.transfer_day) : null,
  };
};

// A Pagar.me exige um SEGUNDO FATOR de autenticação para alterações sensíveis do
// recebedor (troca de conta bancária, principalmente). Detecta essa recusa para
// tratá-la de forma amigável, em vez de propagar
// "Request_denied. Second authentication factor is necessary".
const _is2FAError = (error) => {
  const data = error?.response?.data;
  const parts = [data?.message, _formatErrors(data?.errors), error?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return parts.includes("second authentication factor") || parts.includes("segundo fator");
};

// Compara os campos que identificam a conta bancária. Serve para NÃO refazer o
// PATCH da conta (e disparar o 2FA) quando o comerciante só editou nome/endereço.
const _bankAccountChanged = (current, next) => {
  if (!next) return false;
  if (!current) return true;
  const digits = (v) => String(v ?? "").replace(/\D/g, "");
  const eqDigits = (a, b) => digits(a) === digits(b);
  const eqText = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  return (
    !eqDigits(current.bank, next.bank) ||
    !eqDigits(current.branch_number, next.branch_number) ||
    !eqDigits(current.branch_check_digit, next.branch_check_digit) ||
    !eqDigits(current.account_number, next.account_number) ||
    !eqDigits(current.account_check_digit, next.account_check_digit) ||
    !eqText(current.type, next.type) ||
    !eqDigits(current.holder_document, next.holder_document) ||
    !eqText(current.holder_type, next.holder_type)
  );
};

// Quebra um telefone brasileiro em { country_code, area_code, number }.
const _parsePhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  // Remove DDI 55 quando presente (11 ou 10 dígitos = DDD + número).
  const local = digits.length > 11 && digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length < 10) return null;
  return {
    country_code: "55",
    area_code: local.slice(0, 2),
    number: local.slice(2),
  };
};

const _onlyDigits = (v) => String(v || "").replace(/\D/g, "");

// E-mail simples e válido? O antifraude penaliza fortemente e-mail de domínio
// inexistente (o antigo `@sem-email.automatizai` derrubava toda cobrança de
// cartão). Só aceitamos um e-mail com cara de real.
const _isPlausibleEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || "").trim());

// Monta o objeto customer do pedido a partir do cliente + dados informados no
// checkout. `billingAddress` (quando disponível) vai também em customer.address —
// o antifraude usa o endereço do titular para pontuar a transação.
// Gera um e-mail sintético a partir do nome do cliente quando não há e-mail real:
// padrão nome.sobrenome@arbian.com.br (só o nome quando não houver sobrenome).
// Assim o cliente não precisa digitar e-mail e a cobrança não trava por "e-mail
// obrigatório". Trade-off: e-mail sintético reduz a qualidade do antifraude e não
// serve para comunicação real — por isso só é usado como fallback.
const _SYNTHETIC_EMAIL_DOMAIN = "arbian.com.br";
const _syntheticEmail = (name) => {
  const clean = (s) => String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  const first = clean(parts[0]);
  const last = parts.length > 1 ? clean(parts[parts.length - 1]) : "";
  const local = last ? `${first}.${last}` : first;
  return local ? `${local}@${_SYNTHETIC_EMAIL_DOMAIN}` : null;
};

const _buildCustomer = (client, extra = {}, billingAddress = null) => {
  // Documento informado no pagamento OU o já salvo no cadastro do cliente.
  const doc = _onlyDigits(extra.document || client.client_document || client.document);
  const phone = _parsePhone(extra.phone || client.client_phone || client.phone);
  const name = (extra.name || client.client_name || client.name || "Cliente").slice(0, 64);
  // E-mail real (informado OU salvo no cadastro) tem prioridade; sem ele, gera um
  // sintético do nome para o cliente não precisar digitar.
  const rawEmail = extra.email || client.client_email || client.email;
  const email = _isPlausibleEmail(rawEmail)
    ? String(rawEmail).trim().toLowerCase()
    : _syntheticEmail(name);
  const customer = {
    name,
    type: doc.length > 11 ? "company" : "individual",
  };
  if (email) customer.email = email;
  if (doc.length === 11 || doc.length === 14) customer.document = doc;
  if (phone) customer.phones = { mobile_phone: phone };
  // Endereço do titular para o antifraude (mesmo shape do billing_address).
  if (billingAddress) customer.address = billingAddress;
  return customer;
};

// Estados brasileiros: o Pagar.me exige a UF de 2 letras. O cadastro pode ter o
// estado por extenso ("Espírito Santo"); convertê-lo por slice(0,2) acertava só
// por coincidência (ex.: "São Paulo" virava "SA", "Minas Gerais" -> "MI").
const _UF_SET = new Set(["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]);
const _UF_BY_NAME = {
  "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM", "bahia": "BA",
  "ceara": "CE", "distrito federal": "DF", "espirito santo": "ES", "goias": "GO",
  "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
  "minas gerais": "MG", "para": "PA", "paraiba": "PB", "parana": "PR",
  "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS", "rondonia": "RO",
  "roraima": "RR", "santa catarina": "SC", "sao paulo": "SP", "sergipe": "SE",
  "tocantins": "TO",
};
// Converte o estado (por extenso OU sigla) na UF de 2 letras. Sigla válida é
// mantida; sem correspondência, cai nas 2 primeiras letras (comportamento antigo).
const _stateToUf = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  const upper = s.toUpperCase();
  if (upper.length === 2 && _UF_SET.has(upper)) return upper;
  const key = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return _UF_BY_NAME[key] || upper.replace(/[^A-Z]/g, "").slice(0, 2);
};

// Converte um conjunto de campos (rua/número/bairro/cidade/UF/CEP) no formato
// billing_address do Pagar.me. Retorna null se faltar algum campo obrigatório
// (line_1, zip_code, city, state) — evita enviar um endereço incompleto.
const _toBillingAddress = ({ street, number, neighborhood, complement, city, state, zip }) => {
  const zipDigits = _onlyDigits(zip).slice(0, 8);
  const uf = _stateToUf(state);
  const cityName = String(city || "").trim().slice(0, 64);
  // line_1 no formato do Pagar.me: "número, rua, bairro".
  const line1 = [number, street, neighborhood]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ");
  if (zipDigits.length !== 8 || !/^[A-Z]{2}$/.test(uf) || !cityName || !line1) return null;
  const line2 = String(complement || "").trim();
  return {
    line_1: line1.slice(0, 256),
    ...(line2 ? { line_2: line2.slice(0, 128) } : {}),
    zip_code: zipDigits,
    city: cityName,
    state: uf,
    country: "BR",
  };
};

// A tela pode enviar o endereço de cobrança explicitamente (essencial para
// retirada e pedidos legados, que não têm endereço de entrega). Aceitamos o
// shape já usado pela Pagar.me e o shape semântico do checkout, mas validamos e
// normalizamos no servidor antes de repassá-lo ao provedor.
const _billingAddressFromInput = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.line_1 != null) {
    const zipCode = _onlyDigits(value.zip_code).slice(0, 8);
    const state = _stateToUf(value.state);
    const city = String(value.city || "").trim().slice(0, 64);
    const line1 = String(value.line_1 || "").trim().slice(0, 256);
    const line2 = String(value.line_2 || "").trim().slice(0, 128);
    if (zipCode.length !== 8 || !/^[A-Z]{2}$/.test(state) || !city || !line1) return null;
    return {
      line_1: line1,
      // O SDK 3DS exige line_2; quando o cliente não tem complemento, o
      // marcador representa corretamente a ausência sem inventar endereço.
      line_2: line2 || "-",
      zip_code: zipCode,
      city,
      state,
      country: "BR",
    };
  }
  return _toBillingAddress({
    street: value.street,
    number: value.number,
    neighborhood: value.neighborhood,
    complement: value.complement,
    city: value.city,
    state: value.state,
    zip: value.zip || value.zip_code,
  });
};

// Monta o billing_address exigido pelo antifraude do Pagar.me em cobranças no
// cartão. Quando o cliente informa um endereço na tela de pagamento, ele tem
// precedência. Sem ele, usa o snapshot imutável do pedido — nunca o endereço
// atual da loja e nunca um endereço salvo posteriormente pelo cliente.
const _buildBillingAddress = (order, explicitAddress) => {
  if (explicitAddress !== undefined && explicitAddress !== null) {
    return _billingAddressFromInput(explicitAddress);
  }
  const { address } = _deliveryAddressSource(order);
  return _toBillingAddress({
    street: address.street, number: address.number, neighborhood: address.neighborhood,
    complement: address.complement, city: address.city, state: address.state, zip: address.zip || address.zip_code,
  });
};

const _asObject = (value) => {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
};

// O endereço de entrega precisa representar o pedido, e não o último endereço
// salvo pelo cliente. Pedidos criados antes da coluna de snapshot usam o endereço
// ativo apenas como fallback de compatibilidade.
const _deliveryAddressSource = (order) => {
  const snapshot = _asObject(order.delivery_address_snapshot);
  if (snapshot) return { address: snapshot, source: "order_snapshot" };
  return {
    source: "active_customer_address",
    address: {
      street: order.cli_street,
      number: order.cli_number,
      neighborhood: order.cli_neighborhood,
      complement: order.cli_complement,
      city: order.cli_city,
      state: order.cli_state,
      zip: order.cli_zip,
    },
  };
};

const _buildShipping = (order) => {
  if (order.delivery_type !== true) return null;
  const { address, source } = _deliveryAddressSource(order);
  const shippingAddress = _toBillingAddress({
    street: address.street,
    number: address.number,
    neighborhood: address.neighborhood,
    complement: address.complement,
    city: address.city,
    state: address.state,
    zip: address.zip || address.zip_code,
  });
  if (!shippingAddress) return null;
  const recipientName = String(order.client_name || "Cliente").trim().slice(0, 64);
  const recipientPhone = _onlyDigits(order.client_phone);
  return {
    shipping: _pruneEmpty({
      amount: Math.max(0, Math.round(Number(order.delivery_fee || 0) * 100)),
      description: "Entrega do pedido",
      recipient_name: recipientName,
      recipient_phone: recipientPhone || undefined,
      address: shippingAddress,
    }),
    source,
  };
};

const _normalizeClientIp = (value) => {
  const ip = String(value || "").trim().replace(/^::ffff:/i, "");
  const family = net.isIP(ip);
  if (!family) return null;

  // Endereços internos descrevem o proxy/rede local, não o comprador. Enviá-los
  // reduz a qualidade do antifraude e pode expor topologia interna.
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) return null;
  } else {
    const normalized = ip.toLowerCase();
    if (
      normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    ) return null;
  }
  return ip;
};

const _normalizeRiskSessionId = (value) => {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,100}$/.test(id) ? id : null;
};

const _normalizeRiskLocation = (value) => {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
};

const _buildOrderRiskContext = (order, extra = {}) => {
  const delivery = _buildShipping(order);
  const platform = String(extra.devicePlatform || "").trim().slice(0, 100);
  const clientIp = _normalizeClientIp(extra.clientIp);
  const riskSessionId = _normalizeRiskSessionId(extra.riskSessionId);
  const location = _normalizeRiskLocation(extra.location);
  return {
    ...(delivery?.shipping ? { shipping: delivery.shipping } : {}),
    ...(delivery?.source ? { shipping_source: delivery.source } : {}),
    ...(clientIp ? { ip: clientIp } : {}),
    ...(riskSessionId ? { session_id: riskSessionId } : {}),
    ...(location ? { location } : {}),
    ...(platform ? { device: { platform } } : {}),
  };
};

// ─── Persistência (companies / orders) ─────────────────────────────────────────

const _getCompany = async (companyId) => {
  const r = await pool.query(
    `SELECT id, name, uuid, pagarme_recipient_id, pagarme_charges_enabled, pagarme_recipient_status
     FROM companies WHERE id = $1`,
    [companyId],
  );
  return r.rows[0] || null;
};

const _saveRecipientId = async (companyId, recipientId, status) => {
  await pool.query(
    `UPDATE companies
     SET pagarme_recipient_id = $2,
         pagarme_recipient_status = $3,
         pagarme_charges_enabled = $4
     WHERE id = $1`,
    [companyId, recipientId, status || null, _isActiveStatus(status)],
  );
};

const _saveRecipientStatus = async (recipientId, status) => {
  await pool.query(
    `UPDATE companies
     SET pagarme_recipient_status = $2, pagarme_charges_enabled = $3
     WHERE pagarme_recipient_id = $1`,
    [recipientId, status || null, _isActiveStatus(status)],
  );
};

// ─── Recebedor: onboarding do comerciante ──────────────────────────────────────

/**
 * Cria (ou atualiza) o recebedor da empresa no Pagar.me a partir dos dados do
 * formulário do portal, e persiste o recipient id + status.
 *
 * `payload` esperado (do controller):
 *   { register_information, default_bank_account } já no formato do Pagar.me.
 */
const createOrUpdateRecipient = async (companyId, payload) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });

  const http = getHttp();
  // Normaliza (data + subcampos do endereço) e então remove eventuais nulls
  // remanescentes — sem descartar os subcampos obrigatórios já preenchidos.
  const registerInformation = _pruneEmpty(_normalizeRegisterInformation(payload.register_information));
  const defaultBankAccount = _pruneEmpty(payload.default_bank_account);
  const body = {
    register_information: registerInformation,
    default_bank_account: defaultBankAccount,
    code: `company_${companyId}`,
    metadata: { company_id: String(companyId) },
    // Repasse automático diário (padrão sensato; ajustável no dashboard depois).
    transfer_settings: { transfer_enabled: true, transfer_interval: "Daily", transfer_day: 0 },
  };

  try {
    let recipient;
    let warning = null; // aviso não-fatal (ex.: conta bancária exige 2FA)
    if (company.pagarme_recipient_id) {
      // ── Atualização de um recebedor existente ──────────────────────────────
      // Estado atual: usado para só alterar a conta bancária quando ela mudou.
      const currentRes = await http.get(`/recipients/${company.pagarme_recipient_id}`);
      const current = currentRes.data || {};

      // 1) Dados cadastrais (nome/endereço/etc.) — não mexem na conta bancária.
      await http.put(`/recipients/${company.pagarme_recipient_id}`, {
        register_information: registerInformation,
      });

      // 2) Conta bancária: só refaz o PATCH se REALMENTE mudou. A Pagar.me exige
      //    2º fator para trocar a conta; evitamos disparar isso à toa (o erro
      //    aparecia mesmo quando o comerciante só editava o cadastro).
      if (_bankAccountChanged(current.default_bank_account, defaultBankAccount)) {
        try {
          await http.patch(`/recipients/${company.pagarme_recipient_id}/default-bank-account`, {
            bank_account: defaultBankAccount,
          });
        } catch (bankErr) {
          if (_is2FAError(bankErr)) {
            // Não derruba a atualização: os dados cadastrais já foram salvos.
            warning =
              "Seus dados foram atualizados, mas a troca da CONTA BANCÁRIA precisa ser confirmada com o segundo fator de autenticação no painel da Pagar.me (por segurança). A conta anterior continua ativa até você confirmar lá.";
          } else {
            throw bankErr;
          }
        }
      }

      const r = await http.get(`/recipients/${company.pagarme_recipient_id}`);
      recipient = r.data;
    } else {
      const r = await http.post("/recipients", body);
      recipient = r.data;
    }
    await _saveRecipientId(companyId, recipient.id, recipient.status);
    return {
      recipient_id: recipient.id,
      status: recipient.status,
      charges_enabled: _isActiveStatus(recipient.status),
      warning,
    };
  } catch (error) {
    // 2FA em outras operações (ex.: PUT dos dados cadastrais): mensagem clara.
    if (_is2FAError(error)) {
      throw Object.assign(
        new Error(
          "A Pagar.me exige um segundo fator de autenticação para esta alteração. Confirme a operação no painel da Pagar.me e tente novamente.",
        ),
        { status: 409 },
      );
    }
    throw _wrap(error, "Falha ao criar o recebedor no Pagar.me");
  }
};

/**
 * Gera o link de KYC (verificação de identidade / "prova de vida") do recebedor.
 * Retorna { url, base64_qrcode, expires_at }.
 */
const createKycLink = async (companyId) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.pagarme_recipient_id) {
    throw Object.assign(new Error("Recebedor ainda não cadastrado."), { status: 409 });
  }
  const http = getHttp();

  // Lê o estado ATUAL na Pagar.me (o status no banco pode estar defasado se o
  // webhook ainda não chegou) e sincroniza de passagem.
  let status = null;
  try {
    const cur = await http.get(`/recipients/${company.pagarme_recipient_id}`);
    status = cur.data?.status || null;
    await _saveRecipientStatus(company.pagarme_recipient_id, status);
  } catch (error) {
    throw _wrap(error, "Falha ao consultar o recebedor");
  }

  // O QR de verificação (prova de vida) só é liberado pela Pagar.me DEPOIS que o
  // recebedor sai de "registration" (pré-onboarding em análise) e avança para a
  // afiliação. Antes disso o kyc_link retorna
  // "Recebedor não completou as etapas prévias à obtenção do QRCode".
  const st = String(status || "").toLowerCase();
  if (_isActiveStatus(status)) {
    throw Object.assign(
      new Error("Este recebedor já está ativo — a verificação de identidade não é necessária."),
      { status: 409 },
    );
  }
  if (["refused", "suspended", "blocked", "inactive"].includes(st)) {
    throw Object.assign(
      new Error(`O recebedor está com status "${status}" na Pagar.me. Regularize com o suporte da Pagar.me antes da verificação.`),
      { status: 409 },
    );
  }
  if (st === "registration") {
    throw Object.assign(
      new Error("O cadastro do recebedor ainda está em análise pela Pagar.me. A verificação de identidade é liberada assim que a análise avança (em geral, alguns minutos). Tente novamente em instantes."),
      { status: 409 },
    );
  }

  try {
    const r = await http.post(`/recipients/${company.pagarme_recipient_id}/kyc_link`, {});
    return {
      url: r.data?.url || null,
      base64_qrcode: r.data?.base64_qrcode || null,
      expires_at: r.data?.expires_at || null,
    };
  } catch (error) {
    // Se mesmo assim a Pagar.me disser que faltam etapas prévias, traduz o erro
    // cru para uma mensagem clara (em vez de "…obtenção do QRCode").
    const raw = String(error?.response?.data?.message || _formatErrors(error?.response?.data?.errors) || "");
    if (/etapas\s+pr[ée]vias|qr\s*code/i.test(raw)) {
      throw Object.assign(
        new Error("A Pagar.me ainda não liberou a verificação de identidade deste recebedor (cadastro em análise). Tente novamente em alguns minutos."),
        { status: 409 },
      );
    }
    throw _wrap(error, "Falha ao gerar o link de verificação");
  }
};

/**
 * Consulta o recebedor no Pagar.me e sincroniza status/charges_enabled na
 * empresa. Retorna { connected, charges_enabled, status }.
 */
const refreshRecipientStatus = async (companyId) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.pagarme_recipient_id) {
    return { connected: false, charges_enabled: false, status: null };
  }
  try {
    const http = getHttp();
    const r = await http.get(`/recipients/${company.pagarme_recipient_id}`);
    const status = r.data?.status || null;
    await _saveRecipientStatus(company.pagarme_recipient_id, status);
    return { connected: true, charges_enabled: _isActiveStatus(status), status };
  } catch (error) {
    throw _wrap(error, "Falha ao consultar o recebedor");
  }
};

/**
 * Retorna os dados já cadastrados do recebedor (para pré-preencher o formulário
 * "Atualizar dados"). A plataforma não armazena esses dados localmente — eles
 * são buscados sob demanda no Pagar.me. Se ainda não há recebedor, devolve
 * `{ connected: false }`.
 */
const getRecipientDetails = async (companyId) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.pagarme_recipient_id) {
    return { connected: false, register_information: null, default_bank_account: null };
  }
  try {
    const http = getHttp();
    const r = await http.get(`/recipients/${company.pagarme_recipient_id}`);
    const rec = r.data || {};
    return {
      connected: true,
      status: rec.status || null,
      charges_enabled: _isActiveStatus(rec.status),
      register_information: rec.register_information || null,
      default_bank_account: rec.default_bank_account || null,
      transfer_settings: _publicTransferSettings(rec.transfer_settings),
    };
  } catch (error) {
    throw _wrap(error, "Falha ao carregar os dados do recebedor");
  }
};

/**
 * Atualiza a agenda de transferências automáticas do recebedor no Pagar.me.
 * A Pagar.me transfere o saldo elegível na frequência configurada; não existe
 * configuração de valor fixo nessa API.
 */
const updateTransferSettings = async (companyId, settings) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.pagarme_recipient_id) {
    throw Object.assign(new Error("Recebedor ainda não cadastrado."), { status: 409 });
  }

  const payload = _normalizeTransferSettings(settings);
  try {
    const http = getHttp();
    const r = await http.patch(`/recipients/${company.pagarme_recipient_id}/transfer-settings`, payload);
    return _publicTransferSettings(r.data?.transfer_settings || r.data || payload);
  } catch (error) {
    if (_is2FAError(error)) {
      throw Object.assign(
        new Error("A Pagar.me exige um segundo fator de autenticação para alterar as transferências automáticas. Confirme a operação no painel da Pagar.me."),
        { status: 409 },
      );
    }
    throw _wrap(error, "Falha ao atualizar as transferências automáticas");
  }
};

// ─── Saldo e saque (o comerciante recebe as próprias vendas) ────────────────────

/**
 * Consulta o saldo do recebedor no Pagar.me. Valores em REAIS.
 *  • available      — disponível para saque agora;
 *  • waiting_funds  — a liberar (vendas ainda não liquidadas);
 *  • transferred    — já transferido.
 */
const getRecipientBalance = async (companyId) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.pagarme_recipient_id) {
    return { connected: false, currency: "BRL", available: 0, waiting_funds: 0, transferred: 0, min_withdrawal: MIN_WITHDRAWAL };
  }
  try {
    const http = getHttp();
    const r = await http.get(`/recipients/${company.pagarme_recipient_id}/balance`);
    const d = r.data || {};
    return {
      connected: true,
      currency: d.currency || "BRL",
      available: (Number(d.available_amount) || 0) / 100,
      waiting_funds: (Number(d.waiting_funds_amount) || 0) / 100,
      transferred: (Number(d.transferred_amount) || 0) / 100,
      min_withdrawal: MIN_WITHDRAWAL, // saque mínimo (reais)
    };
  } catch (error) {
    throw _wrap(error, "Falha ao consultar o saldo");
  }
};

/**
 * Solicita um SAQUE (withdrawal) do saldo disponível do recebedor para a conta
 * bancária cadastrada. `amount` em REAIS (omitido/0 = saca o total disponível).
 * Valida contra o saldo disponível antes de enviar.
 */
const requestWithdrawal = async (companyId, amount) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  if (!company.pagarme_recipient_id) {
    throw Object.assign(new Error("Recebedor ainda não cadastrado."), { status: 409 });
  }
  const http = getHttp();

  // Saldo disponível (centavos) para validar o valor pedido.
  let availableCents = 0;
  try {
    const b = await http.get(`/recipients/${company.pagarme_recipient_id}/balance`);
    availableCents = Number(b.data?.available_amount) || 0;
  } catch (error) {
    throw _wrap(error, "Falha ao consultar o saldo");
  }

  const cents = amount ? Math.round(Number(amount) * 100) : availableCents;
  if (!Number.isFinite(cents) || cents <= 0) {
    throw Object.assign(new Error("Não há saldo disponível para saque."), { status: 422 });
  }
  const minCents = Math.round(MIN_WITHDRAWAL * 100);
  if (cents < minCents) {
    const min = MIN_WITHDRAWAL.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    throw Object.assign(new Error(`O saque mínimo é ${min}.`), { status: 422 });
  }
  if (cents > availableCents) {
    throw Object.assign(new Error("O valor solicitado é maior que o saldo disponível para saque."), { status: 422 });
  }

  try {
    const r = await http.post(`/recipients/${company.pagarme_recipient_id}/withdrawals`, { amount: cents });
    const d = r.data || {};
    return {
      id: d.id || null,
      status: d.status || null,
      amount: (Number(d.amount) || cents) / 100,
    };
  } catch (error) {
    if (_is2FAError(error)) {
      throw Object.assign(
        new Error("A Pagar.me exige um segundo fator de autenticação para o saque. Confirme a operação no painel da Pagar.me."),
        { status: 409 },
      );
    }
    throw _wrap(error, "Falha ao solicitar o saque");
  }
};

// ─── Cobrança do cliente (order + split) ────────────────────────────────────────

// Carrega o pedido + empresa + cliente e valida que o recebedor está ativo.
const _loadOrderForCharge = async (orderId) => {
  const hasDeliverySnapshot = await columnExists("orders", "delivery_address_snapshot");
  const deliverySnapshotSelect = hasDeliverySnapshot
    ? "o.delivery_address_snapshot,"
    : "NULL::jsonb AS delivery_address_snapshot,";
  const orderRes = await pool.query(
    `SELECT o.id, o.uuid, o.total, o.subtotal, o.delivery_fee, o.delivery_type, ${deliverySnapshotSelect}
            o.tag, o.company_id, o.client_id, o.status, o.payment_status, o.service_fee,
            c.name AS company_name, c.pagarme_recipient_id, c.pagarme_charges_enabled,
            cl.name AS client_name, cl.phone AS client_phone, cl.document AS client_document,
            cl.user_id AS client_user_id,
            em.value_norm AS client_email,
            ca.street AS addr_street, ca.number AS addr_number, ca.neighborhood AS addr_neighborhood,
            ca.city AS addr_city, ca.state AS addr_state, ca.zip_code AS addr_zip,
            ua.street AS cli_street, ua.number AS cli_number, ua.complement AS cli_complement, ua.neighborhood AS cli_neighborhood,
            ua.city AS cli_city, ua.state AS cli_state, ua.zip AS cli_zip
     FROM orders o
     JOIN companies c ON c.id = o.company_id
     JOIN clients cl ON cl.id = o.client_id
     LEFT JOIN LATERAL (
       SELECT value_norm FROM user_identifiers
       WHERE user_id = cl.user_id AND type = 'email' AND revoked_at IS NULL
       ORDER BY verified_at DESC NULLS LAST, last_seen_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) em ON cl.user_id IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT street, number, neighborhood, city, state, zip_code
       FROM company_addresses
       WHERE company_id = o.company_id
       ORDER BY id DESC
       LIMIT 1
     ) ca ON true
     LEFT JOIN LATERAL (
       SELECT street, number, complement, neighborhood, city, state, zip
       FROM user_addresses
       WHERE user_id = cl.user_id AND deleted_at IS NULL
       ORDER BY is_default DESC, created_at DESC
       LIMIT 1
     ) ua ON cl.user_id IS NOT NULL
     WHERE o.id = $1`,
    [orderId],
  );
  const order = orderRes.rows[0];
  if (!order) throw Object.assign(new Error("Pedido não encontrado."), { status: 404 });

  // Self-heal: sincroniza o status do recebedor antes de recusar (o webhook
  // recipient.updated pode não ter chegado ainda).
  if (order.pagarme_recipient_id && order.pagarme_charges_enabled !== true) {
    try {
      const status = await refreshRecipientStatus(order.company_id);
      if (status.charges_enabled === true) order.pagarme_charges_enabled = true;
    } catch (_) {
      /* mantém a recusa abaixo */
    }
  }
  if (!order.pagarme_recipient_id || order.pagarme_charges_enabled !== true) {
    throw Object.assign(new Error("Este estabelecimento ainda não habilitou pagamentos online."), { status: 409 });
  }
  if (order.payment_status === "paid") {
    throw Object.assign(new Error("Pedido já pago."), { status: 409 });
  }
  if (![10, "10"].includes(order.status) || ["refunded", "refund_pending", "chargedback"].includes(order.payment_status)) {
    throw Object.assign(new Error("Este pedido não está disponível para pagamento online."), { status: 409 });
  }
  if (!PLATFORM_RECIPIENT_ID) {
    throw Object.assign(new Error("PAGARME_PLATFORM_RECIPIENT_ID não configurado."), { status: 503 });
  }
  return order;
};

// Pedidos de cadastros legados podem apontar para um client sem `user_id`. Sem
// isso, o cofre não consegue saber a quem pertence o cartão. Reconstituímos a
// identidade pelo telefone do próprio pedido e vinculamos o client quando não há
// conflito com outro cadastro ativo da mesma empresa.
const _ensureOrderUserId = async (order) => {
  if (order?.client_user_id || !order?.client_phone) {
    return order?.client_user_id || null;
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { userId } = await identityService.resolveUserByPhone(
      db,
      order.client_phone,
      { name: order.client_name },
    );
    await db.query(
      `UPDATE clients c
       SET user_id = $2, updated_at = now()
       WHERE c.id = $1
         AND c.user_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM clients c2
           WHERE c2.company_id = c.company_id
             AND c2.user_id = $2
             AND c2.id <> c.id
             AND c2.deactivated_at IS NULL
         )`,
      [order.client_id, userId],
    );
    await db.query("COMMIT");
    return userId;
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("pagarme: falha ao resolver identidade do cliente:", e.message);
    return null;
  } finally {
    db.release();
  }
};

// Calcula o split (em centavos): a plataforma retém percentual sobre bens/entrega
// + a taxa de serviço integral; o restante vai para a loja.
const _computeSplit = (order) => {
  const totalCents = Math.round(Number(order.total) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw Object.assign(new Error("Valor do pedido inválido."), { status: 400 });
  }
  const serviceFeeCents = Math.max(0, Math.round(Number(order.service_fee || 0) * 100));
  const goodsCents = Math.max(0, totalCents - serviceFeeCents);
  const feeCents = Math.min(
    totalCents,
    Math.max(0, Math.round(goodsCents * (PLATFORM_FEE_PERCENT / 100)) + serviceFeeCents),
  );
  const merchantCents = totalCents - feeCents;

  const split = [
    {
      amount: merchantCents,
      recipient_id: order.pagarme_recipient_id,
      type: "flat",
      options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true },
    },
  ];
  if (feeCents > 0) {
    split.push({
      amount: feeCents,
      recipient_id: PLATFORM_RECIPIENT_ID,
      type: "flat",
      options: { charge_processing_fee: false, charge_remainder_fee: false, liable: false },
    });
  }
  return { totalCents, split };
};

// Salva o CPF/CNPJ informado no pagamento no cadastro do cliente (clients.document)
// para pré-preencher em pedidos futuros. Só grava quando ainda não há documento
// salvo — evita sobrescrever o CPF do titular por um de um pagador eventual.
const _persistClientDocument = async (clientId, document) => {
  const doc = _onlyDigits(document);
  if (!clientId || (doc.length !== 11 && doc.length !== 14)) return;
  try {
    await pool.query(
      `UPDATE clients SET document = $2
       WHERE id = $1 AND (document IS NULL OR document = '')`,
      [clientId, doc],
    );
  } catch (e) {
    console.error("pagarme: falha ao salvar o documento do cliente:", e.message);
  }
};

// Salva no perfil GLOBAL do usuário (platform_users.pagarme_customer_id) o id do
// customer que a Pagar.me retorna ao criar o pedido, para REUTILIZAR nas próximas
// compras (tudo sob o mesmo customer). Só grava se a coluna existe e ainda está
// vazia (não sobrescreve). Requer a migração de pagarme_customer_id.
const _saveUserPagarmeCustomerId = async (userId, customerId) => {
  if (!userId || !customerId || !(await _savedCardsEnabled())) return;
  try {
    await pool.query(
      `UPDATE platform_users SET pagarme_customer_id = $2
       WHERE id = $1 AND (pagarme_customer_id IS NULL OR pagarme_customer_id = '')`,
      [userId, customerId],
    );
  } catch (e) {
    console.error("pagarme: falha ao salvar o customer id do usuário:", e.message);
  }
};

// Quando há `shipping.amount`, a Pagar.me o acrescenta ao total do pedido. Por
// isso a entrega precisa aparecer em UM único lugar: no shipping ou nos items.
// O retorno define quanto deve ser representado exclusivamente pelos items.
const _itemTotalAfterShipping = (totalCents, shippingAmountCents = 0) => {
  const shippingCents = Math.min(
    totalCents,
    Math.max(0, Math.round(Number(shippingAmountCents) || 0)),
  );
  return { shippingCents, itemsTotalCents: totalCents - shippingCents };
};

// Monta os "Itens" do pedido para a Pagar.me a partir de order_items (o que o
// cliente pediu) + linha de Taxa de serviço. A entrega entra em `shipping.amount`
// quando o endereço de entrega é enviado; caso contrário, continua como item.
// Cada linha vai com quantity=1 e amount = subtotal da linha (em centavos) para
// não introduzir erro de arredondamento por unidade. A SOMA dos items, somada ao
// shipping, DEVE bater exatamente com o valor cobrado (totalCents).
const _buildPagarmeItems = async (order, totalCents, shippingAmountCents = 0) => {
  const { shippingCents, itemsTotalCents } = _itemTotalAfterShipping(
    totalCents,
    shippingAmountCents,
  );
  const single = [{
    code: String(order.id),
    amount: itemsTotalCents,
    description: `Pedido ${order.tag || "#" + order.id}`.slice(0, 64),
    quantity: 1,
  }];
  try {
    const r = await pool.query(
      "SELECT menu_item_id, item_name, quantity, subtotal FROM order_items WHERE order_id = $1 ORDER BY id",
      [order.id],
    );
    const lines = [];
    for (const oi of r.rows) {
      const cents = Math.round(Number(oi.subtotal) * 100);
      if (!Number.isFinite(cents) || cents < 1) continue;
      const qty = Number(oi.quantity) || 1;
      const name = (String(oi.item_name || "Item").trim() || "Item");
      lines.push({
        code: String(oi.menu_item_id || order.id),
        amount: cents,
        description: `${qty > 1 ? qty + "x " : ""}${name}`.slice(0, 64),
        quantity: 1,
      });
    }
    const deliveryCents = Math.max(0, Math.round(Number(order.delivery_fee || 0) * 100));
    const serviceCents = Math.max(0, Math.round(Number(order.service_fee || 0) * 100));
    if (deliveryCents >= 1 && shippingCents === 0) {
      lines.push({ code: "delivery", amount: deliveryCents, description: "Taxa de entrega", quantity: 1 });
    }
    if (serviceCents >= 1) lines.push({ code: "service", amount: serviceCents, description: "Taxa de serviço", quantity: 1 });

    if (lines.length === 0) return single;

    // Reconcilia o arredondamento na última linha (todas com quantity=1).
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const diff = itemsTotalCents - sum;
    if (diff !== 0) lines[lines.length - 1].amount += diff;

    const valid = lines.every((l) => Number.isInteger(l.amount) && l.amount >= 1);
    const finalSum = lines.reduce((s, l) => s + l.amount, 0);
    // Só usa a lista itemizada se ela for válida e, junto com shipping, somar o total.
    return valid && finalSum + shippingCents === totalCents ? lines : single;
  } catch (e) {
    console.error("pagarme: falha ao montar itens do pedido (usando item único):", e.message);
    return single;
  }
};

const _persistOrderCharge = async (orderId, pmOrderId, chargeId) => {
  await pool.query(
    `UPDATE orders
     SET payment_provider = 'pagarme', pagarme_order_id = $2, pagarme_charge_id = $3
     WHERE id = $1`,
    [orderId, pmOrderId || null, chargeId || null],
  );
};

const _PAYMENT_ATTEMPTS_TABLE = "payment_attempts";
const _WEBHOOK_EVENTS_TABLE = "payment_webhook_events";

const _paymentStorageReady = async () => (
  (await tableExists(_PAYMENT_ATTEMPTS_TABLE)) && (await tableExists(_WEBHOOK_EVENTS_TABLE))
);

const _requirePaymentStorage = async () => {
  if (await _paymentStorageReady()) return;
  throw Object.assign(
    new Error("A proteção de pagamentos está em atualização. Tente novamente em alguns minutos."),
    { status: 503, code: "payment_storage_unavailable" },
  );
};

const _normalizeRequestId = (requestId) => {
  const value = String(requestId || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw Object.assign(new Error("Identificador de tentativa de pagamento inválido."), { status: 400 });
  }
  return value;
};

const _startPaymentAttempt = async (order, method, requestId) => {
  await _requirePaymentStorage();
  const clientRequestId = _normalizeRequestId(requestId);
  const r = await pool.query(
    `INSERT INTO payment_attempts (
       order_id, provider, method, client_request_id, idempotency_key, status
     )
     VALUES ($1, 'pagarme', $2, $3, $4, 'processing')
     ON CONFLICT (provider, order_id, client_request_id)
     DO UPDATE SET updated_at = now()
     RETURNING *`,
    [order.id, method, clientRequestId, crypto.randomUUID()],
  );
  const attempt = r.rows[0];
  await pool.query(
    `UPDATE orders
     SET payment_status = 'pending', payment_provider = 'pagarme'
     WHERE id = $1 AND COALESCE(payment_status, '') NOT IN ('paid', 'refunded', 'refund_pending', 'chargedback')`,
    [order.id],
  );
  return attempt;
};

const _providerIdempotencyKey = (attempt) => `automatizai:pagarme:${attempt.idempotency_key}`;

const _attemptResponse = (attempt) => {
  if (!attempt?.response || typeof attempt.response !== "object") return null;
  return attempt.response;
};

const _storeAttempt = async (attemptId, { status, providerOrderId, chargeId, response, failureCode, failureMessage, expiresAt } = {}) => {
  const r = await pool.query(
    `UPDATE payment_attempts
     SET status = COALESCE($2, status),
         pagarme_order_id = COALESCE($3, pagarme_order_id),
         pagarme_charge_id = COALESCE($4, pagarme_charge_id),
         response = COALESCE($5::jsonb, response),
         failure_code = COALESCE($6, failure_code),
         failure_message = COALESCE($7, failure_message),
         expires_at = COALESCE($8::timestamptz, expires_at),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      attemptId,
      status || null,
      providerOrderId || null,
      chargeId || null,
      response ? JSON.stringify(response) : null,
      failureCode || null,
      failureMessage || null,
      expiresAt || null,
    ],
  );
  return r.rows[0] || null;
};

const _findAttemptByProviderRefs = async ({ pagarmeOrderId, chargeId }) => {
  if (!(await _paymentStorageReady())) return null;
  const r = await pool.query(
    `SELECT * FROM payment_attempts
     WHERE provider = 'pagarme'
       AND (($1::text IS NOT NULL AND pagarme_order_id = $1)
         OR ($2::text IS NOT NULL AND pagarme_charge_id = $2))
     ORDER BY id DESC
     LIMIT 1`,
    [pagarmeOrderId || null, chargeId || null],
  );
  return r.rows[0] || null;
};

const createPublicPaymentSession = (order, { customerVerified = false } = {}) => ({
  payment_session_token: createPaymentSession({
    orderId: order.id,
    orderUuid: order.uuid,
    companyId: order.company_id,
    clientId: order.client_id,
    customerVerified,
  }),
});

const _keyEnvironment = (key) => {
  const value = String(key || "");
  if (/^(sk|pk)_test_/.test(value)) return "test";
  if (/^(sk|pk)_/.test(value)) return "live";
  return null;
};

const threeDsAvailable = () => Boolean(
  THREE_DS_ENABLED && _keyEnvironment(process.env.PAGARME_SECRET_KEY),
);

// O token curto é gerado no servidor porque a API 3DS exige a secret key. Ele é
// devolvido somente para uma sessão de pagamento já vinculada a um pedido.
const createThreeDsToken = async () => {
  if (!threeDsAvailable()) {
    throw Object.assign(new Error("Autenticação 3DS indisponível no momento."), { status: 409 });
  }
  try {
    const { data } = await axios.get(`${THREE_DS_API_URL}/tds-token`, {
      auth: { username: process.env.PAGARME_SECRET_KEY, password: "" },
      timeout: 10000,
    });
    const token = String(data?.tds_token || data?.token || "").trim();
    if (!token) {
      throw Object.assign(new Error("Resposta 3DS inválida."), { status: 502 });
    }
    return {
      token,
      environment: _keyEnvironment(process.env.PAGARME_SECRET_KEY),
    };
  } catch (error) {
    if (error?.status) throw error;
    throw _wrap(error, "Não foi possível iniciar a autenticação de segurança do cartão");
  }
};

const isPublicCheckoutConfigured = () => {
  const secretEnvironment = _keyEnvironment(process.env.PAGARME_SECRET_KEY);
  const publicEnvironment = _keyEnvironment(process.env.PAGARME_PUBLIC_KEY);
  return Boolean(
    secretEnvironment &&
    publicEnvironment &&
    secretEnvironment === publicEnvironment &&
    PLATFORM_RECIPIENT_ID &&
    (process.env.PAGARME_PAYMENT_SESSION_SECRET || process.env.JWT_SECRET),
  );
};

const isPaymentInfrastructureReady = async () => (
  isPublicCheckoutConfigured() && (await _paymentStorageReady())
);

// O cofre é opt-in por ambiente e só pode ser usado quando a sessão curta do
// pedido carrega `customer_verified=true`, emitido após login da conta cliente.
const savedCardsAvailable = () => SAVED_CARDS_ENABLED;

// Não classifique antifraude por texto livre de adquirente. A operação usa os
// campos estruturados do antifraude e permite complementar códigos por ambiente.
const ANTIFRAUD_CODES = new Set(
  String(process.env.PAGARME_ANTIFRAUD_CODES || "antifraud_reproved,antifraud_denied,fraud_reproved")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const ANTIFRAUD_DECLINE_STATUSES = new Set([
  "reproved", "reproved_by_antifraud", "denied", "rejected", "refused",
  "declined", "not_approved", "not_authorized", "failed", "fraud",
]);
const ANTIFRAUD_NON_FINAL_STATUSES = new Set([
  "approved", "pending", "analyzing", "analysis", "review", "processing",
  "not_analyzed", "not_available", "",
]);

const _collectProviderCodes = (value, codes = []) => {
  if (!value) return codes;
  if (Array.isArray(value)) {
    value.forEach((item) => _collectProviderCodes(item, codes));
    return codes;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["code", "status", "reason", "type"].includes(key) && typeof item === "string") {
        codes.push(item.toLowerCase());
      } else if (item && typeof item === "object") {
        _collectProviderCodes(item, codes);
      }
    }
  }
  return codes;
};

const _hasAntifraudSignal = (values) => values
  .flatMap((value) => _collectProviderCodes(value))
  .some((code) => ANTIFRAUD_CODES.has(code));

const _antifraudResponse = (charge) => {
  const transaction = charge?.last_transaction || {};
  return transaction?.antifraud_response || transaction?.antifraud ||
    charge?.antifraud_response || charge?.antifraud || null;
};

const _antifraudDiagnostics = (charge) => {
  const response = _antifraudResponse(charge);
  if (!response || typeof response !== "object") return null;
  const status = String(response.status || "").trim().toLowerCase();
  const code = String(response.return_code || response.code || "").trim().toLowerCase() || null;
  const message = String(response.return_message || response.message || "").trim() || null;
  const provider = String(response.provider_name || response.provider || "").trim() || null;
  return { status, code, message, provider };
};

const _isAntifraudDecline = (charge) => {
  const diagnostic = _antifraudDiagnostics(charge);
  if (diagnostic) {
    if (ANTIFRAUD_DECLINE_STATUSES.has(diagnostic.status)) return true;
    if (diagnostic.code && ANTIFRAUD_CODES.has(diagnostic.code)) return true;
    // Um retorno de antifraude com provedor/status próprio em uma cobrança já
    // falha é uma decisão de risco, mesmo que a conta use um código não mapeado.
    if (diagnostic.provider && !ANTIFRAUD_NON_FINAL_STATUSES.has(diagnostic.status)) return true;
  }
  return _hasAntifraudSignal([charge?.antifraud_response, charge?.antifraud]);
};

const _isAntifraudProviderError = (value) => {
  if (!value || typeof value !== "object") return false;
  const charge = value.charge || value.data?.charge || value;
  return _isAntifraudDecline(charge) || _hasAntifraudSignal([
    value.antifraud_response,
    value.antifraud,
    value.errors,
  ]);
};

const _isPositiveAcquirerMessage = (value) => /\b(aprovad[ao]?|autorizad[ao]?|success)\b/i.test(String(value || ""));

const _cardFailureMessage = (charge, failureType) => {
  if (failureType === "antifraud") {
    return "Pagamento não aprovado pela análise de segurança.";
  }
  const transaction = charge?.last_transaction || {};
  const gatewayDetails = _formatErrors(transaction.gateway_response?.errors) || _formatErrors(transaction.errors);
  if (gatewayDetails) return gatewayDetails;
  const acquirerMessage = String(transaction.acquirer_message || "").trim();
  if (acquirerMessage && !_isPositiveAcquirerMessage(acquirerMessage)) return acquirerMessage;
  return "O pagamento não foi aprovado pelo cartão. Verifique os dados ou tente outro cartão.";
};

const _buildThreeDsAuthentication = (input) => {
  if (!input) return null;
  if (!THREE_DS_ENABLED) {
    throw Object.assign(new Error("Autenticação 3DS não está habilitada para esta conta."), { status: 409 });
  }
  const mpi = String(input.mpi || "pagarme");
  if (!["pagarme", "third_party"].includes(mpi)) {
    throw Object.assign(new Error("Dados 3DS inválidos."), { status: 400 });
  }
  const threedSecure = { mpi };
  for (const key of ["eci", "cavv", "transaction_id", "ds_transaction_id", "version"]) {
    if (input[key]) threedSecure[key] = String(input[key]).slice(0, 256);
  }
  if (mpi === "pagarme" && !threedSecure.transaction_id) {
    throw Object.assign(new Error("Autenticação 3DS incompleta."), { status: 400 });
  }
  if (mpi === "third_party" && (!threedSecure.eci || !threedSecure.cavv || !threedSecure.ds_transaction_id || !threedSecure.version)) {
    throw Object.assign(new Error("Autenticação 3DS incompleta."), { status: 400 });
  }
  return { type: "threed_secure", threed_secure: threedSecure };
};

// ─── Cartão salvo (cofre Pagar.me) ───────────────────────────────────────────
// Guardamos SÓ a referência tokenizada (card_id) — nunca número/CVV. O cartão
// vive no cofre da Pagar.me, vinculado a um customer do usuário.

// A coluna platform_users.pagarme_customer_id pode não ter sido migrada ainda.
const _savedCardsEnabled = () => columnExists("platform_users", "pagarme_customer_id");

const _getUserPagarmeCustomerId = async (userId) => {
  if (!userId || !(await _savedCardsEnabled())) return null;
  const r = await pool.query("SELECT pagarme_customer_id FROM platform_users WHERE id = $1", [userId]);
  return r.rows[0]?.pagarme_customer_id || null;
};

// Garante um customer no Pagar.me para o usuário (cria e persiste se faltar).
const _ensurePagarmeCustomer = async (userId, customerObj) => {
  if (!userId) throw Object.assign(new Error("Cliente sem identidade para salvar o cartão."), { status: 400 });
  if (!(await _savedCardsEnabled())) {
    throw Object.assign(new Error("Salvar cartão indisponível (migração pendente)."), { status: 503 });
  }
  const existing = await _getUserPagarmeCustomerId(userId);
  if (existing) return existing;
  const { data } = await getHttp().post("/customers", customerObj);
  const id = data?.id;
  if (id) await pool.query("UPDATE platform_users SET pagarme_customer_id = $2 WHERE id = $1", [userId, id]);
  return id;
};

// Atualiza o cadastro de um customer existente na Pagar.me (PUT /customers/{id}).
// Usado quando o cliente informa um e-mail novo e a cobrança reutiliza o
// customer_id (nesse caso o customer inline com o e-mail não é enviado). Enviamos
// o customer COMPLETO (com o e-mail novo) para não perder os demais dados.
// Best-effort: nunca derruba a cobrança.
const _updatePagarmeCustomer = async (customerId, customerObj) => {
  if (!customerId || !customerObj) return;
  try {
    await getHttp().put(`/customers/${customerId}`, customerObj);
  } catch (e) {
    console.error("pagarme: falha ao atualizar o cadastro do customer:", e.message);
  }
};

// Cria o cartão no cofre e devolve { id, brand, last4 }.
// `verify_card: false` — NÃO faz o Zero-Dollar-Auth de verificação (que retorna
// 412 "Could not create credit card. The card verification failed." quando o
// emissor recusa a validação de R$ 0). A autorização de verdade é a própria
// cobrança logo em seguida (com o card_id).
const _createVaultCard = async (customerId, cardToken, billingAddress) => {
  const body = { token: cardToken, options: { verify_card: false } };
  if (billingAddress) body.billing_address = billingAddress;
  const { data } = await getHttp().post(`/customers/${customerId}/cards`, body);
  return { id: data.id, brand: data.brand || null, last4: data.last_four_digits || data.last_four || null };
};

// Persiste o cartão salvo (user_payment_tokens). Primeiro cartão vira default.
const _persistSavedCard = async (userId, card) => {
  const count = await pool.query(
    "SELECT count(*)::int n FROM user_payment_tokens WHERE user_id = $1 AND provider = 'pagarme' AND revoked_at IS NULL",
    [userId],
  );
  await pool.query(
    `INSERT INTO user_payment_tokens (user_id, provider, token, brand, last4, is_default)
     VALUES ($1, 'pagarme', $2, $3, $4, $5)`,
    [userId, card.id, card.brand, card.last4, count.rows[0].n === 0],
  );
};

// Resolve um método de pagamento local para o card_id do cofre. A referência do
// Pagar.me nunca sai para o navegador.
const _assertOwnedCard = async (userId, tokenRowId) => {
  const r = await pool.query(
    "SELECT token FROM user_payment_tokens WHERE user_id = $1 AND id = $2 AND provider = 'pagarme' AND revoked_at IS NULL LIMIT 1",
    [userId, tokenRowId],
  );
  if (!r.rows[0]?.token) throw Object.assign(new Error("Cartão salvo inválido."), { status: 400 });
  return r.rows[0].token;
};

const listSavedCards = async (userId) => {
  if (!SAVED_CARDS_ENABLED) return [];
  if (!userId) return [];
  const r = await pool.query(
    `SELECT id, brand, last4, is_default
     FROM user_payment_tokens
     WHERE user_id = $1 AND provider = 'pagarme' AND revoked_at IS NULL
     ORDER BY is_default DESC, id DESC`,
    [userId],
  );
  return r.rows;
};

// Revoga (soft) e tenta remover do cofre. Só age no cartão do próprio usuário.
const deleteSavedCard = async (userId, tokenRowId) => {
  if (!SAVED_CARDS_ENABLED) {
    throw Object.assign(new Error("Cartões salvos estão indisponíveis até a verificação de identidade ser habilitada."), { status: 403 });
  }
  const r = await pool.query(
    "SELECT id, token FROM user_payment_tokens WHERE id = $1 AND user_id = $2 AND provider = 'pagarme' AND revoked_at IS NULL",
    [tokenRowId, userId],
  );
  const row = r.rows[0];
  if (!row) throw Object.assign(new Error("Cartão não encontrado."), { status: 404 });
  await pool.query("UPDATE user_payment_tokens SET revoked_at = now() WHERE id = $1", [row.id]);
  const customerId = await _getUserPagarmeCustomerId(userId);
  if (customerId) {
    try { await getHttp().delete(`/customers/${customerId}/cards/${row.token}`); } catch (_) { /* best-effort */ }
  }
  return { deleted: true };
};

const setDefaultSavedCard = async (userId, tokenRowId) => {
  if (!SAVED_CARDS_ENABLED) {
    throw Object.assign(new Error("Cartões salvos estão indisponíveis neste ambiente."), { status: 403 });
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const owned = await db.query(
      `SELECT id FROM user_payment_tokens
       WHERE id = $1 AND user_id = $2 AND provider = 'pagarme' AND revoked_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [tokenRowId, userId],
    );
    if (!owned.rows[0]) {
      throw Object.assign(new Error("Cartão não encontrado."), { status: 404 });
    }
    await db.query(
      `UPDATE user_payment_tokens SET is_default = false
       WHERE user_id = $1 AND provider = 'pagarme' AND revoked_at IS NULL`,
      [userId],
    );
    await db.query(
      "UPDATE user_payment_tokens SET is_default = true WHERE id = $1",
      [tokenRowId],
    );
    await db.query("COMMIT");
    return { updated: true };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
};

const _userIdForClient = async (clientId) => {
  const r = await pool.query("SELECT user_id FROM clients WHERE id = $1", [clientId]);
  return r.rows[0]?.user_id || null;
};

const listSavedCardsForClient = async (clientId) => {
  const userId = await _userIdForClient(clientId);
  return userId ? listSavedCards(userId) : [];
};

const deleteSavedCardForClient = async (clientId, tokenRowId) => {
  const userId = await _userIdForClient(clientId);
  if (!userId) throw Object.assign(new Error("Cartão não encontrado."), { status: 404 });
  return deleteSavedCard(userId, tokenRowId);
};

/**
 * Cria um pedido com pagamento no CARTÃO. Suporta 3 modos (via `extra`):
 *  • cartão novo (card_token) — cobrança avulsa (comportamento padrão);
 *  • cartão novo + `saveCard:true` — salva no cofre e cobra pelo card_id;
 *  • `savedCardId` — cobra um método salvo local, resolvido no servidor.
 * `extra`: { document, email, name, phone, savedCardId, saveCard }.
 */
const createCardCharge = async (orderId, cardToken, extra = {}) => {
  const savedCardId = Number(extra.savedCardId) || null;
  const saveCard = extra.saveCard === true;
  if (!cardToken && !savedCardId) {
    throw Object.assign(new Error("card_token ou saved_card_id é obrigatório."), { status: 400 });
  }
  const order = await _loadOrderForCharge(orderId);
  const { totalCents, split } = _computeSplit(order);
  // Regra atual do produto: todas as cobranças são à vista. Mantemos a regra no
  // service (além da UI) para que payloads alterados no navegador não habilitem
  // parcelamento sem uma mudança explícita deste contrato.
  const installments = 1;
  const billingAddress = _buildBillingAddress(order, extra.billingAddress);
  const userId = await _ensureOrderUserId(order);
  order.client_user_id = userId;
  const threeDsAuthentication = _buildThreeDsAuthentication(extra.threeDs);

  const customerForPayment = _buildCustomer(order, extra, billingAddress);
  if (!customerForPayment.email) {
    throw Object.assign(new Error("Informe um e-mail válido para concluir o pagamento."), { status: 400 });
  }
  if (!billingAddress) {
    throw Object.assign(new Error("Informe um endereço completo do titular para concluir o pagamento."), { status: 400 });
  }
  const attempt = await _startPaymentAttempt(order, "card", extra.requestId);
  const priorResponse = _attemptResponse(attempt);
  if (priorResponse) return priorResponse;

  // O e-mail informado é persistido no perfil global para as próximas compras.
  await _persistClientDocument(order.client_id, extra.document);
  if (userId && _isPlausibleEmail(extra.email)) {
    try {
      await identityService.saveEmailForUser(userId, extra.email);
      order.client_email = String(extra.email).trim().toLowerCase();
    } catch (e) {
      // O e-mail melhora o cadastro e o antifraude, mas uma falha de persistência
      // não pode impedir que o cliente tente concluir o pagamento.
      console.error("pagarme: falha ao salvar e-mail do cliente:", e.message);
    }
  }

  const creditCardBase = {
    operation_type: "auth_and_capture",
    installments,
    statement_descriptor: _buildStatementDescriptor(order.company_name),
  };
  const riskContext = _buildOrderRiskContext(order, extra);
  const { shipping_source: shippingSource, ...pagarmeRiskContext } = riskContext;
  // A entrega já está em shipping.amount; não a duplica nos items.
  const items = await _buildPagarmeItems(order, totalCents, pagarmeRiskContext.shipping?.amount);
  const metadata = {
    order_id: String(order.id),
    company_id: String(order.company_id),
    ...(shippingSource ? { shipping_source: shippingSource } : {}),
  };

  // Reutiliza o customer do usuário na Pagar.me quando já existe (todas as compras
  // sob o MESMO cadastro). Se ainda não houver, manda o customer inline e salva o
  // id que a Pagar.me retornar (após criar o pedido).
  const existingCustomerId = await _getUserPagarmeCustomerId(userId);
  // Se o cliente DIGITOU um e-mail e o customer é reutilizado, atualiza o cadastro
  // dele na Pagar.me — com customer_id o e-mail inline não seria enviado na cobrança.
  if (existingCustomerId && _isPlausibleEmail(extra.email)) {
    await _updatePagarmeCustomer(existingCustomerId, _buildCustomer(order, extra, billingAddress));
  }
  const customerField = existingCustomerId
    ? { customer_id: existingCustomerId }
    : { customer: _buildCustomer(order, extra, billingAddress) };

  // Payload de cobrança avulsa (cartão novo pelo card_token) — padrão e também
  // fallback quando salvar o cartão não está disponível.
  const tokenChargePayload = () => ({
    code: String(order.id),
    ...customerField,
    items,
    ...pagarmeRiskContext,
    payments: [{
      payment_method: "credit_card",
      credit_card: {
        ...creditCardBase,
        card_token: cardToken,
        ...(threeDsAuthentication ? { authentication: threeDsAuthentication } : {}),
        // O antifraude exige billing_address no cartão; sem ele a cobrança falha
        // com `billing | "value" is required`.
        ...(billingAddress ? { card: { billing_address: billingAddress } } : {}),
      },
      split,
    }],
    metadata,
  });

  try {
    const http = getHttp();

    // Monta o payload do pedido conforme o modo (cartão salvo / salvar / avulso).
    let orderPayload;
    let pendingSave = null; // Só é gravado se a cobrança for aprovada.
    const saveUnavailable = saveCard && (!SAVED_CARDS_ENABLED || extra.customerVerified !== true || !userId || !(await _savedCardsEnabled()));
    if (savedCardId) {
      if (!SAVED_CARDS_ENABLED || extra.customerVerified !== true) {
        throw Object.assign(new Error("Cartões salvos estão indisponíveis até a verificação de identidade ser habilitada."), { status: 403 });
      }
      // Pagar com cartão salvo — o card_id só é resolvido no servidor.
      const cardId = await _assertOwnedCard(userId, savedCardId);
      const customerId = await _getUserPagarmeCustomerId(userId);
      if (!customerId) throw Object.assign(new Error("Cartão salvo inválido."), { status: 400 });
      orderPayload = {
        code: String(order.id),
        customer_id: customerId,
        items,
        ...pagarmeRiskContext,
        payments: [{ payment_method: "credit_card", credit_card: { ...creditCardBase, card_id: cardId, ...(threeDsAuthentication ? { authentication: threeDsAuthentication } : {}) }, split }],
        metadata,
      };
    } else if (saveCard && SAVED_CARDS_ENABLED && extra.customerVerified === true && userId && (await _savedCardsEnabled())) {
      // Cartão NOVO + salvar: cria customer + cartão no cofre (sem zero-auth) e
      // cobra pelo card_id. O registro em user_payment_tokens só é feito DEPOIS,
      // se a cobrança for aprovada (não guardamos cartão de cobrança recusada).
      const customerId = await _ensurePagarmeCustomer(userId, _buildCustomer(order, extra, billingAddress));
      const card = await _createVaultCard(customerId, cardToken, billingAddress);
      pendingSave = { userId, customerId, card };
      orderPayload = {
        code: String(order.id),
        customer_id: customerId,
        items,
        ...pagarmeRiskContext,
        payments: [{ payment_method: "credit_card", credit_card: { ...creditCardBase, card_id: card.id, ...(threeDsAuthentication ? { authentication: threeDsAuthentication } : {}) }, split }],
        metadata,
      };
    } else {
      // Cartão NOVO avulso (padrão). Também cai aqui quando o cliente pediu para
      // salvar mas o recurso não está disponível (sem identidade/migração pendente)
      // — melhor concluir a compra do que falhar por causa do salvamento.
      orderPayload = tokenChargePayload();
    }

    const { data } = await http.post("/orders", orderPayload, {
      headers: { "Idempotency-Key": _providerIdempotencyKey(attempt) },
    });

    // Reaproveita o customer nas próximas compras: se a Pagar.me criou um customer
    // novo (mandamos inline), guarda o id retornado no perfil global do usuário.
    if (!existingCustomerId && data.customer?.id) {
      await _saveUserPagarmeCustomerId(userId, data.customer.id);
    }

    const charge = (data.charges && data.charges[0]) || {};
    await _persistOrderCharge(order.id, data.id, charge.id);

    const status = String(charge.status || data.status || "processing").toLowerCase();
    const paid = status === "paid";
    let cardSaved = false;
    let cardSaveWarning = null;
    if (paid) {
      await _markOrderPaid(order.id, charge.id);
      // Só registra o cartão salvo quando a cobrança foi realmente aprovada.
      if (pendingSave) {
        try {
          await _persistSavedCard(pendingSave.userId, pendingSave.card);
          cardSaved = true;
        } catch (e) {
          console.error("pagarme: falha ao registrar o cartão salvo:", e.message);
          // Sem a referência local o cartão ficaria órfão no cofre e não poderia
          // ser reutilizado. Tentamos removê-lo para manter os dois lados íntegros.
          try {
            await getHttp().delete(
              `/customers/${pendingSave.customerId}/cards/${pendingSave.card.id}`,
            );
          } catch (_) {
            // Best-effort: o cartão não será listado nem poderá ser usado aqui.
          }
          cardSaveWarning = "O pagamento foi aprovado, mas não foi possível salvar o cartão.";
        }
      } else if (saveUnavailable) {
        cardSaveWarning = "O pagamento foi aprovado, mas o recurso de salvar cartão está indisponível no momento.";
      }
    } else if (["failed", "canceled"].includes(status)) {
      await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [order.id]);
    }

    const failureType = !paid && ["failed", "canceled"].includes(status)
      ? (_isAntifraudDecline(charge) ? "antifraud" : "card_declined")
      : (!paid ? "payment_pending" : null);
    const antifraudDiagnostic = _antifraudDiagnostics(charge);

    const response = {
      status,
      paid,
      order_id: order.id,
      pagarme_order_id: data.id,
      charge_id: charge.id,
      card_saved: cardSaved,
      card_save_warning: cardSaveWarning,
      failure_type: failureType,
      next_action: failureType === "antifraud" ? "track_order" : "retry_payment",
      message: paid ? null : _cardFailureMessage(charge, failureType),
    };
    await _storeAttempt(attempt.id, {
      status: paid ? "paid" : (["failed", "canceled"].includes(status) ? "failed" : "pending"),
      providerOrderId: data.id,
      chargeId: charge.id,
      response,
      failureCode: paid ? null : (antifraudDiagnostic?.code || failureType || status),
      failureMessage: paid ? null : response.message,
    });
    _paymentLog("card_attempt_finished", {
      order_id: order.id,
      attempt_id: attempt.id,
      status,
      failure_type: failureType,
      antifraud: antifraudDiagnostic,
      shipping_source: shippingSource,
      risk_context: {
        has_ip: Boolean(pagarmeRiskContext.ip),
        has_session: Boolean(pagarmeRiskContext.session_id),
        has_location: Boolean(pagarmeRiskContext.location),
        has_device: Boolean(pagarmeRiskContext.device),
      },
    });
    return response;
  } catch (error) {
    // Alguns adquirentes devolvem a recusa antifraude como erro HTTP, sem a
    // estrutura de charge. Mantemos o mesmo contrato de navegação nesses casos.
    if (_isAntifraudProviderError(error?.response?.data)) {
      await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [order.id]);
      const wrapped = _wrap(error, "Pagamento recusado pela análise de segurança");
      const response = {
        status: "failed",
        paid: false,
        order_id: order.id,
        failure_type: "antifraud",
        next_action: "track_order",
        message: wrapped.message,
      };
      await _storeAttempt(attempt.id, {
        status: "failed",
        response,
        failureCode: "antifraud",
        failureMessage: wrapped.message,
      });
      return response;
    }
    const wrapped = _wrap(error, "Falha ao processar o pagamento com cartão");
    // Não converte timeout/5xx em falha definitiva: a mesma idempotency key pode
    // ser reenviada com segurança e o provedor devolve a transação original.
    if (wrapped.status >= 500 || wrapped.status === 409) {
      await _storeAttempt(attempt.id, { status: "processing", failureMessage: wrapped.message });
      throw wrapped;
    }
    await _storeAttempt(attempt.id, { status: "failed", failureMessage: wrapped.message, failureCode: "provider_error" });
    throw wrapped;
  }
};

/**
 * Cria um pedido com pagamento via PIX (split). Devolve os dados do QR code para
 * exibição em modal. A confirmação é assíncrona (webhook order.paid/charge.paid).
 */
const createPixCharge = async (orderId, extra = {}) => {
  const order = await _loadOrderForCharge(orderId);
  const { totalCents, split } = _computeSplit(order);
  const expiresIn = Number(process.env.PAGARME_PIX_EXPIRES_IN || 3600);

  // A Pagar.me EXIGE o documento (CPF/CNPJ) do pagador para PIX. Sem ele a
  // cobrança nasce "failed" sem QR Code. Usa o CPF informado no pagamento ou o
  // já salvo no cadastro do cliente; se não houver nenhum, recusa com mensagem
  // clara (o cliente precisa informar o CPF na tela de pagamento).
  // Enriquece o customer ao máximo (telefone do cadastro + CPF + e-mail +
  // endereço) — também no PIX, para o cadastro reutilizado na Pagar.me ficar
  // completo e ajudar o antifraude nas cobranças de cartão seguintes.
  const userId = await _ensureOrderUserId(order);
  order.client_user_id = userId;
  const customer = _buildCustomer(order, extra, _buildBillingAddress(order));
  if (!customer.document) {
    throw Object.assign(new Error("Informe o CPF do pagador para pagar com PIX."), { status: 400 });
  }
  if (!customer.email) {
    throw Object.assign(new Error("Informe um e-mail válido para concluir o pagamento."), { status: 400 });
  }
  // Persiste o CPF informado para pré-preencher nos próximos pedidos.
  await _persistClientDocument(order.client_id, customer.document);
  if (userId && _isPlausibleEmail(extra.email)) {
    await identityService.saveEmailForUser(userId, extra.email);
    order.client_email = String(extra.email).trim().toLowerCase();
  }

  await _requirePaymentStorage();
  const activePix = await pool.query(
    `SELECT * FROM payment_attempts
     WHERE order_id = $1 AND provider = 'pagarme' AND method = 'pix'
       AND status IN ('processing', 'pending')
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  const activeResponse = _attemptResponse(activePix.rows[0]);
  if (activeResponse) return activeResponse;
  const attempt = await _startPaymentAttempt(order, "pix", extra.requestId);
  const priorResponse = _attemptResponse(attempt);
  if (priorResponse) return priorResponse;

  // Reutiliza o customer do usuário na Pagar.me quando já existe (mesmo cadastro
  // em todas as compras); senão manda inline e guarda o id retornado abaixo.
  const existingCustomerId = await _getUserPagarmeCustomerId(userId);
  const customerField = existingCustomerId ? { customer_id: existingCustomerId } : { customer };
  const riskContext = _buildOrderRiskContext(order, extra);
  const { shipping_source: shippingSource, ...pagarmeRiskContext } = riskContext;
  // A entrega já está em shipping.amount; não a duplica nos items.
  const items = await _buildPagarmeItems(order, totalCents, pagarmeRiskContext.shipping?.amount);

  try {
    const http = getHttp();
    const { data } = await http.post("/orders", {
      code: String(order.id),
      ...customerField,
      items,
      ...pagarmeRiskContext,
      payments: [
        {
          payment_method: "pix",
          pix: { expires_in: expiresIn },
          split,
        },
      ],
      metadata: {
        order_id: String(order.id),
        company_id: String(order.company_id),
        ...(shippingSource ? { shipping_source: shippingSource } : {}),
      },
    }, {
      headers: { "Idempotency-Key": _providerIdempotencyKey(attempt) },
    });

    if (!existingCustomerId && data.customer?.id) {
      await _saveUserPagarmeCustomerId(userId, data.customer.id);
    }

    const charge = (data.charges && data.charges[0]) || {};
    const tx = charge.last_transaction || {};
    await _persistOrderCharge(order.id, data.id, charge.id);

    const status = String(charge.status || data.status || "processing").toLowerCase();
    // PIX bem-sucedido nasce "pending"/"waiting_payment" COM QR Code. Se veio
    // "failed" ou sem QR, a Pagar.me recusou — logamos o motivo real e devolvemos
    // um erro claro (em vez de um "200" com QR nulo que trava o cliente).
    if (!tx.qr_code || status === "failed") {
      console.error(
        "Pagar.me PIX recusado:",
        JSON.stringify(_redact({
          order_id: order.id,
          charge_status: status,
          tx_status: tx.status,
          gateway_response: tx.gateway_response,
          acquirer_message: tx.acquirer_message,
        })),
      );
      await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [order.id]);
      const reason = tx.acquirer_message || tx.gateway_response?.errors?.[0]?.message;
      await _storeAttempt(attempt.id, {
        status: "failed",
        providerOrderId: data.id,
        chargeId: charge.id,
        failureCode: status || "pix_generation_failed",
        failureMessage: reason || "PIX recusado.",
      });
      throw Object.assign(
        new Error(reason ? `PIX recusado: ${reason}` : "Não foi possível gerar o PIX. Revise os dados e tente novamente."),
        { status: 422 },
      );
    }

    const response = {
      status,
      order_id: order.id,
      pagarme_order_id: data.id,
      charge_id: charge.id,
      qr_code: tx.qr_code || null, // copia e cola
      qr_code_url: tx.qr_code_url || null, // imagem do QR
      expires_at: tx.expires_at || null,
    };
    await _storeAttempt(attempt.id, {
      status: status === "paid" ? "paid" : "pending",
      providerOrderId: data.id,
      chargeId: charge.id,
      response,
      expiresAt: tx.expires_at || null,
    });
    _paymentLog("pix_attempt_created", { order_id: order.id, attempt_id: attempt.id, status });
    return response;
  } catch (error) {
    if (error.status === 422) throw error; // erro de recusa já formatado acima
    const wrapped = _wrap(error, "Falha ao gerar o PIX");
    if (wrapped.status >= 500 || wrapped.status === 409) {
      await _storeAttempt(attempt.id, { status: "processing", failureMessage: wrapped.message });
      throw wrapped;
    }
    await _storeAttempt(attempt.id, { status: "failed", failureCode: "provider_error", failureMessage: wrapped.message });
    throw wrapped;
  }
};

// ─── Estorno / cancelamento de cobrança ────────────────────────────────────────

/**
 * Solicita o estorno (refund) de uma cobrança. Na Pagar.me v5, o cancelamento de
 * um charge PAGO (`DELETE /charges/{id}`) dispara o reembolso ao cliente (PIX ou
 * cartão); se ainda não foi capturado, apenas cancela. `amountCents` permite
 * estorno parcial (omitido = valor integral). Retorna o status resultante.
 */
const refundCharge = async (chargeId, amountCents, idempotencyKey) => {
  if (!chargeId) {
    throw Object.assign(new Error("charge id é obrigatório para o estorno."), { status: 400 });
  }
  try {
    const http = getHttp();
    const body = amountCents ? { amount: Math.round(amountCents) } : undefined;
    // axios envia corpo no DELETE via `data`.
    const config = {
      ...(body ? { data: body } : {}),
      ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
    };
    const { data } = await http.delete(`/charges/${chargeId}`, config);
    return { status: data?.status || null };
  } catch (error) {
    throw _wrap(error, "Falha ao solicitar o estorno no Pagar.me");
  }
};

const requestRefundForOrder = async (orderId, chargeId, amountCents) => {
  await _requirePaymentStorage();
  const key = `refund_${crypto.createHash("sha256").update(`${orderId}:${chargeId}:${amountCents || "full"}`).digest("hex").slice(0, 48)}`;
  const attemptRes = await pool.query(
    `INSERT INTO payment_attempts (order_id, provider, method, client_request_id, idempotency_key, status)
     VALUES ($1, 'pagarme', 'refund', $2, $3, 'refund_pending')
     ON CONFLICT (provider, order_id, client_request_id)
     DO UPDATE SET updated_at = now()
     RETURNING *`,
    [orderId, key, crypto.randomUUID()],
  );
  const attempt = attemptRes.rows[0];
  const previous = _attemptResponse(attempt);
  if (previous) return previous;

  await pool.query(
    `UPDATE orders SET payment_status = 'refund_pending'
     WHERE id = $1 AND payment_status = 'paid' AND pagarme_charge_id = $2`,
    [orderId, chargeId],
  );
  try {
    const result = await refundCharge(chargeId, amountCents, _providerIdempotencyKey(attempt));
    const status = String(result.status || "refund_pending").toLowerCase();
    const response = { status, refund_pending: status !== "refunded" };
    await _storeAttempt(attempt.id, {
      status: status === "refunded" ? "refunded" : "refund_pending",
      chargeId,
      response,
    });
    if (status === "refunded") {
      await pool.query(
        "UPDATE orders SET payment_status = 'refunded' WHERE id = $1 AND pagarme_charge_id = $2",
        [orderId, chargeId],
      );
    }
    return response;
  } catch (error) {
    const wrapped = _wrap(error, "Falha ao solicitar o estorno no Pagar.me");
    await _storeAttempt(attempt.id, {
      status: "refund_pending",
      chargeId,
      failureCode: "refund_request_failed",
      failureMessage: wrapped.message,
    });
    throw wrapped;
  }
};

// ─── Webhook ─────────────────────────────────────────────────────────────────
// Segurança por HTTP Basic auth configurado no endpoint do dashboard Pagar.me.
// Comparação em tempo constante para evitar timing attack.

const verifyBasicAuth = (authorizationHeader) => {
  const user = process.env.PAGARME_WEBHOOK_USER;
  const pass = process.env.PAGARME_WEBHOOK_PASSWORD;
  // Webhook nunca pode falhar aberto: ausência de credenciais bloqueia o endpoint.
  if (WEBHOOK_AUTH_REQUIRED && (!user || !pass)) return false;
  if (!user && !pass) return false;
  if (!authorizationHeader || !authorizationHeader.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(authorizationHeader.slice(6), "base64").toString("utf8");
  } catch (_) {
    return false;
  }
  const expected = `${user || ""}:${pass || ""}`;
  const a = Buffer.from(decoded);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const _markOrderPaid = async (orderId, chargeId, pagarmeOrderId) => {
  // Marca como pago e, se o pedido estava em "Pagamento Pendente" (10), avança
  // para "Aguardando" (1) — a partir daí a loja passa a tratar o pedido.
  const r = await pool.query(
    `UPDATE orders
     SET payment_status = 'paid', payment_provider = 'pagarme',
         pagarme_charge_id = COALESCE($2, pagarme_charge_id),
         status = CASE WHEN status = '10' THEN '1' ELSE status END
     WHERE id = $1
       AND COALESCE(payment_status, '') NOT IN ('refunded', 'refund_pending', 'chargedback')
       AND (
         ($2::text IS NOT NULL AND pagarme_charge_id = $2)
         OR ($3::text IS NOT NULL AND pagarme_order_id = $3)
       )
     RETURNING status`,
    [orderId, chargeId || null, pagarmeOrderId || null],
  );
  // Registra a entrada em "Aguardando" no histórico (sem duplicar se já existir).
  if (r.rows[0]?.status === "1") {
    await pool.query(
      `INSERT INTO order_status_history (order_id, status)
       SELECT $1, '1'
       WHERE NOT EXISTS (
         SELECT 1 FROM order_status_history WHERE order_id = $1 AND status = '1'
       )`,
      [orderId],
    );
  }
};

const _providerRefsFromPayload = (data) => {
  const charge = data?.id?.startsWith?.("ch_")
    ? data
    : data?.charge || data?.charges?.[0] || data?.order?.charges?.[0] || null;
  const order = data?.id?.startsWith?.("or_") ? data : data?.order || null;
  return {
    pagarmeOrderId: order?.id || charge?.order_id || data?.order_id || null,
    chargeId: charge?.id || null,
  };
};

const _webhookEventKey = (event) => String(
  event?.id || crypto.createHash("sha256").update(JSON.stringify(event || {})).digest("hex"),
);

const _setAttemptAndOrderState = async (attempt, status, refs) => {
  if (!attempt) return false;
  const normalized = String(status || "").toLowerCase();
  const providerOrderId = refs.pagarmeOrderId || attempt.pagarme_order_id;
  const chargeId = refs.chargeId || attempt.pagarme_charge_id;

  if (normalized === "paid") {
    await _storeAttempt(attempt.id, { status: "paid", providerOrderId, chargeId });
    await _markOrderPaid(attempt.order_id, chargeId, providerOrderId);
    return true;
  }
  if (["failed", "canceled", "voided"].includes(normalized)) {
    await _storeAttempt(attempt.id, { status: "failed", providerOrderId, chargeId, failureCode: normalized });
    await pool.query(
      `UPDATE orders SET payment_status = 'failed'
       WHERE id = $1 AND COALESCE(payment_status, '') NOT IN ('paid', 'refunded', 'refund_pending', 'chargedback')
         AND (($2::text IS NOT NULL AND pagarme_charge_id = $2) OR ($3::text IS NOT NULL AND pagarme_order_id = $3))`,
      [attempt.order_id, chargeId || null, providerOrderId || null],
    );
    return true;
  }
  if (["refunded", "partial_canceled"].includes(normalized)) {
    await _storeAttempt(attempt.id, { status: "refunded", providerOrderId, chargeId });
    await pool.query(
      `UPDATE orders SET payment_status = 'refunded'
       WHERE id = $1 AND (($2::text IS NOT NULL AND pagarme_charge_id = $2) OR ($3::text IS NOT NULL AND pagarme_order_id = $3))`,
      [attempt.order_id, chargeId || null, providerOrderId || null],
    );
    return true;
  }
  if (["chargedback", "chargeback"].includes(normalized)) {
    await _storeAttempt(attempt.id, { status: "chargedback", providerOrderId, chargeId });
    await pool.query(
      `UPDATE orders SET payment_status = 'chargedback'
       WHERE id = $1 AND (($2::text IS NOT NULL AND pagarme_charge_id = $2) OR ($3::text IS NOT NULL AND pagarme_order_id = $3))`,
      [attempt.order_id, chargeId || null, providerOrderId || null],
    );
    return true;
  }
  if (["underpaid", "overpaid", "partial_canceled"].includes(normalized)) {
    await _storeAttempt(attempt.id, { status: "review_required", providerOrderId, chargeId, failureCode: normalized });
    await pool.query(
      `UPDATE orders SET payment_status = 'review_required'
       WHERE id = $1 AND COALESCE(payment_status, '') <> 'paid'
         AND (($2::text IS NOT NULL AND pagarme_charge_id = $2) OR ($3::text IS NOT NULL AND pagarme_order_id = $3))`,
      [attempt.order_id, chargeId || null, providerOrderId || null],
    );
    return true;
  }
  if (["pending", "processing", "waiting_payment", "authorized"].includes(normalized)) {
    await _storeAttempt(attempt.id, { status: "pending", providerOrderId, chargeId });
    return true;
  }
  return false;
};

const handleWebhookEvent = async (event) => {
  const type = event?.type;
  const data = event?.data || {};
  if (!type) throw Object.assign(new Error("Evento Pagar.me sem tipo."), { status: 400 });

  if (type === "recipient.updated" || type === "recipient.status_changed") {
    if (data.id && data.status) await _saveRecipientStatus(data.id, data.status);
    return { processed: true, duplicate: false };
  }

  await _requirePaymentStorage();
  const eventId = _webhookEventKey(event);
  const inserted = await pool.query(
    `INSERT INTO payment_webhook_events (provider, provider_event_id, event_type, payload, received_at)
     VALUES ('pagarme', $1, $2, $3::jsonb, now())
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [eventId, type, JSON.stringify(event)],
  );
  let webhookEvent = inserted.rows[0] || null;
  if (!webhookEvent) {
    const existing = await pool.query(
      `SELECT id, processed_at FROM payment_webhook_events
       WHERE provider = 'pagarme' AND provider_event_id = $1`,
      [eventId],
    );
    webhookEvent = existing.rows[0] || null;
    if (!webhookEvent?.id || webhookEvent.processed_at) {
      return { processed: true, duplicate: true };
    }
  }

  try {
    switch (type) {
    case "order.paid":
    case "charge.paid": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, "paid", refs);
      break;
    }
    case "charge.payment_failed":
    case "order.payment_failed":
    case "charge.canceled":
    case "order.canceled": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, "failed", refs);
      break;
    }
    case "charge.refunded": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, "refunded", refs);
      break;
    }
    case "charge.partial_canceled": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, "partial_canceled", refs);
      break;
    }
    case "charge.chargedback":
    case "chargeback.received": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, "chargedback", refs);
      break;
    }
    case "charge.underpaid":
    case "charge.overpaid": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, type.endsWith("underpaid") ? "underpaid" : "overpaid", refs);
      break;
    }
    case "charge.pending":
    case "charge.processing":
    case "charge.updated": {
      const refs = _providerRefsFromPayload(data);
      const attempt = await _findAttemptByProviderRefs(refs);
      await _setAttemptAndOrderState(attempt, data.status || "processing", refs);
      break;
    }
      default:
        break;
    }
    await pool.query(
      "UPDATE payment_webhook_events SET processed_at = now(), processing_error = NULL WHERE id = $1",
      [webhookEvent.id],
    );
  } catch (error) {
    await pool.query(
      "UPDATE payment_webhook_events SET processing_error = $2 WHERE id = $1",
      [webhookEvent.id, String(error.message || "Erro ao processar evento").slice(0, 2000)],
    );
    throw error;
  }
  _paymentLog("webhook_processed", { type, event_id: eventId });
  return { processed: true, duplicate: false };
};

const reconcileOpenPaymentAttempts = async ({ limit = 50 } = {}) => {
  if (!(await _paymentStorageReady()) || !process.env.PAGARME_SECRET_KEY) return { checked: 0, skipped: true };
  const r = await pool.query(
    `SELECT * FROM payment_attempts
     WHERE provider = 'pagarme' AND method <> 'refund'
       AND status IN ('processing', 'pending', 'review_required')
       AND pagarme_charge_id IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  let checked = 0;
  for (const attempt of r.rows) {
    try {
      const { data } = await getHttp().get(`/charges/${attempt.pagarme_charge_id}`);
      const refs = _providerRefsFromPayload(data);
      await _setAttemptAndOrderState(attempt, data?.status, refs);
      checked += 1;
    } catch (error) {
      console.error("pagarme: falha na conciliação de tentativa", { attempt_id: attempt.id, message: _wrap(error).message });
    }
  }
  return { checked, skipped: false };
};

// ─── Dashboard de recebimentos (pagamentos online) ─────────────────────────────

/**
 * Resumo dos pagamentos ONLINE (payment_provider preenchido) da empresa,
 * agrupados por payment_status: paid | pending | failed. Retorna KPIs (contagem,
 * valor bruto e líquido estimado — total menos a taxa da plataforma) e as
 * transações mais recentes. `days` filtra o período (0/undefined = tudo).
 */
// Mapeia o status de um charge/order do Pagar.me para os 3 buckets do painel.
const _paymentBucket = (pmStatus) => {
  const s = String(pmStatus || "").toLowerCase();
  if (s === "paid") return "paid";
  if (["pending", "processing", "waiting_payment", "authorized_pending_capture", "generated"].includes(s)) return "pending";
  if (!s) return null; // sem status → deixa o chamador usar o fallback interno
  return "failed"; // failed, refused, not_authorized, canceled, voided, refunded, chargedback…
};

// Executa `fn` sobre `items` com concorrência limitada (evita estourar rate limit
// da Pagar.me ao consultar vários charges ao mesmo tempo).
const _mapLimit = async (items, limit, fn) => {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
};

// ─── Painel financeiro transparente ─────────────────────────────────────────

const _money = (value) => Number((Number(value) || 0).toFixed(2));
const _fromCents = (value) => _money((Number(value) || 0) / 100);
const _toCents = (value) => Math.round((Number(value) || 0) * 100);

const _financialPeriodDays = (value) => {
  const days = Number(value) || 30;
  if (days <= 30) return 30;
  if (days <= 90) return 90;
  if (days <= 365) return 365;
  return 730; // A API pública passa a limitar recebíveis pagos a 24 meses.
};

const _dateOnlyUtc = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const _periodStart = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return _dateOnlyUtc(d);
};

const _providerList = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
};

// Paginação por cursor já é aceita hoje e será o único modelo suportado pela
// Pagar.me. Limitamos a cinco páginas de 1.000 para manter a tela interativa; o
// retorno informa quando ainda há dados e o usuário pode reduzir o período.
const _fetchPayables = async (http, recipientId, createdSince) => {
  const items = [];
  let cursor = null;
  let page = 0;
  do {
    const params = {
      recipient_id: recipientId,
      created_since: createdSince,
      size: 1000,
      ...(cursor ? { forward_cursor: cursor } : {}),
    };
    const { data } = await http.get("/payables", { params });
    items.push(..._providerList(data));
    cursor = data?.paging?.forward_cursor || null;
    page += 1;
  } while (cursor && page < 5);
  return { items, truncated: Boolean(cursor) };
};

const _fetchTransfers = async (http, recipientId) => {
  const { data } = await http.get("/transfers", {
    params: { recipient_id: recipientId, count: 100 },
  });
  return _providerList(data);
};

const _fetchAnticipations = async (http, recipientId) => {
  const { data } = await http.get(`/recipients/${recipientId}/bulk_anticipations`, {
    params: { count: 100 },
  });
  return _providerList(data);
};

const _negativePayableTypes = new Set(["refund", "chargeback"]);
const _positivePayableTypes = new Set(["credit", "refund_reversal", "chargeback_refund"]);

// `amount` é o valor do recebível que impacta o saldo. As taxas são campos
// separados no contrato do payable; somá-las recompõe o bruto financeiro antes
// das deduções do provedor, sem estimar qualquer percentual.
const _publicPayable = (raw) => {
  const type = String(raw?.type || "credit").toLowerCase();
  const rawAmount = Number(raw?.amount) || 0;
  const sign = rawAmount < 0 ? -1 : (_negativePayableTypes.has(type) ? -1 : 1);
  const netCents = sign * Math.abs(rawAmount);
  const providerFeeCents = Math.max(0, Number(raw?.fee) || 0);
  const anticipationFeeCents = Math.max(0, Number(raw?.anticipation_fee) || 0);
  const fraudFeeCents = Math.max(0, Number(raw?.fraud_coverage_fee) || 0);
  const deductionsCents = providerFeeCents + anticipationFeeCents + fraudFeeCents;
  const positive = _positivePayableTypes.has(type) && netCents >= 0;
  return {
    id: raw?.id != null ? String(raw.id) : null,
    charge_id: raw?.charge_id != null ? String(raw.charge_id) : null,
    type,
    status: String(raw?.status || "").toLowerCase() || null,
    payment_method: String(raw?.payment_method || "").toLowerCase() || null,
    installment: Number(raw?.installment) || null,
    created_at: raw?.created_at || raw?.accrual_at || null,
    payment_date: raw?.payment_date || null,
    gross_cents: positive ? netCents + deductionsCents : netCents,
    net_cents: netCents,
    provider_fee_cents: providerFeeCents,
    anticipation_fee_cents: anticipationFeeCents,
    fraud_fee_cents: fraudFeeCents,
  };
};

const _platformSplitCents = (order) => {
  const totalCents = _toCents(order?.total);
  const serviceFeeCents = Math.max(0, _toCents(order?.service_fee));
  const goodsCents = Math.max(0, totalCents - serviceFeeCents);
  return Math.min(
    totalCents,
    Math.max(0, Math.round(goodsCents * (PLATFORM_FEE_PERCENT / 100)) + serviceFeeCents),
  );
};

const _safeBankAccount = (bank) => {
  if (!bank || typeof bank !== "object") return null;
  const account = String(bank.account_number || bank.conta || "").replace(/\D/g, "");
  const branch = String(bank.branch_number || bank.agencia || "").replace(/\D/g, "");
  const bankCode = String(bank.bank || bank.bank_code || "").replace(/\D/g, "");
  return {
    bank_code: bankCode || null,
    bank_name: bank.bank_name || bank.name || (bankCode ? `Banco ${bankCode}` : null),
    account_last4: account ? account.slice(-4).padStart(4, "•") : null,
    branch_last4: branch ? branch.slice(-4).padStart(4, "•") : null,
    type: bank.type || null,
  };
};

const _advanceWeekendUtc = (date) => {
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date;
};

// Próxima data calculada exclusivamente a partir da frequência configurada.
// Feriados bancários não estão disponíveis nesta integração; a interface deixa
// explícito que é uma previsão e não uma liquidação prometida pela Pagar.me.
const _nextTransferDate = (settings, now = new Date()) => {
  if (!settings?.transfer_enabled) return null;
  const interval = String(settings.transfer_interval || "").toLowerCase();
  const day = Number(settings.transfer_day);
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12));
  if (interval === "daily") return _dateOnlyUtc(_advanceWeekendUtc(base));
  if (interval === "weekly" && day >= 1 && day <= 5) {
    const delta = (day - base.getUTCDay() + 7) % 7;
    base.setUTCDate(base.getUTCDate() + delta);
    return _dateOnlyUtc(base);
  }
  if (interval === "monthly" && day >= 1 && day <= 31) {
    let year = base.getUTCFullYear();
    let month = base.getUTCMonth();
    if (base.getUTCDate() > day) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    const last = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    return _dateOnlyUtc(_advanceWeekendUtc(new Date(Date.UTC(year, month, Math.min(day, last), 12))));
  }
  return null;
};

const _transferStatus = (status) => String(status || "").toLowerCase() || null;

const _publicTransfer = (raw) => {
  const amountCents = Math.max(0, Number(raw?.amount) || 0);
  const feeCents = Math.max(0, Number(raw?.fee) || 0);
  return {
    id: raw?.id != null ? String(raw.id) : null,
    type: "transfer",
    status: _transferStatus(raw?.status),
    gross_amount: _fromCents(amountCents + feeCents),
    fees: _fromCents(feeCents),
    net_amount: _fromCents(amountCents),
    created_at: raw?.date_created || raw?.created_at || null,
    estimated_at: raw?.funding_estimated_date || null,
    completed_at: raw?.funding_date || null,
    reference: raw?.transaction_id != null ? String(raw.transaction_id) : (raw?.id != null ? String(raw.id) : null),
  };
};

const _publicAnticipation = (raw) => {
  const grossCents = Math.max(0, Number(raw?.amount) || 0);
  const providerFeeCents = Math.max(0, Number(raw?.fee) || 0);
  const anticipationFeeCents = Math.max(0, Number(raw?.anticipation_fee) || 0);
  const fraudFeeCents = Math.max(0, Number(raw?.fraud_coverage_fee) || 0);
  const feesCents = providerFeeCents + anticipationFeeCents + fraudFeeCents;
  return {
    date: raw?.created_at || raw?.updated_at || null,
    availability_date: raw?.payment_date || null,
    type: "anticipation",
    method: "receivables",
    status: String(raw?.status || "").toLowerCase() || null,
    gross_amount: _fromCents(grossCents),
    fees: _fromCents(feesCents),
    net_amount: _fromCents(Math.max(0, grossCents - feesCents)),
    reference: raw?.id != null ? String(raw.id) : null,
    description: raw?.automatic_transfer === true ? "Antecipação automática" : "Antecipação de recebíveis",
    fee_breakdown: {
      provider: _fromCents(providerFeeCents),
      anticipation: _fromCents(anticipationFeeCents),
      antifraud: _fromCents(fraudFeeCents),
    },
  };
};

const _paymentMethod = (value) => {
  const method = String(value || "").toLowerCase();
  if (["credit_card", "card", "credit"].includes(method)) return "credit_card";
  if (["debit_card", "debit"].includes(method)) return "debit_card";
  if (method === "pix") return "pix";
  if (method === "boleto") return "boleto";
  return method || "other";
};

const _feeProfile = () => ({
  ...PAGARME_CONTRACT_FEE_PROFILE,
  arbian: {
    percentage: PLATFORM_FEE_PERCENT,
    rule: "Percentual sobre itens e entrega; a taxa de serviço do pedido também é destinada à plataforma.",
    actual_value_source: "Split registrado em cada venda",
  },
});

/**
 * Painel financeiro completo do recebedor. A API do provedor é a fonte para
 * saldo, taxas realizadas, agenda e transferências; o banco local só vincula o
 * recebível ao pedido para explicar a parcela Arbian do split.
 */
const getFinancialDashboard = async (companyId, { days = 30 } = {}) => {
  const company = await _getCompany(companyId);
  if (!company) throw Object.assign(new Error("Empresa não encontrada."), { status: 404 });
  const periodDays = _financialPeriodDays(days);
  const base = {
    connected: Boolean(company.pagarme_recipient_id),
    currency: "BRL",
    generated_at: new Date().toISOString(),
    period_days: periodDays,
    history_limit_days: 730,
    fee_profile: _feeProfile(),
  };
  if (!company.pagarme_recipient_id) {
    return {
      ...base,
      balance: null,
      sales: null,
      receivables: null,
      automatic_transfers: null,
      history: [],
      availability: {
        balance: { available: false, message: "Conecte a Pagar.me para consultar o saldo." },
        receivables: { available: false, message: "Conecte a Pagar.me para consultar os recebíveis." },
        transfers: { available: false, message: "Conecte a Pagar.me para consultar as transferências." },
        anticipations: { available: false, message: "Conecte a Pagar.me para consultar as antecipações." },
      },
    };
  }

  const http = getHttp();
  const recipientId = company.pagarme_recipient_id;
  let recipient;
  try {
    const response = await http.get(`/recipients/${recipientId}`);
    recipient = response.data || {};
  } catch (error) {
    throw _wrap(error, "Falha ao carregar o recebedor");
  }

  const createdSince = _periodStart(periodDays);
  const periodSql = "AND o.created_at >= NOW() - ($2::int * INTERVAL '1 day')";
  const [balanceResult, payablesResult, transfersResult, anticipationsResult, ordersResult] = await Promise.allSettled([
    http.get(`/recipients/${recipientId}/balance`),
    _fetchPayables(http, recipientId, createdSince),
    _fetchTransfers(http, recipientId),
    _fetchAnticipations(http, recipientId),
    pool.query(
      `SELECT o.id, o.tag, o.total, o.service_fee, o.created_at,
              o.pagarme_charge_id, o.online_payment_method, o.payment_status,
              c.name AS client_name
         FROM orders o
         LEFT JOIN clients c ON c.id = o.client_id
        WHERE o.company_id = $1 AND o.payment_provider = 'pagarme' ${periodSql}
        ORDER BY o.created_at DESC
        LIMIT 1000`,
      [Number(companyId), periodDays],
    ),
  ]);

  const availability = {
    balance: {
      available: balanceResult.status === "fulfilled",
      message: balanceResult.status === "fulfilled" ? null : "Saldo temporariamente indisponível na Pagar.me.",
    },
    receivables: {
      available: payablesResult.status === "fulfilled",
      message: payablesResult.status === "fulfilled" ? null : "Agenda de recebíveis temporariamente indisponível na Pagar.me.",
    },
    transfers: {
      available: transfersResult.status === "fulfilled",
      message: transfersResult.status === "fulfilled" ? null : "Histórico de transferências temporariamente indisponível na Pagar.me.",
    },
    anticipations: {
      available: anticipationsResult.status === "fulfilled",
      message: anticipationsResult.status === "fulfilled" ? null : "Histórico de antecipações temporariamente indisponível na Pagar.me.",
    },
  };

  const balanceRaw = balanceResult.status === "fulfilled" ? (balanceResult.value.data || {}) : {};
  const transferredAvailable = balanceRaw.transferred_amount != null;
  const balance = balanceResult.status === "fulfilled" ? {
    available: _fromCents(balanceRaw.available_amount),
    waiting_funds: _fromCents(balanceRaw.waiting_funds_amount),
    transferred: transferredAvailable ? _fromCents(balanceRaw.transferred_amount) : null,
    transferred_available: transferredAvailable,
    min_withdrawal: MIN_WITHDRAWAL,
    max_withdrawal: _fromCents(balanceRaw.available_amount),
    min_withdrawal_source: "Regra configurada no Arbian",
  } : null;

  const orderRows = ordersResult.status === "fulfilled" ? ordersResult.value.rows : [];
  const ordersByCharge = new Map(
    orderRows.filter((row) => row.pagarme_charge_id).map((row) => [String(row.pagarme_charge_id), row]),
  );
  const payablesPayload = payablesResult.status === "fulfilled" ? payablesResult.value : { items: [], truncated: false };
  const payables = payablesPayload.items.map(_publicPayable);

  // Uma venda parcelada gera vários recebíveis. Agrupamos por charge para que
  // o comerciante veja uma única decomposição bruto → taxas → líquido.
  const chargeGroups = new Map();
  for (const payable of payables) {
    if (payable.type !== "credit" || payable.net_cents < 0) continue;
    const key = payable.charge_id || `payable:${payable.id}`;
    if (!chargeGroups.has(key)) {
      chargeGroups.set(key, {
        charge_id: payable.charge_id,
        reference: key,
        method: _paymentMethod(payable.payment_method),
        created_at: payable.created_at,
        payment_dates: [],
        statuses: [],
        installments: 0,
        merchant_gross_cents: 0,
        provider_fee_cents: 0,
        anticipation_fee_cents: 0,
        fraud_fee_cents: 0,
        net_cents: 0,
      });
    }
    const group = chargeGroups.get(key);
    group.merchant_gross_cents += payable.gross_cents;
    group.provider_fee_cents += payable.provider_fee_cents;
    group.anticipation_fee_cents += payable.anticipation_fee_cents;
    group.fraud_fee_cents += payable.fraud_fee_cents;
    group.net_cents += payable.net_cents;
    if (payable.payment_date) group.payment_dates.push(payable.payment_date);
    if (payable.status) group.statuses.push(payable.status);
    group.installments = Math.max(group.installments, payable.installment || 0);
    if (payable.created_at && (!group.created_at || new Date(payable.created_at) < new Date(group.created_at))) {
      group.created_at = payable.created_at;
    }
  }

  const calculations = [];
  for (const group of chargeGroups.values()) {
    const order = group.charge_id ? ordersByCharge.get(group.charge_id) : null;
    const arbianFeeCents = order ? _platformSplitCents(order) : null;
    const arbianServiceFeeCents = order ? Math.max(0, _toCents(order.service_fee)) : null;
    const arbianPercentageFeeCents = arbianFeeCents == null
      ? null
      : Math.max(0, arbianFeeCents - arbianServiceFeeCents);
    const chargedCents = order ? _toCents(order.total) : group.merchant_gross_cents;
    const knownDeductions = (arbianFeeCents || 0) + group.provider_fee_cents + group.anticipation_fee_cents + group.fraud_fee_cents;
    const otherAdjustmentsCents = chargedCents - knownDeductions - group.net_cents;
    const waiting = group.statuses.some((status) => status === "waiting_funds");
    const paid = group.statuses.length > 0 && group.statuses.every((status) => ["paid", "prepaid"].includes(status));
    calculations.push({
      charge_id: group.charge_id,
      reference: order?.tag || group.reference,
      order_id: order?.id || null,
      client_name: order?.client_name || null,
      method: group.method,
      installments: group.installments || null,
      created_at: order?.created_at || group.created_at,
      next_payment_date: group.payment_dates.sort()[0] || null,
      last_payment_date: group.payment_dates.sort().at(-1) || null,
      status: waiting ? "waiting_funds" : (paid ? "paid" : (group.statuses[0] || null)),
      gross_amount: _fromCents(chargedCents),
      arbian_fee: arbianFeeCents == null ? null : _fromCents(arbianFeeCents),
      arbian_percentage_fee: arbianPercentageFeeCents == null ? null : _fromCents(arbianPercentageFeeCents),
      arbian_service_fee: arbianServiceFeeCents == null ? null : _fromCents(arbianServiceFeeCents),
      provider_fee: _fromCents(group.provider_fee_cents),
      anticipation_fee: _fromCents(group.anticipation_fee_cents),
      fraud_fee: _fromCents(group.fraud_fee_cents),
      other_adjustments: Math.abs(otherAdjustmentsCents) <= 1 ? 0 : _fromCents(otherAdjustmentsCents),
      net_amount: _fromCents(group.net_cents),
      values_source: "Pagar.me payables + split Arbian",
    });
  }
  calculations.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const byMethodMap = new Map();
  for (const calc of calculations) {
    if (!byMethodMap.has(calc.method)) {
      byMethodMap.set(calc.method, {
        method: calc.method,
        count: 0,
        gross_amount: 0,
        arbian_fee: 0,
        provider_fee: 0,
        anticipation_fee: 0,
        fraud_fee: 0,
        other_adjustments: 0,
        net_amount: 0,
        arbian_fee_available: true,
      });
    }
    const item = byMethodMap.get(calc.method);
    item.count += 1;
    item.gross_amount += calc.gross_amount;
    if (calc.arbian_fee == null) item.arbian_fee_available = false;
    else item.arbian_fee += calc.arbian_fee;
    item.provider_fee += calc.provider_fee;
    item.anticipation_fee += calc.anticipation_fee;
    item.fraud_fee += calc.fraud_fee;
    item.other_adjustments += calc.other_adjustments;
    item.net_amount += calc.net_amount;
  }
  const byMethod = [...byMethodMap.values()].map((item) => Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, typeof value === "number" ? _money(value) : value]),
  ));

  const timelineMap = new Map();
  for (const payable of payables) {
    if (payable.type !== "credit" || payable.status !== "waiting_funds" || !payable.payment_date) continue;
    const date = _dateOnlyUtc(payable.payment_date);
    if (!date) continue;
    if (!timelineMap.has(date)) {
      timelineMap.set(date, { date, gross_amount: 0, fees: 0, net_amount: 0, methods: new Set(), references: new Set() });
    }
    const item = timelineMap.get(date);
    item.gross_amount += _fromCents(payable.gross_cents);
    item.fees += _fromCents(payable.provider_fee_cents + payable.anticipation_fee_cents + payable.fraud_fee_cents);
    item.net_amount += _fromCents(payable.net_cents);
    item.methods.add(_paymentMethod(payable.payment_method));
    if (payable.charge_id) item.references.add(payable.charge_id);
  }
  const timeline = [...timelineMap.values()]
    .map((item) => ({
      date: item.date,
      gross_amount: _money(item.gross_amount),
      fees: _money(item.fees),
      net_amount: _money(item.net_amount),
      methods: [...item.methods],
      receivables_count: item.references.size,
      status: "waiting_funds",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const summary = calculations.reduce((acc, calc) => ({
    gross_amount: acc.gross_amount + calc.gross_amount,
    arbian_fee: acc.arbian_fee + (calc.arbian_fee || 0),
    provider_fee: acc.provider_fee + calc.provider_fee,
    anticipation_fee: acc.anticipation_fee + calc.anticipation_fee,
    fraud_fee: acc.fraud_fee + calc.fraud_fee,
    other_adjustments: acc.other_adjustments + calc.other_adjustments,
    net_amount: acc.net_amount + calc.net_amount,
  }), { gross_amount: 0, arbian_fee: 0, provider_fee: 0, anticipation_fee: 0, fraud_fee: 0, other_adjustments: 0, net_amount: 0 });
  for (const key of Object.keys(summary)) summary[key] = _money(summary[key]);

  const calculatedChargeIds = new Set(calculations.map((item) => item.charge_id).filter(Boolean));
  const pendingOrders = orderRows.filter((row) => row.payment_status !== "paid" && !calculatedChargeIds.has(String(row.pagarme_charge_id || "")));
  const sales = {
    paid_count: calculations.length,
    gross_amount: summary.gross_amount,
    pending_count: pendingOrders.filter((row) => !["failed", "refunded", "chargedback"].includes(String(row.payment_status))).length,
    pending_amount: _money(pendingOrders
      .filter((row) => !["failed", "refunded", "chargedback"].includes(String(row.payment_status)))
      .reduce((sum, row) => sum + Number(row.total || 0), 0)),
    failed_count: pendingOrders.filter((row) => ["failed", "refunded", "chargedback"].includes(String(row.payment_status))).length,
  };

  const transfers = transfersResult.status === "fulfilled"
    ? transfersResult.value.map(_publicTransfer).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    : [];
  const transferSettings = _publicTransferSettings(recipient.transfer_settings);
  const bankAccount = _safeBankAccount(recipient.default_bank_account);
  const automaticTransfers = {
    settings: transferSettings,
    bank_account: bankAccount,
    next_scheduled_at: _nextTransferDate(transferSettings),
    next_scheduled_at_is_estimate: true,
    estimated_amount: transferSettings?.transfer_enabled && balance ? balance.available : null,
    estimated_fee: null,
    estimated_net: null,
    estimate_message: "A Pagar.me não informa antecipadamente a tarifa e o líquido da próxima transferência; os valores realizados aparecem no histórico.",
    contractual_transfer_fee: PAGARME_CONTRACT_FEE_PROFILE.transfer.fixed,
    history: transfers.slice(0, 20),
  };

  const history = calculations.map((calc) => ({
    date: calc.created_at,
    availability_date: calc.next_payment_date,
    type: "sale",
    method: calc.method,
    status: calc.status,
    gross_amount: calc.gross_amount,
    fees: _money((calc.arbian_fee || 0) + calc.provider_fee + calc.anticipation_fee + calc.fraud_fee + calc.other_adjustments),
    net_amount: calc.net_amount,
    reference: calc.reference,
    description: calc.client_name ? `Venda para ${calc.client_name}` : "Venda online",
    fee_breakdown: {
      arbian: calc.arbian_fee,
      arbian_percentage: calc.arbian_percentage_fee,
      arbian_service: calc.arbian_service_fee,
      provider: calc.provider_fee,
      anticipation: calc.anticipation_fee,
      antifraud: calc.fraud_fee,
      other_adjustments: calc.other_adjustments,
    },
  }));
  for (const payable of payables) {
    if (payable.type === "credit") continue;
    const feeCents = payable.provider_fee_cents + payable.anticipation_fee_cents + payable.fraud_fee_cents;
    history.push({
      date: payable.created_at,
      availability_date: payable.payment_date,
      type: payable.type,
      method: _paymentMethod(payable.payment_method),
      status: payable.status,
      gross_amount: _fromCents(payable.gross_cents),
      fees: _fromCents(feeCents),
      net_amount: _fromCents(payable.net_cents),
      reference: payable.charge_id || payable.id,
      description: payable.type === "refund" ? "Estorno" : payable.type === "chargeback" ? "Chargeback" : "Ajuste de recebível",
    });
  }
  history.push(...transfers.map((transfer) => ({
    date: transfer.created_at,
    availability_date: transfer.completed_at || transfer.estimated_at,
    type: "transfer",
    method: "bank_transfer",
    status: transfer.status,
    gross_amount: transfer.gross_amount,
    fees: transfer.fees,
    net_amount: transfer.net_amount,
    reference: transfer.reference,
    description: "Transferência para a conta bancária",
  })));
  const anticipations = anticipationsResult.status === "fulfilled"
    ? anticipationsResult.value.map(_publicAnticipation)
    : [];
  history.push(...anticipations);
  history.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  return {
    ...base,
    recipient_status: recipient.status || company.pagarme_recipient_status || null,
    balance,
    sales,
    receivables: {
      summary,
      by_method: byMethod,
      next: timeline[0] || null,
      timeline,
      calculations: calculations.slice(0, 20),
      truncated: payablesPayload.truncated,
    },
    automatic_transfers: automaticTransfers,
    anticipations,
    history: history.slice(0, 500),
    history_truncated: history.length > 500 || payablesPayload.truncated,
    availability,
  };
};

const getPaymentsSummary = async (companyId, { days = 0 } = {}) => {
  const cid = Number(companyId);
  if (!cid) return null;
  const d = Number(days) || 0;
  const periodClause = d > 0 ? `AND o.created_at >= NOW() - INTERVAL '${d} days'` : "";

  // O banco é o ÍNDICE dos pedidos/charges da empresa no período (paid/failed já
  // vêm confirmados pela Pagar.me via webhook). Só os PENDENTES são reconsultados
  // ao vivo abaixo. Cap em 120; o filtro de período mantém isso pequeno.
  const ordersRes = await pool.query(
    `SELECT o.id, o.tag, o.total, o.service_fee, o.created_at,
            o.pagarme_charge_id, o.online_payment_method, o.payment_status,
            c.name AS client_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id
      WHERE o.company_id = $1 AND o.payment_provider = 'pagarme' ${periodClause}
      ORDER BY o.created_at DESC
      LIMIT 120`,
    [cid],
  );
  const rows = ordersRes.rows;

  // Conexão com a Pagar.me (chave da conta ATUAL).
  let http = null;
  try {
    http = getHttp();
  } catch (_) {
    http = null; // Pagar.me não configurado → cai 100% no fallback interno.
  }

  // Fonte da verdade = Pagar.me da CONTA ATUAL. Verificamos AO VIVO todas as
  // cobranças (não só as pendentes): assim, ao trocar de conta, os valores
  // refletem a conta nova. Cada charge é consultado com a chave atual —
  //  • encontrado  → usamos status/valor REAIS do Pagar.me;
  //  • 404 (não existe na conta atual) → é de uma CONTA ANTIGA e fica de FORA;
  //  • erro de rede (sem resposta) → não descartamos: caímos no valor do banco.
  // O custo é limitado (cap de 120 pedidos, concorrência 6, com botão "Atualizar").
  const withCharge = rows.filter((r) => r.pagarme_charge_id);
  const live = new Map();
  const staleIds = new Set(); // charges que não pertencem à conta Pagar.me atual
  if (http) {
    const results = await _mapLimit(withCharge, 6, async (r) => {
      try {
        const { data } = await http.get(`/charges/${r.pagarme_charge_id}`);
        return { id: r.id, status: data?.status || null, amount: data?.amount, found: true };
      } catch (e) {
        // 404 = a cobrança não existe nesta conta (conta antiga) → descartar.
        // Qualquer outro erro (timeout/5xx) mantém o pedido via fallback do banco.
        const isNotFound = e?.response?.status === 404;
        return { id: r.id, status: null, amount: null, found: !isNotFound };
      }
    });
    for (const res of results) {
      live.set(res.id, res);
      if (!res.found) staleIds.add(res.id);
    }
  }

  const empty = () => ({ count: 0, amount: 0, net: 0 });
  const totals = { paid: empty(), pending: empty(), failed: empty() };
  const recent = [];
  let liveCount = 0;
  let excluded = 0; // pedidos ignorados por serem de conta antiga / não verificáveis

  for (const r of rows) {
    // Modo AO VIVO (Pagar.me configurado): só entram pedidos cuja cobrança foi
    // confirmada na conta ATUAL. Descartamos:
    //  • cobranças 404 (conta antiga);
    //  • pedidos sem charge_id (não há como validar contra a conta atual).
    if (http) {
      if (!r.pagarme_charge_id || staleIds.has(r.id)) {
        excluded++;
        continue;
      }
    }

    const l = live.get(r.id);
    let bucket = l && l.status ? _paymentBucket(l.status) : null;
    if (bucket) {
      liveCount++;
    } else {
      // Fallback interno (Pagar.me offline, ou charge encontrado sem status).
      const ps = r.payment_status;
      bucket = ps === "paid" ? "paid" : ps === "failed" ? "failed" : "pending";
    }
    // Valor SEMPRE do Pagar.me quando disponível (o total do banco pode divergir).
    const amount = l && l.amount != null ? Number(l.amount) / 100 : Number(r.total);
    const net = amount - Number(r.service_fee || 0);

    totals[bucket].count += 1;
    totals[bucket].amount += amount;
    totals[bucket].net += net;

    if (recent.length < 20) {
      recent.push({
        id: r.id,
        tag: r.tag,
        total: amount,
        net,
        payment_status: bucket, // paid | pending | failed (já mapeado)
        online_payment_method: r.online_payment_method,
        client_name: r.client_name,
        created_at: r.created_at,
      });
    }
  }

  for (const k of Object.keys(totals)) {
    totals[k].amount = Number(totals[k].amount.toFixed(2));
    totals[k].net = Number(totals[k].net.toFixed(2));
  }

  return {
    period_days: d,
    // Valores refletem a CONTA ATUAL do Pagar.me: cada cobrança é validada ao
    // vivo agora; cobranças de contas antigas (404) não entram nos totais.
    source: http ? "pagarme_live" : "local",
    live_checked: http ? withCharge.length : 0, // charges consultados ao vivo
    live_applied: liveCount, // quantos tiveram status resolvido pela consulta
    excluded, // pedidos descartados (conta antiga / sem charge) no modo ao vivo
    totals,
    recent,
  };
};

module.exports = {
  createOrUpdateRecipient,
  createKycLink,
  refreshRecipientStatus,
  getRecipientDetails,
  updateTransferSettings,
  getRecipientBalance,
  requestWithdrawal,
  getPaymentsSummary,
  getFinancialDashboard,
  createCardCharge,
  createPixCharge,
  refundCharge,
  requestRefundForOrder,
  createPublicPaymentSession,
  isPublicCheckoutConfigured,
  isPaymentInfrastructureReady,
  threeDsAvailable,
  createThreeDsToken,
  savedCardsAvailable,
  statementDescriptor: (companyName) => _buildStatementDescriptor(companyName),
  listSavedCardsForClient,
  deleteSavedCardForClient,
  listSavedCardsForUser: listSavedCards,
  deleteSavedCardForUser: deleteSavedCard,
  setDefaultSavedCardForUser: setDefaultSavedCard,
  verifyBasicAuth,
  handleWebhookEvent,
  reconcileOpenPaymentAttempts,
  // Funções puras expostas apenas para testes de contratos do provedor.
  _testing: {
    isAntifraudDecline: _isAntifraudDecline,
    cardFailureMessage: _cardFailureMessage,
    normalizeClientIp: _normalizeClientIp,
    itemTotalAfterShipping: _itemTotalAfterShipping,
    buildPagarmeItems: _buildPagarmeItems,
    normalizeTransferSettings: _normalizeTransferSettings,
    friendlyPaymentValidationMessage: _friendlyPaymentValidationMessage,
    toBillingAddress: _toBillingAddress,
    buildBillingAddress: _buildBillingAddress,
    publicPayable: _publicPayable,
    publicAnticipation: _publicAnticipation,
    platformSplitCents: _platformSplitCents,
    nextTransferDate: _nextTransferDate,
    financialPeriodDays: _financialPeriodDays,
  },
};
