const { verifyToken } = require("../../helpers/jwt");

const _customerFromRequest = (req) => {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const decoded = verifyToken(token);
  if (decoded.scope !== "customer" || decoded.aud !== "customer" || !decoded.id) {
    return null;
  }
  return decoded;
};

const customerAuth = (req, res, next) => {
  try {
    const customer = _customerFromRequest(req);
    if (!customer) {
      return res.status(401).json({ error: "Entre na sua conta para continuar." });
    }
    req.customer = customer;
    return next();
  } catch (_) {
    return res.status(401).json({ error: "Sua sessão expirou. Entre novamente." });
  }
};

const optionalCustomerAuth = (req, _res, next) => {
  try {
    req.customer = _customerFromRequest(req);
  } catch (_) {
    req.customer = null;
  }
  return next();
};

module.exports = { customerAuth, optionalCustomerAuth };
