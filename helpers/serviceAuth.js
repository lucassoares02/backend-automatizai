const crypto = require('crypto');

// Autenticação máquina→máquina (ex.: n8n) por API Key estática.
//
// A chave fica em `N8N_API_KEY` (.env) e é enviada pelo chamador no header
// `x-api-key`. É um principal de SERVIÇO confiável: passa pelas checagens de
// autorização multi-tenant sem restrição de empresa (escopo global). Por isso a
// chave deve ser longa/aleatória e tratada como segredo de backend.

// Identidade atribuída às requisições autenticadas por API Key.
const SERVICE_PRINCIPAL = Object.freeze({
  id: null,               // não é um usuário real (logs.user_id aceita NULL)
  email: 'n8n-service',
  role: 'service',
  service: true,
});

// Comparação de tempo constante: evita timing attacks. Hasheamos os dois lados
// para obter buffers de tamanho fixo (timingSafeEqual exige comprimentos iguais)
// sem vazar o tamanho da chave configurada.
const _safeEqual = (a, b) => {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
};

// Retorna true quando o header bate com a chave configurada. Se `N8N_API_KEY`
// não estiver definida, a autenticação por serviço fica desligada (fail-closed).
const isValidServiceKey = (headerValue) => {
  const expected = process.env.N8N_API_KEY;
  if (!expected || !headerValue) return false;
  return _safeEqual(headerValue, expected);
};

module.exports = { isValidServiceKey, SERVICE_PRINCIPAL };
