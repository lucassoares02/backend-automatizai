const axios = require("axios");
const pool = require("../db");

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

// ─── Helpers ────────────────────────────────────────────────────────────────────

// "active" é o único status em que o recebedor pode transacionar.
const _isActiveStatus = (status) => String(status || "").toLowerCase() === "active";

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

// Monta o objeto customer do pedido a partir do cliente + dados informados no
// checkout embutido (CPF é opcional; e-mail é sintetizado quando ausente).
const _buildCustomer = (client, extra = {}) => {
  const doc = _onlyDigits(extra.document);
  const phone = _parsePhone(extra.phone || client.client_phone || client.phone);
  const emailSafe =
    extra.email ||
    `cliente${client.client_id || client.id || ""}@sem-email.automatizai`;
  const customer = {
    name: (extra.name || client.client_name || client.name || "Cliente").slice(0, 64),
    email: emailSafe,
    type: doc.length > 11 ? "company" : "individual",
  };
  if (doc.length === 11 || doc.length === 14) customer.document = doc;
  if (phone) customer.phones = { mobile_phone: phone };
  return customer;
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
    if (company.pagarme_recipient_id) {
      // Atualiza os dados de cadastro e a conta bancária do recebedor existente.
      const http2 = getHttp();
      await http2.put(`/recipients/${company.pagarme_recipient_id}`, {
        register_information: registerInformation,
      });
      await http2.patch(`/recipients/${company.pagarme_recipient_id}/default-bank-account`, {
        bank_account: defaultBankAccount,
      });
      const r = await http2.get(`/recipients/${company.pagarme_recipient_id}`);
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
    };
  } catch (error) {
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
  try {
    const http = getHttp();
    const r = await http.post(`/recipients/${company.pagarme_recipient_id}/kyc_link`, {});
    return {
      url: r.data?.url || null,
      base64_qrcode: r.data?.base64_qrcode || null,
      expires_at: r.data?.expires_at || null,
    };
  } catch (error) {
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

// ─── Cobrança do cliente (order + split) ────────────────────────────────────────

// Carrega o pedido + empresa + cliente e valida que o recebedor está ativo.
const _loadOrderForCharge = async (orderId) => {
  const orderRes = await pool.query(
    `SELECT o.id, o.uuid, o.total, o.tag, o.company_id, o.client_id, o.payment_status, o.service_fee,
            c.name AS company_name, c.pagarme_recipient_id, c.pagarme_charges_enabled,
            cl.name AS client_name, cl.phone AS client_phone
     FROM orders o
     JOIN companies c ON c.id = o.company_id
     JOIN clients cl ON cl.id = o.client_id
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

const _persistOrderCharge = async (orderId, pmOrderId, chargeId) => {
  await pool.query(
    `UPDATE orders
     SET payment_provider = 'pagarme', pagarme_order_id = $2, pagarme_charge_id = $3
     WHERE id = $1`,
    [orderId, pmOrderId || null, chargeId || null],
  );
};

/**
 * Cria um pedido com pagamento no CARTÃO usando o card_token gerado no cliente
 * (pagarme.js). Como o cartão é síncrono, devolve o status final da cobrança.
 * `extra` carrega dados do checkout embutido: { document, email, name, phone, installments }.
 */
const createCardCharge = async (orderId, cardToken, extra = {}) => {
  if (!cardToken) throw Object.assign(new Error("card_token é obrigatório."), { status: 400 });
  const order = await _loadOrderForCharge(orderId);
  const { totalCents, split } = _computeSplit(order);
  const orderRef = order.tag || `#${order.id}`;
  const installments = Math.min(12, Math.max(1, Number(extra.installments) || 1));

  try {
    const http = getHttp();
    const { data } = await http.post("/orders", {
      code: String(order.id),
      customer: _buildCustomer(order, extra),
      items: [{ amount: totalCents, description: `Pedido ${orderRef}`.slice(0, 64), quantity: 1 }],
      payments: [
        {
          payment_method: "credit_card",
          credit_card: {
            operation_type: "auth_and_capture",
            installments,
            statement_descriptor: (order.company_name || "Loja").replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 13),
            card_token: cardToken,
          },
          split,
        },
      ],
      metadata: { order_id: String(order.id), company_id: String(order.company_id) },
    });

    const charge = (data.charges && data.charges[0]) || {};
    await _persistOrderCharge(order.id, data.id, charge.id);

    const status = charge.status || data.status;
    const paid = status === "paid";
    if (paid) await _markOrderPaid(order.id, charge.id);
    else if (status === "failed") {
      await pool.query("UPDATE orders SET payment_status = 'failed' WHERE id = $1", [order.id]);
    }

    return {
      status,
      paid,
      order_id: order.id,
      pagarme_order_id: data.id,
      charge_id: charge.id,
      message: charge.last_transaction?.acquirer_message || null,
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
  const orderRef = order.tag || `#${order.id}`;
  const expiresIn = Number(process.env.PAGARME_PIX_EXPIRES_IN || 3600);

  try {
    const http = getHttp();
    const { data } = await http.post("/orders", {
      code: String(order.id),
      customer: _buildCustomer(order, extra),
      items: [{ amount: totalCents, description: `Pedido ${orderRef}`.slice(0, 64), quantity: 1 }],
      payments: [
        {
          payment_method: "pix",
          pix: { expires_in: expiresIn },
          split,
        },
      ],
      metadata: { order_id: String(order.id), company_id: String(order.company_id) },
    });

    const charge = (data.charges && data.charges[0]) || {};
    const tx = charge.last_transaction || {};
    await _persistOrderCharge(order.id, data.id, charge.id);

    return {
      status: charge.status || data.status,
      order_id: order.id,
      pagarme_order_id: data.id,
      charge_id: charge.id,
      qr_code: tx.qr_code || null, // copia e cola
      qr_code_url: tx.qr_code_url || null, // imagem do QR
      expires_at: tx.expires_at || null,
    };
  } catch (error) {
    throw _wrap(error, "Falha ao gerar o PIX");
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

module.exports = {
  createOrUpdateRecipient,
  createKycLink,
  refreshRecipientStatus,
  getRecipientDetails,
  createCardCharge,
  createPixCharge,
  verifyBasicAuth,
  handleWebhookEvent,
};
