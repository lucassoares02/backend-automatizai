const service = require("../services/subscriptionsService");
const subscriptionBookingService = require("../services/subscriptionBookingService");
const { resolveCompanyId } = require("../src/middlewares/authorize");
const { canManageSubscriptions } = require("../helpers/subscriptionItem");

const _managementAccess = (req, res) => {
  if (canManageSubscriptions(req)) return true;
  res.status(403).json({ error: "Gestão de assinaturas disponível apenas para administradores do sistema." });
  return false;
};

const _respondError = (res, error, context) => {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error(`[${context}]`, error);
  return res.status(status).json({
    error: error?.message || "Não foi possível concluir a solicitação.",
  });
};

// ─── Cliente (conta autenticada e verificada) ─────────────────────────────────

const listMine = async (req, res) => {
  try {
    return res.status(200).json(await service.listForUserWithContext(req.customer.id));
  } catch (error) {
    return _respondError(res, error, "subscriptions-list-mine");
  }
};

const getMine = async (req, res) => {
  try {
    return res.status(200).json(await service.getForUser(req.customer.id, req.params.id));
  } catch (error) {
    return _respondError(res, error, "subscriptions-get-mine");
  }
};

/**
 * Body: { menu_item_id, client_request_id, options?, payment_method_id? |
 *         card_token + document? + email? + billing_address? }
 */
const subscribe = async (req, res) => {
  const body = req.body || {};
  try {
    const result = await service.subscribe(req.customer.id, {
      menuItemId: body.menu_item_id,
      clientRequestId: body.client_request_id,
      options: Array.isArray(body.options) ? body.options : [],
      paymentMethodId: body.payment_method_id,
      cardToken: body.card_token,
      document: body.document,
      email: body.email,
      billingAddress: body.billing_address,
    });
    return res.status(201).json(result);
  } catch (error) {
    return _respondError(res, error, "subscriptions-subscribe");
  }
};

const changeCard = async (req, res) => {
  const body = req.body || {};
  try {
    const result = await service.changeCard(req.customer.id, req.params.id, {
      paymentMethodId: body.payment_method_id,
      cardToken: body.card_token,
      document: body.document,
      email: body.email,
      billingAddress: body.billing_address,
    });
    return res.status(200).json(result);
  } catch (error) {
    return _respondError(res, error, "subscriptions-change-card");
  }
};

const cancelMine = async (req, res) => {
  try {
    return res.status(200).json(await service.cancelByCustomer(req.customer.id, req.params.id, { reason: req.body?.reason }));
  } catch (error) {
    return _respondError(res, error, "subscriptions-cancel-mine");
  }
};

/** Prévia do agendamento pela assinatura: uso no ciclo da data escolhida. */
const bookingPreview = async (req, res) => {
  try {
    return res.status(200).json(
      await subscriptionBookingService.previewForUser(req.customer.id, req.params.id, req.query?.starts_at),
    );
  } catch (error) {
    return _respondError(res, error, "subscriptions-booking-preview");
  }
};

// ─── Comerciante (multi-tenant) ───────────────────────────────────────────────

const listForCompany = async (req, res) => {
  if (!_managementAccess(req, res)) return;
  try {
    return res.status(200).json(await service.listForCompany(resolveCompanyId(req), { status: req.query?.status }));
  } catch (error) {
    return _respondError(res, error, "subscriptions-list-company");
  }
};

const getForCompany = async (req, res) => {
  if (!_managementAccess(req, res)) return;
  try {
    return res.status(200).json(await service.getForCompany(resolveCompanyId(req), req.params.id));
  } catch (error) {
    return _respondError(res, error, "subscriptions-get-company");
  }
};

const cancelForCompany = async (req, res) => {
  if (!_managementAccess(req, res)) return;
  try {
    return res.status(200).json(await service.cancelByMerchant(resolveCompanyId(req), req.params.id, { reason: req.body?.reason }));
  } catch (error) {
    return _respondError(res, error, "subscriptions-cancel-company");
  }
};

module.exports = {
  listMine,
  getMine,
  subscribe,
  changeCard,
  cancelMine,
  bookingPreview,
  listForCompany,
  getForCompany,
  cancelForCompany,
};
