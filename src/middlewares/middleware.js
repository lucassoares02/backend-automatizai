const { verifyToken } = require('../../helpers/jwt');
const { logAccess } = require('../../services/logService');

const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifyToken(token);
        req.user = decoded;

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
