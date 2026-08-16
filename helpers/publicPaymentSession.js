const jwt = require("jsonwebtoken");

const AUDIENCE = "public-pagarme-payment";
const TOKEN_TTL = process.env.PAGARME_PAYMENT_SESSION_TTL || "2h";

const _secret = () => process.env.PAGARME_PAYMENT_SESSION_SECRET || process.env.JWT_SECRET;

const createPaymentSession = ({
  orderId,
  orderUuid,
  companyId,
  clientId,
  customerVerified = false,
}) => {
  const secret = _secret();
  if (!secret) {
    throw Object.assign(new Error("Sessão de pagamento indisponível."), { status: 503 });
  }
  return jwt.sign(
    {
      purpose: AUDIENCE,
      order_id: Number(orderId),
      order_uuid: String(orderUuid || ""),
      company_id: Number(companyId),
      client_id: Number(clientId),
      ...(customerVerified === true ? { customer_verified: true } : {}),
    },
    secret,
    { algorithm: "HS256", expiresIn: TOKEN_TTL },
  );
};

const verifyPaymentSession = (token) => {
  const secret = _secret();
  if (!secret || !token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    return payload?.purpose === AUDIENCE ? payload : null;
  } catch (_) {
    return null;
  }
};

const tokenFromRequest = (req) => {
  const auth = String(req.headers?.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return String(req.body?.payment_session_token || req.query?.payment_session_token || "").trim();
};

module.exports = { createPaymentSession, verifyPaymentSession, tokenFromRequest };
