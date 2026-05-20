const { verifyAccessToken, findOrCreateUser } = require('../services/googleAuthService');
const { generateToken } = require('../helpers/jwt');

/**
 * POST /auth/google
 * Body: { accessToken: string }
 * Returns: { token, user } — same shape as the regular login endpoint.
 */
exports.googleSignIn = async (req, res) => {
  const { accessToken } = req.body;

  if (!accessToken) {
    return res.status(400).json({ error: 'accessToken é obrigatório' });
  }

  try {
    const payload = await verifyAccessToken(accessToken);

    const { email, name, picture } = payload;

    const user = await findOrCreateUser({ email, name: name ?? email.split('@')[0], picture });

    if (!user.active) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });
    }

    const token = generateToken({ id: user.id, email: user.email, type: user.type ?? 0 });

    return res.status(200).json({
      message: 'Login realizado com sucesso',
      token,
      user,
    });
  } catch (err) {
    console.error('[googleSignIn] erro:', err.message);

    if (err.response?.status === 401 || err.message?.includes('invalid_token')) {
      return res.status(401).json({ error: 'Token Google expirado ou inválido. Tente novamente.' });
    }

    return res.status(500).json({ error: 'Falha na autenticação com o Google' });
  }
};
