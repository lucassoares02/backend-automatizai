const service = require("../services/customerAccountService");

const _respondError = (res, error, context) => {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error(`[${context}]`, error);
  return res.status(status).json({
    error: error?.message || "Não foi possível concluir a solicitação.",
  });
};

const googleSignIn = async (req, res) => {
  try {
    const data = await service.googleSignIn({
      accessToken: req.body?.access_token,
      orderUuid: req.body?.order_uuid,
    });
    return res.status(200).json(data);
  } catch (error) {
    return _respondError(res, error, "customer-google-signin");
  }
};

const startRegistration = async (req, res) => {
  try {
    const data = await service.startEmailRegistration({
      name: req.body?.name,
      email: req.body?.email,
      orderUuid: req.body?.order_uuid,
    });
    return res.status(200).json(data);
  } catch (error) {
    return _respondError(res, error, "customer-register-start");
  }
};

const verifyRegistration = async (req, res) => {
  try {
    const data = await service.verifyEmailRegistration({
      challengeToken: req.body?.challenge_token,
      code: req.body?.code,
      password: req.body?.password,
    });
    return res.status(201).json(data);
  } catch (error) {
    return _respondError(res, error, "customer-register-verify");
  }
};

const emailSignIn = async (req, res) => {
  try {
    const data = await service.emailSignIn(req.body || {});
    return res.status(200).json(data);
  } catch (error) {
    return _respondError(res, error, "customer-email-signin");
  }
};

const me = async (req, res) => {
  try {
    return res.status(200).json(await service.getProfile(req.customer.id));
  } catch (error) {
    return _respondError(res, error, "customer-me");
  }
};

const orders = async (req, res) => {
  try {
    return res.status(200).json(await service.listOrders(req.customer.id));
  } catch (error) {
    return _respondError(res, error, "customer-orders");
  }
};

const paymentMethods = async (req, res) => {
  try {
    return res.status(200).json(await service.listPaymentMethods(req.customer.id));
  } catch (error) {
    return _respondError(res, error, "customer-payment-methods");
  }
};

const deletePaymentMethod = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Cartão inválido." });
  try {
    return res.status(200).json(await service.deletePaymentMethod(req.customer.id, id));
  } catch (error) {
    return _respondError(res, error, "customer-delete-payment-method");
  }
};

const setDefaultPaymentMethod = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Cartão inválido." });
  try {
    return res.status(200).json(await service.setDefaultPaymentMethod(req.customer.id, id));
  } catch (error) {
    return _respondError(res, error, "customer-default-payment-method");
  }
};

module.exports = {
  googleSignIn,
  startRegistration,
  verifyRegistration,
  emailSignIn,
  me,
  orders,
  paymentMethods,
  deletePaymentMethod,
  setDefaultPaymentMethod,
};
