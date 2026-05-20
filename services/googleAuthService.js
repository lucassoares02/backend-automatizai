const axios = require('axios');
const pool = require('../db');
const { hashPassword } = require('../helpers/hash');
const crypto = require('crypto');

/**
 * Calls Google's userinfo endpoint to verify the accessToken and return
 * the user's profile. Throws if the token is invalid or expired.
 */
const verifyAccessToken = async (accessToken) => {
  const res = await axios.get('https://www.googleapis.com/oauth2/v1/userinfo', {
    params: { access_token: accessToken },
  });
  const data = res.data;
  if (!data.email) {
    throw new Error('Token Google não contém email');
  }
  return data; // { id, email, name, picture, verified_email }
};

/**
 * Finds a user by email, or creates one if not found.
 * Google users get a random hashed password since they never sign in with a password.
 * Returns the user row (without password).
 */
const findOrCreateUser = async ({ email, name, picture }) => {
  const existing = await pool.query(
    'SELECT id, name, email, active FROM users WHERE email = $1 LIMIT 1',
    [email],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const randomPassword = await hashPassword(crypto.randomUUID());
  const created = await pool.query(
    'INSERT INTO users (name, email, password, active) VALUES ($1, $2, $3, $4) RETURNING id, name, email, active',
    [name, email, randomPassword, true],
  );

  return created.rows[0];
};

module.exports = { verifyAccessToken, findOrCreateUser };
