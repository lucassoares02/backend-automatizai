const userService = require('../services/userService');
const { generateToken } = require('../helpers/jwt');

exports.signin = async (req, res, next) => {
    console.log('Request Login');
    const { email, password } = req.body;
    try {
        console.log('Email: ', email);
        console.log('Password: ', password);
        const user = await userService.validateLogin(email, password);
        const token = generateToken({ id: user.id, email: user.email, type: user.type });
        console.log('Login successful for user:', user.id);
        res.status(200).json({ message: 'Login successful', token, user });
    } catch (err) {
        console.error('Login error:', err);
        res.status(401).json({ error: err.message });
    }
};
