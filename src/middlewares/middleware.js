const { verifyToken } = require('../../helpers/jwt');
const { logAccess } = require('../../services/logService');
const { getUserCompanyIds } = require('./authorize');
const { isValidServiceKey, SERVICE_PRINCIPAL } = require('../../helpers/serviceAuth');

const authMiddleware = async (req, res, next) => {
    // Autenticação de serviço (n8n): API Key via header `x-api-key`. Quando
    // presente, dispensa o JWT. Principal de serviço confiável = escopo global,
    // então não carregamos `userCompanies` (o authorize libera por `isService`).
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== undefined) {
        if (!isValidServiceKey(apiKey)) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        req.user = { ...SERVICE_PRINCIPAL };
        req.isService = true;
        req.userCompanies = [];

        logAccess({
            userId: SERVICE_PRINCIPAL.id,
            email: SERVICE_PRINCIPAL.email,
            path: req.path,
            method: req.method,
        });

        return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifyToken(token);
        req.user = decoded;

        // Carrega as empresas vinculadas ao usuário para autorização multi-tenant.
        // Falha de leitura não bloqueia a autenticação, mas deixa a lista vazia
        // (os middlewares de autorização então negam por padrão — fail-closed).
        try {
            req.userCompanies = await getUserCompanyIds(decoded.id);
        } catch (e) {
            console.error('Failed to load user companies:', e.message);
            req.userCompanies = [];
        }

        logAccess({
            userId: decoded.id,
            email: decoded.email,
            path: req.path,
            method: req.method,
        });

        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

module.exports = authMiddleware;
