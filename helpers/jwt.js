const jwt = require('jsonwebtoken');

// Expiração padrão do token. Tokens antigos emitidos sem `exp` continuam válidos
// (o verify só rejeita se houver claim `exp` vencido), então a mudança não quebra
// sessões existentes — apenas passa a expirar os novos.
const TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const generateToken = (payload, { expiresIn = TOKEN_EXPIRES_IN } = {}) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  });
};

const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
};

module.exports = { generateToken, verifyToken };
