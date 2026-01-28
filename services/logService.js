const pool = require('../db');

const logAccess = async ({ userId, email, path, method }) => {
    try {
        await pool.query(
            'INSERT INTO logs (user_id, email, path, method) VALUES ($1, $2, $3, $4)',
            [userId, email, path, method]
        );
    } catch (err) {
        console.error('LogService error:', err.message);
    }
};

module.exports = { logAccess };
