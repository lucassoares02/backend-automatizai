const userService = require('../services/userService');
const { generateToken } = require('../helpers/jwt');

exports.signin = async (req, res, next) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
    }
    try {
        const user = await userService.validateLogin(email, password);
        const token = generateToken({ id: user.id, email: user.email, type: user.type });
        console.log('Login successful for user:', user.id);
        res.status(200).json({ message: 'Login successful', token, user });
    } catch (err) {
        console.error('Login error:', err);
        res.status(401).json({ error: err.message });
    }
};
