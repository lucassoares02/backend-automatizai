// Rate limiter simples em memória (janela fixa), sem dependências externas.
// Suficiente para uma única instância; para múltiplas instâncias/produção em
// escala, migrar para um store compartilhado (Redis). Calibrado para ficar bem
// acima do uso legítimo — não afeta o volume normal de pedidos.

const buckets = new Map();

// Limpeza periódica dos buckets expirados para não vazar memória.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, 60 * 1000).unref?.();

const clientKey = (req) => {
  // Considera proxy reverso (X-Forwarded-For) quando presente.
  const fwd = req.headers["x-forwarded-for"];
  const ip = (fwd ? String(fwd).split(",")[0].trim() : null) || req.ip || req.socket?.remoteAddress || "unknown";
  return ip;
};

/**
 * @param {object} opts
 * @param {number} opts.windowMs   janela em ms
 * @param {number} opts.max        máximo de requisições por janela
 * @param {string} [opts.scope]    prefixo para isolar limites por grupo de rotas
 * @param {string} [opts.message]  mensagem de erro
 */
const rateLimit = ({ windowMs, max, scope = "global", message = "Muitas requisições, tente novamente em instantes." }) => {
  return (req, res, next) => {
    const key = `${scope}:${clientKey(req)}`;
    const now = Date.now();
    let entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return res.status(429).json({ error: message });
    }

    next();
  };
};

module.exports = rateLimit;
