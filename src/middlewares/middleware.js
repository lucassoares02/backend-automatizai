const { verifyToken } = require('../../helpers/jwt');
const { logAccess } = require('../../services/logService');
const { getUserCompanyIds } = require('./authorize');

const authMiddleware = async (req, res, next) => {
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
