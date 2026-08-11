const axios = require("axios");
const pool = require("../db");
const identityService = require("./identityService");
const { columnExists } = require("../helpers/schema");

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

// Normaliza erros do axios para o padrão { message, status } do projeto,
// SEMPRE anexando os detalhes de validação do Pagar.me (data.errors) — sem eles
// a mensagem "The request is invalid." não diz qual campo falhou.
const _wrap = (error, fallback) => {
  const status = error?.response?.status || error?.status || 500;
  const data = error?.response?.data;
  let apiMsg = data?.message || error?.message;
  const details = _formatErrors(data?.errors);
  if (details) apiMsg = apiMsg ? `${apiMsg} — ${details}` : details;
  // Log completo do corpo de erro para inspeção no servidor.
  if (data) console.error("Pagar.me API error body:", JSON.stringify(data));
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

// ─── Helpers ────────────────────────────────────────────────────────────────────

// "active" é o único status em que o recebedor pode transacionar.
const _isActiveStatus = (status) => String(status || "").toLowerCase() === "active";

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

// Domínio real usado para sintetizar o e-mail do cliente quando ele não informa
// um (o checkout NÃO pede e-mail). Um domínio real (arbian.com.br) evita a
// reprovação do antifraude que acontecia com o domínio inexistente antigo.
const SYNTHETIC_EMAIL_DOMAIN = (process.env.PAGARME_SYNTHETIC_EMAIL_DOMAIN || "arbian.com.br").replace(/^@/, "");

// Gera um e-mail plausível a partir do NOME: "João da Silva" -> joao.silva@arbian.com.br.
// Usa primeiro + último nome; um só nome vira o local-part; sem nome cai em
// "cliente{id}". Remove acentos e caracteres inválidos de e-mail.
const _emailFromName = (name, fallbackId) => {
  const parts = String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let local;
  if (parts.length >= 2) local = `${parts[0]}.${parts[parts.length - 1]}`;
  else if (parts.length === 1) local = parts[0];
  else local = `cliente${fallbackId || ""}`;
  return `${local}@${SYNTHETIC_EMAIL_DOMAIN}`;
};

// Monta o objeto customer do pedido a partir do cliente + dados informados no
// checkout. `billingAddress` (quando disponível) vai também em customer.address —
// o antifraude usa o endereço do titular para pontuar a transação.
const _buildCustomer = (client, extra = {}, billingAddress = null) => {
  // Documento informado no pagamento OU o já salvo no cadastro do cliente.
  const doc = _onlyDigits(extra.document || client.client_document || client.document);
  const phone = _parsePhone(extra.phone || client.client_phone || client.phone);
  const rawEmail = extra.email || client.client_email || client.email;
  const customer = {
    name: (extra.name || client.client_name || client.name || "Cliente").slice(0, 64),
    type: doc.length > 11 ? "company" : "individual",
  };
  // E-mail real quando existir; senão sintetiza a partir do nome (domínio real).
  customer.email = _isPlausibleEmail(rawEmail)
    ? String(rawEmail).trim().toLowerCase()
    : _emailFromName(customer.name, client.client_id || client.id);
  if (doc.length === 11 || doc.length === 14) customer.document = doc;
  if (phone) customer.phones = { mobile_phone: phone };
  // Endereço do titular para o antifraude (mesmo shape do billing_address).
  if (billingAddress) customer.address = billingAddress;
  return customer;
};

// Converte um conjunto de campos (rua/número/bairro/cidade/UF/CEP) no formato
// billing_address do Pagar.me. Retorna null se faltar algum campo obrigatório
// (line_1, zip_code, city, state) — evita enviar um endereço incompleto.
const _toBillingAddress = ({ street, number, neighborhood, city, state, zip }) => {
  const zipDigits = _onlyDigits(zip).slice(0, 8);
  const uf = String(state || "").trim().toUpperCase().slice(0, 2);
  const cityName = String(city || "").trim().slice(0, 64);
  // line_1 no formato do Pagar.me: "número, rua, bairro".
  const line1 = [number, street, neighborhood]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ");
  if (!zipDigits || !uf || !cityName || !line1) return null;
  return { line_1: line1, zip_code: zipDigits, city: cityName, state: uf, country: "BR" };
};

// Monta o billing_address exigido pelo antifraude do Pagar.me em cobranças no
// cartão (sem ele a cobrança nasce "failed" com
// `validation_error | billing | "value" is required`). Prioriza o endereço do
// CLIENTE (endereço salvo em user_addresses, mais relevante para o antifraude) e
// recorre ao endereço cadastrado da empresa quando o cliente não tem um endereço
// estruturado. Retorna null se nenhum dos dois estiver completo.
const _buildBillingAddress = (order) => {
  const client = _toBillingAddress({
    street: order.cli_street, number: order.cli_number, neighborhood: order.cli_neighborhood,
    city: order.cli_city, state: order.cli_state, zip: order.cli_zip,
  });
  if (client) return client;
  return _toBillingAddress({
    street: order.addr_street, number: order.addr_number, neighborhood: order.addr_neighborhood,
    city: order.addr_city, state: order.addr_state, zip: order.addr_zip,
  });
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
    };
  } catch (error) {
    throw _wrap(error, "Falha ao carregar os dados do recebedor");
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
  const orderRes = await pool.query(
    `SELECT o.id, o.uuid, o.total, o.subtotal, o.delivery_fee, o.tag, o.company_id, o.client_id, o.payment_status, o.service_fee,
            c.name AS company_name, c.pagarme_recipient_id, c.pagarme_charges_enabled,
            cl.name AS client_name, cl.phone AS client_phone, cl.document AS client_document,
            cl.user_id AS client_user_id,
            em.value_norm AS client_email,
            ca.street AS addr_street, ca.number AS addr_number, ca.neighborhood AS addr_neighborhood,
            ca.city AS addr_city, ca.state AS addr_state, ca.zip_code AS addr_zip,
            ua.street AS cli_street, ua.number AS cli_number, ua.neighborhood AS cli_neighborhood,
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
       SELECT street, number, neighborhood, city, state, zip
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
  if (!PLATFORM_RECIPIENT_ID) {
    throw Object.assign(new Error("PAGARME_PLATFORM_RECIPIENT_ID não configurado."), { status: 503 });
  }
  return order;
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

// Monta os "Itens" do pedido para a Pagar.me a partir de order_items (o que o
// cliente pediu) + linhas de Taxa de entrega e Taxa de serviço. Cada linha vai
// com quantity=1 e amount = subtotal da linha (em centavos) para não introduzir
// erro de arredondamento por unidade. A SOMA das linhas DEVE bater exatamente com
// o valor cobrado (totalCents) — reconciliamos o resto de arredondamento na última
// linha e, em qualquer inconsistência, caímos num item único de valor = total
// (nunca cobra valor diferente do pedido).
const _buildPagarmeItems = async (order, totalCents) => {
  const single = [{
    code: String(order.id),
    amount: totalCents,
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
    if (deliveryCents >= 1) lines.push({ code: "delivery", amount: deliveryCents, description: "Taxa de entrega", quantity: 1 });
    if (serviceCents >= 1) lines.push({ code: "service", amount: serviceCents, description: "Taxa de serviço", quantity: 1 });

    if (lines.length === 0) return single;

    // Reconcilia o arredondamento na última linha (todas com quantity=1).
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const diff = totalCents - sum;
    if (diff !== 0) lines[lines.length - 1].amount += diff;

    const valid = lines.every((l) => Number.isInteger(l.amount) && l.amount >= 1);
    const finalSum = lines.reduce((s, l) => s + l.amount, 0);
    // Só usa a lista itemizada se ela for válida E somar EXATAMENTE o total.
    return valid && finalSum === totalCents ? lines : single;
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

// Valida que o card_id pertence ao usuário (evita usar cartão de outra pessoa).
const _assertOwnedCard = async (userId, cardId) => {
  const r = await pool.query(
    "SELECT 1 FROM user_payment_tokens WHERE user_id = $1 AND token = $2 AND provider = 'pagarme' AND revoked_at IS NULL LIMIT 1",
    [userId, cardId],
  );
  if (!r.rows[0]) throw Object.assign(new Error("Cartão salvo inválido."), { status: 400 });
};

const listSavedCards = async (userId) => {
  if (!userId) return [];
  const r = await pool.query(
    `SELECT id, token AS card_id, brand, last4, is_default
     FROM user_payment_tokens
     WHERE user_id = $1 AND provider = 'pagarme' AND revoked_at IS NULL
     ORDER BY is_default DESC, id DESC`,
    [userId],
  );
  return r.rows;
};

// Revoga (soft) e tenta remover do cofre. Só age no cartão do próprio usuário.
const deleteSavedCard = async (userId, tokenRowId) => {
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

// Versões que resolvem o usuário pelo telefone (rotas públicas). O telefone é a
// prova de posse já usada no fluxo público.
const listSavedCardsByPhone = async (phone) => {
  const userId = await identityService.lookupUserIdByPhone(phone);
  return userId ? listSavedCards(userId) : [];
};

const deleteSavedCardByPhone = async (phone, tokenRowId) => {
  const userId = await identityService.lookupUserIdByPhone(phone);
  if (!userId) throw Object.assign(new Error("Cartão não encontrado."), { status: 404 });
  return deleteSavedCard(userId, tokenRowId);
};

/**
 * Cria um pedido com pagamento no CARTÃO. Suporta 3 modos (via `extra`):
 *  • cartão novo (card_token) — cobrança avulsa (comportamento padrão);
 *  • cartão novo + `saveCard:true` — salva no cofre e cobra pelo card_id;
 *  • `cardId` — cobra um cartão já salvo do usuário (sem redigitar).
 * `extra`: { document, email, name, phone, installments, cardId, saveCard }.
 */
const createCardCharge = async (orderId, cardToken, extra = {}) => {
  const cardId = extra.cardId || null;
  const saveCard = extra.saveCard === true;
  if (!cardToken && !cardId) {
    throw Object.assign(new Error("card_token ou card_id é obrigatório."), { status: 400 });
  }
  const order = await _loadOrderForCharge(orderId);
  const { totalCents, split } = _computeSplit(order);
  const installments = Math.min(12, Math.max(1, Number(extra.installments) || 1));
  const billingAddress = _buildBillingAddress(order);
  const userId = order.client_user_id;

  // O e-mail do titular é montado no _buildCustomer (real quando existe, senão
  // sintetizado do nome com domínio real — importante p/ o antifraude). O
  // checkout NÃO pede e-mail.
  await _persistClientDocument(order.client_id, extra.document);

  const creditCardBase = {
    operation_type: "auth_and_capture",
    installments,
    statement_descriptor: (order.company_name || "Loja").replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 13),
  };
  // "Itens" do pedido enviados à Pagar.me (produtos pedidos + taxas).
  const items = await _buildPagarmeItems(order, totalCents);
  const metadata = { order_id: String(order.id), company_id: String(order.company_id) };

  // Reutiliza o customer do usuário na Pagar.me quando já existe (todas as compras
  // sob o MESMO cadastro). Se ainda não houver, manda o customer inline e salva o
  // id que a Pagar.me retornar (após criar o pedido).
  const existingCustomerId = await _getUserPagarmeCustomerId(userId);
  const customerField = existingCustomerId
    ? { customer_id: existingCustomerId }
    : { customer: _buildCustomer(order, extra, billingAddress) };

  // Payload de cobrança avulsa (cartão novo pelo card_token) — padrão e também
  // fallback quando salvar o cartão não está disponível.
  const tokenChargePayload = () => ({
    code: String(order.id),
    ...customerField,
    items,
    payments: [{
      payment_method: "credit_card",
      credit_card: {
        ...creditCardBase,
        card_token: cardToken,
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
    let pendingSave = null; // { userId, card } — só é gravado se a cobrança for aprovada.
    if (cardId) {
      // Pagar com cartão SALVO — precisa do customer dono do card_id.
      await _assertOwnedCard(userId, cardId);
      const customerId = await _getUserPagarmeCustomerId(userId);
      if (!customerId) throw Object.assign(new Error("Cartão salvo inválido."), { status: 400 });
      orderPayload = {
        code: String(order.id),
        customer_id: customerId,
        items,
        payments: [{ payment_method: "credit_card", credit_card: { ...creditCardBase, card_id: cardId }, split }],
        metadata,
      };
    } else if (saveCard && userId && (await _savedCardsEnabled())) {
      // Cartão NOVO + salvar: cria customer + cartão no cofre (sem zero-auth) e
      // cobra pelo card_id. O registro em user_payment_tokens só é feito DEPOIS,
      // se a cobrança for aprovada (não guardamos cartão de cobrança recusada).
      const customerId = await _ensurePagarmeCustomer(userId, _buildCustomer(order, extra, billingAddress));
      const card = await _createVaultCard(customerId, cardToken, billingAddress);
      pendingSave = { userId, card };
      orderPayload = {
        code: String(order.id),
        customer_id: customerId,
        items,
        payments: [{ payment_method: "credit_card", credit_card: { ...creditCardBase, card_id: card.id }, split }],
        metadata,
      };
    } else {
      // Cartão NOVO avulso (padrão). Também cai aqui quando o cliente pediu para
      // salvar mas o recurso não está disponível (sem identidade/migração pendente)
      // — melhor concluir a compra do que falhar por causa do salvamento.
      orderPayload = tokenChargePayload();
    }

    const { data } = await http.post("/orders", orderPayload);

    // Reaproveita o customer nas próximas compras: se a Pagar.me criou um customer
    // novo (mandamos inline), guarda o id retornado no perfil global do usuário.
    if (!existingCustomerId && data.customer?.id) {
      await _saveUserPagarmeCustomerId(userId, data.customer.id);
    }

    const charge = (data.charges && data.charges[0]) || {};
    await _persistOrderCharge(order.id, data.id, charge.id);

    const status = charge.status || data.status;
    const paid = status === "paid";
    if (paid) {
      await _markOrderPaid(order.id, charge.id);
      // Só registra o cartão salvo quando a cobrança foi realmente aprovada.
      if (pendingSave) {
        try {
          await _persistSavedCard(pendingSave.userId, pendingSave.card);
        } catch (e) {
          console.error("pagarme: falha ao registrar o cartão salvo:", e.message);
        }
      }
    } else if (status === "failed") {
      await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [order.id]);
    }

    return {
      status,
      paid,
      order_id: order.id,
      pagarme_order_id: data.id,
      charge_id: charge.id,
      card_saved: !!(pendingSave && paid),
      // Em falha, o Pagar.me costuma pôr a razão em acquirer_message; quando é
      // rejeição de validação (ex.: "The item Code is required.") ela vem em
      // gateway_response.errors. Surfaceamos ambas para não retornar message:null.
      message:
        charge.last_transaction?.acquirer_message ||
        _formatErrors(charge.last_transaction?.gateway_response?.errors) ||
        null,
    };
  } catch (error) {
    throw _wrap(error, "Falha ao processar o pagamento com cartão");
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
  const customer = _buildCustomer(order, extra, _buildBillingAddress(order));
  if (!customer.document) {
    throw Object.assign(new Error("Informe o CPF do pagador para pagar com PIX."), { status: 400 });
  }
  // Persiste o CPF informado para pré-preencher nos próximos pedidos.
  await _persistClientDocument(order.client_id, customer.document);

  const userId = order.client_user_id;
  // Reutiliza o customer do usuário na Pagar.me quando já existe (mesmo cadastro
  // em todas as compras); senão manda inline e guarda o id retornado abaixo.
  const existingCustomerId = await _getUserPagarmeCustomerId(userId);
  const customerField = existingCustomerId ? { customer_id: existingCustomerId } : { customer };
  const items = await _buildPagarmeItems(order, totalCents);

  try {
    const http = getHttp();
    const { data } = await http.post("/orders", {
      code: String(order.id),
      ...customerField,
      items,
      payments: [
        {
          payment_method: "pix",
          pix: { expires_in: expiresIn },
          split,
        },
      ],
      metadata: { order_id: String(order.id), company_id: String(order.company_id) },
    });

    if (!existingCustomerId && data.customer?.id) {
      await _saveUserPagarmeCustomerId(userId, data.customer.id);
    }

    const charge = (data.charges && data.charges[0]) || {};
    const tx = charge.last_transaction || {};
    await _persistOrderCharge(order.id, data.id, charge.id);

    const status = charge.status || data.status;
    // PIX bem-sucedido nasce "pending"/"waiting_payment" COM QR Code. Se veio
    // "failed" ou sem QR, a Pagar.me recusou — logamos o motivo real e devolvemos
    // um erro claro (em vez de um "200" com QR nulo que trava o cliente).
    if (!tx.qr_code || status === "failed") {
      console.error(
        "Pagar.me PIX recusado:",
        JSON.stringify({
          order_id: order.id,
          charge_status: status,
          tx_status: tx.status,
          gateway_response: tx.gateway_response,
          acquirer_message: tx.acquirer_message,
        }),
      );
      await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [order.id]);
      const reason = tx.acquirer_message || tx.gateway_response?.errors?.[0]?.message;
      throw Object.assign(
        new Error(reason ? `PIX recusado: ${reason}` : "Não foi possível gerar o PIX. Revise os dados e tente novamente."),
        { status: 422 },
      );
    }

    return {
      status,
      order_id: order.id,
      pagarme_order_id: data.id,
      charge_id: charge.id,
      qr_code: tx.qr_code || null, // copia e cola
      qr_code_url: tx.qr_code_url || null, // imagem do QR
      expires_at: tx.expires_at || null,
    };
  } catch (error) {
    if (error.status === 422) throw error; // erro de recusa já formatado acima
    throw _wrap(error, "Falha ao gerar o PIX");
  }
};

// ─── Estorno / cancelamento de cobrança ────────────────────────────────────────

/**
 * Solicita o estorno (refund) de uma cobrança. Na Pagar.me v5, o cancelamento de
 * um charge PAGO (`DELETE /charges/{id}`) dispara o reembolso ao cliente (PIX ou
 * cartão); se ainda não foi capturado, apenas cancela. `amountCents` permite
 * estorno parcial (omitido = valor integral). Retorna o status resultante.
 */
const refundCharge = async (chargeId, amountCents) => {
  if (!chargeId) {
    throw Object.assign(new Error("charge id é obrigatório para o estorno."), { status: 400 });
  }
  try {
    const http = getHttp();
    const body = amountCents ? { amount: Math.round(amountCents) } : undefined;
    // axios envia corpo no DELETE via `data`.
    const { data } = await http.delete(`/charges/${chargeId}`, body ? { data: body } : undefined);
    return { status: data?.status || null };
  } catch (error) {
    throw _wrap(error, "Falha ao solicitar o estorno no Pagar.me");
  }
};

// ─── Webhook ─────────────────────────────────────────────────────────────────
// Segurança por HTTP Basic auth configurado no endpoint do dashboard Pagar.me.
// Comparação em tempo constante para evitar timing attack.

const verifyBasicAuth = (authorizationHeader) => {
  const user = process.env.PAGARME_WEBHOOK_USER;
  const pass = process.env.PAGARME_WEBHOOK_PASSWORD;
  // Se não configurado, não valida (recomendado configurar em produção).
  if (!user && !pass) return true;
  if (!authorizationHeader || !authorizationHeader.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(authorizationHeader.slice(6), "base64").toString("utf8");
  } catch (_) {
    return false;
  }
  const expected = `${user || ""}:${pass || ""}`;
  const crypto = require("crypto");
  const a = Buffer.from(decoded);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const _markOrderPaid = async (orderId, chargeId) => {
  // Marca como pago e, se o pedido estava em "Pagamento Pendente" (10), avança
  // para "Aguardando" (1) — a partir daí a loja passa a tratar o pedido.
  const r = await pool.query(
    `UPDATE orders
     SET payment_status = 'paid', payment_provider = 'pagarme',
         pagarme_charge_id = COALESCE($2, pagarme_charge_id),
         status = CASE WHEN status = '10' THEN '1' ELSE status END
     WHERE id = $1
     RETURNING status`,
    [orderId, chargeId || null],
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

// Extrai o id do nosso pedido do payload (order.code / metadata / charge.metadata).
const _orderIdFromPayload = (obj) => {
  if (!obj) return null;
  const fromCode = obj.code && /^\d+$/.test(String(obj.code)) ? Number(obj.code) : null;
  const fromMeta =
    obj.metadata?.order_id ||
    obj.order?.metadata?.order_id ||
    obj.order?.code ||
    null;
  const n = fromCode || (fromMeta && /^\d+$/.test(String(fromMeta)) ? Number(fromMeta) : null);
  return Number.isFinite(n) ? n : null;
};

const handleWebhookEvent = async (event) => {
  const type = event?.type;
  const data = event?.data || {};
  switch (type) {
    case "order.paid":
    case "charge.paid": {
      const orderId = _orderIdFromPayload(data);
      const chargeId = data.id?.startsWith?.("ch_") ? data.id : (data.charges && data.charges[0]?.id) || null;
      if (orderId) await _markOrderPaid(orderId, chargeId);
      break;
    }
    case "charge.payment_failed":
    case "order.payment_failed": {
      const orderId = _orderIdFromPayload(data);
      if (orderId) {
        await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [orderId]);
      }
      break;
    }
    case "recipient.updated":
    case "recipient.status_changed": {
      if (data.id && data.status) await _saveRecipientStatus(data.id, data.status);
      break;
    }
    default:
      // Eventos não tratados são ignorados de propósito.
      break;
  }
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
  if (["paid", "overpaid", "underpaid"].includes(s)) return "paid";
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
  getRecipientBalance,
  requestWithdrawal,
  getPaymentsSummary,
  createCardCharge,
  createPixCharge,
  refundCharge,
  listSavedCardsByPhone,
  deleteSavedCardByPhone,
  verifyBasicAuth,
  handleWebhookEvent,
};
