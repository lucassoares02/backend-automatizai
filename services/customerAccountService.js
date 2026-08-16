const crypto = require("crypto");
const pool = require("../db");
const { hashPassword, comparePassword } = require("../helpers/hash");
const { generateToken, verifyToken } = require("../helpers/jwt");
const { columnExists, tableExists } = require("../helpers/schema");
const { verifyAccessToken } = require("./googleAuthService");
const { sendEmailSmtp } = require("./mailerService");
const publicService = require("./publicService");
const pagarmeService = require("./pagarmeService");

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const _ORDER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeEmail = (raw) => {
  const value = String(raw || "").trim().toLowerCase();
  return _EMAIL_RE.test(value) ? value : null;
};

const _httpError = (message, status = 400) =>
  Object.assign(new Error(message), { status });

const _assertIdentityReady = async () => {
  if (!(await tableExists("platform_users")) || !(await tableExists("user_identifiers"))) {
    throw _httpError("As contas de cliente ainda não foram ativadas neste ambiente.", 503);
  }
};

const _assertPasswordReady = async () => {
  await _assertIdentityReady();
  if (!(await tableExists("platform_user_credentials"))) {
    throw _httpError(
      "O acesso por e-mail e senha depende da atualização de segurança pendente. Use o Google por enquanto.",
      503,
    );
  }
};

const _claimUserFromOrder = async (db, orderUuid) => {
  const ref = String(orderUuid || "").trim();
  if (!_ORDER_UUID_RE.test(ref)) return null;
  const result = await db.query(
    `SELECT c.user_id
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.uuid = $1 AND c.user_id IS NOT NULL
     LIMIT 1`,
    [ref],
  );
  return result.rows[0]?.user_id || null;
};

const _findIdentifier = async (db, type, value) => {
  const result = await db.query(
    `SELECT id, user_id, verified_at
     FROM user_identifiers
     WHERE type = $1 AND value_norm = $2 AND revoked_at IS NULL
     LIMIT 1`,
    [type, value],
  );
  return result.rows[0] || null;
};

const _ensureIdentifier = async (db, { userId, type, value, verified = false }) => {
  const current = await _findIdentifier(db, type, value);
  if (current && current.user_id !== userId) {
    throw _httpError("Este acesso já está associado a outra conta.", 409);
  }
  if (current) {
    await db.query(
      `UPDATE user_identifiers
       SET last_seen_at = now(), verified_at = CASE WHEN $2 THEN COALESCE(verified_at, now()) ELSE verified_at END
       WHERE id = $1`,
      [current.id, verified],
    );
    return;
  }
  await db.query(
    `INSERT INTO user_identifiers (user_id, type, value_norm, verified_at, last_seen_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END, now())`,
    [userId, type, value, verified],
  );
};

const _updateLoginProfile = async (db, userId, { name, avatarUrl } = {}) => {
  const avatarAvailable = await columnExists("platform_users", "avatar_url");
  const lastLoginAvailable = await columnExists("platform_users", "last_login_at");
  const values = [userId, String(name || "").trim().slice(0, 255) || null];
  const assignments = ["name = COALESCE($2, name)", "updated_at = now()"];
  if (avatarAvailable) {
    values.push(String(avatarUrl || "").trim().slice(0, 2000) || null);
    assignments.push(`avatar_url = COALESCE($${values.length}, avatar_url)`);
  }
  if (lastLoginAvailable) assignments.push("last_login_at = now()");
  await db.query(
    `UPDATE platform_users SET ${assignments.join(", ")}
     WHERE id = $1 AND status = 'active'`,
    values,
  );
};

const _session = (userId, email) => generateToken({
  id: userId,
  email,
  scope: "customer",
  aud: "customer",
});

const getProfile = async (userId) => {
  await _assertIdentityReady();
  const hasAvatar = await columnExists("platform_users", "avatar_url");
  const hasLastLogin = await columnExists("platform_users", "last_login_at");
  const hasCards = await tableExists("user_payment_tokens");
  const result = await pool.query(
    `SELECT pu.id, pu.name, pu.status, pu.created_at,
            ${hasAvatar ? "pu.avatar_url" : "NULL::text AS avatar_url"},
            ${hasLastLogin ? "pu.last_login_at" : "NULL::timestamptz AS last_login_at"},
            (SELECT value_norm FROM user_identifiers
             WHERE user_id = pu.id AND type = 'email' AND revoked_at IS NULL
             ORDER BY verified_at DESC NULLS LAST, id DESC LIMIT 1) AS email,
            (SELECT value_norm FROM user_identifiers
             WHERE user_id = pu.id AND type = 'phone' AND revoked_at IS NULL
             ORDER BY verified_at DESC NULLS LAST, id DESC LIMIT 1) AS phone,
            (SELECT COUNT(*)::int FROM orders o JOIN clients c ON c.id = o.client_id
             WHERE c.user_id = pu.id AND c.deactivated_at IS NULL) AS orders_count,
            (SELECT COUNT(*)::int FROM user_addresses ua
             WHERE ua.user_id = pu.id AND ua.deleted_at IS NULL) AS addresses_count,
            ${hasCards
              ? `(SELECT COUNT(*)::int FROM user_payment_tokens upt
                  WHERE upt.user_id = pu.id AND upt.revoked_at IS NULL) AS payment_methods_count`
              : "0::int AS payment_methods_count"}
     FROM platform_users pu
     WHERE pu.id = $1 AND pu.status = 'active'
     LIMIT 1`,
    [userId],
  );
  if (!result.rows[0]) throw _httpError("Conta não encontrada.", 404);
  return {
    ...result.rows[0],
    email_password_available: await tableExists("platform_user_credentials"),
  };
};

const googleSignIn = async ({ accessToken, orderUuid }) => {
  await _assertIdentityReady();
  if (!accessToken) throw _httpError("accessToken é obrigatório.");
  let google;
  try {
    google = await verifyAccessToken(accessToken);
  } catch (error) {
    throw _httpError("Seu acesso do Google expirou. Tente novamente.", 401);
  }
  const email = normalizeEmail(google.email);
  const googleId = String(google.id || "").trim();
  if (!email || !googleId || google.verified_email === false) {
    throw _httpError("O Google não confirmou um e-mail válido para esta conta.", 400);
  }

  const db = await pool.connect();
  let userId;
  try {
    await db.query("BEGIN");
    const [byGoogle, byEmail, claimedUserId] = await Promise.all([
      _findIdentifier(db, "google", googleId),
      _findIdentifier(db, "email", email),
      _claimUserFromOrder(db, orderUuid),
    ]);
    if (byGoogle && byEmail && byGoogle.user_id !== byEmail.user_id) {
      throw _httpError("Encontramos cadastros diferentes para este Google e e-mail. Fale com o suporte para unificá-los.", 409);
    }
    userId = byGoogle?.user_id || byEmail?.user_id || claimedUserId;
    if (!userId) {
      const created = await db.query(
        "INSERT INTO platform_users (name) VALUES ($1) RETURNING id",
        [String(google.name || email.split("@")[0]).slice(0, 255)],
      );
      userId = created.rows[0].id;
    }
    const active = await db.query(
      "SELECT status FROM platform_users WHERE id = $1 LIMIT 1",
      [userId],
    );
    if (active.rows[0]?.status !== "active") {
      throw _httpError("Esta conta está indisponível. Fale com o suporte.", 403);
    }
    await _ensureIdentifier(db, { userId, type: "email", value: email, verified: true });
    await _ensureIdentifier(db, { userId, type: "google", value: googleId, verified: true });
    await _updateLoginProfile(db, userId, { name: google.name, avatarUrl: google.picture });
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  const user = await getProfile(userId);
  // Mantém a foto disponível já no primeiro acesso mesmo antes da coluna
  // opcional ser aplicada manualmente. Depois da atualização, ela persiste.
  if (!user.avatar_url && google.picture) user.avatar_url = google.picture;
  return { token: _session(userId, email), user };
};

const _challengeHash = ({ email, code, nonce }) => crypto
  .createHash("sha256")
  .update(`${process.env.JWT_SECRET}|${email}|${code}|${nonce}`)
  .digest("hex");

const _escapeHtml = (value) => String(value || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const startEmailRegistration = async ({ name, email: rawEmail, orderUuid }) => {
  await _assertPasswordReady();
  const email = normalizeEmail(rawEmail);
  const cleanName = String(name || "").trim();
  if (!cleanName || !email) throw _httpError("Informe nome e e-mail válidos.");
  if (!process.env.MAIL_HOST || !process.env.MAIL_USER || !process.env.MAIL_PASS) {
    throw _httpError("A confirmação por e-mail está indisponível no momento. Use o Google para entrar.", 503);
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const nonce = crypto.randomUUID();
  const challengeToken = generateToken({
    scope: "customer_email_verification",
    aud: "customer",
    email,
    name: cleanName.slice(0, 255),
    order_uuid: _ORDER_UUID_RE.test(String(orderUuid || "")) ? orderUuid : null,
    nonce,
    code_hash: _challengeHash({ email, code, nonce }),
  }, { expiresIn: "10m" });

  const firstName = _escapeHtml(cleanName.split(/\s+/)[0]);
  const subject = `${code} é seu código de confirmação Arbian`;
  const text = `Olá, ${firstName}. Seu código de confirmação é ${code}. Ele expira em 10 minutos.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#202124">
    <h2 style="margin-bottom:8px">Confirme sua conta Arbian</h2>
    <p>Olá, ${firstName}. Use o código abaixo para proteger o acesso aos seus pedidos.</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:20px 0">${code}</div>
    <p style="color:#667085">O código expira em 10 minutos. Se você não solicitou, ignore este e-mail.</p>
  </div>`;
  try {
    await sendEmailSmtp(
      `"Arbian" <${process.env.MAIL_FROM || process.env.MAIL_USER}>`,
      email,
      subject,
      text,
      html,
    );
  } catch (_) {
    throw _httpError(
      "Não conseguimos enviar o código agora. Tente novamente ou entre com o Google.",
      503,
    );
  }
  return { challenge_token: challengeToken, expires_in_seconds: 600, email };
};

const verifyEmailRegistration = async ({ challengeToken, code, password }) => {
  await _assertPasswordReady();
  if (String(password || "").length < 8) {
    throw _httpError("Crie uma senha com pelo menos 8 caracteres.");
  }
  let challenge;
  try {
    challenge = verifyToken(challengeToken);
  } catch (_) {
    throw _httpError("O código expirou. Solicite um novo.", 401);
  }
  if (challenge.scope !== "customer_email_verification" || challenge.aud !== "customer") {
    throw _httpError("Confirmação inválida.", 401);
  }
  const expected = Buffer.from(String(challenge.code_hash || ""), "hex");
  const received = Buffer.from(_challengeHash({
    email: challenge.email,
    code: String(code || "").trim(),
    nonce: challenge.nonce,
  }), "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw _httpError("Código incorreto. Confira o e-mail e tente novamente.", 400);
  }

  const passwordHash = await hashPassword(String(password));
  const db = await pool.connect();
  let userId;
  try {
    await db.query("BEGIN");
    const byEmail = await _findIdentifier(db, "email", challenge.email);
    const claimedUserId = await _claimUserFromOrder(db, challenge.order_uuid);
    if (byEmail && claimedUserId && byEmail.user_id !== claimedUserId) {
      throw _httpError("Este e-mail já está ligado a outra conta. Entre com ele ou use o Google.", 409);
    }
    userId = byEmail?.user_id || claimedUserId;
    if (!userId) {
      const created = await db.query(
        "INSERT INTO platform_users (name) VALUES ($1) RETURNING id",
        [challenge.name],
      );
      userId = created.rows[0].id;
    }
    const credential = await db.query(
      "SELECT 1 FROM platform_user_credentials WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    if (credential.rows[0]) {
      throw _httpError("Esta conta já existe. Faça login para continuar.", 409);
    }
    await _ensureIdentifier(db, {
      userId,
      type: "email",
      value: challenge.email,
      verified: true,
    });
    await db.query(
      `INSERT INTO platform_user_credentials (user_id, password_hash, password_updated_at)
       VALUES ($1, $2, now())`,
      [userId, passwordHash],
    );
    await _updateLoginProfile(db, userId, { name: challenge.name });
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  return { token: _session(userId, challenge.email), user: await getProfile(userId) };
};

const emailSignIn = async ({ email: rawEmail, password }) => {
  await _assertPasswordReady();
  const email = normalizeEmail(rawEmail);
  if (!email || !password) throw _httpError("Informe e-mail e senha.");
  const result = await pool.query(
    `SELECT pu.id, pu.status, puc.password_hash
     FROM user_identifiers ui
     JOIN platform_users pu ON pu.id = ui.user_id
     JOIN platform_user_credentials puc ON puc.user_id = pu.id
     WHERE ui.type = 'email' AND ui.value_norm = $1 AND ui.revoked_at IS NULL
     LIMIT 1`,
    [email],
  );
  const account = result.rows[0];
  if (!account || !(await comparePassword(String(password), account.password_hash))) {
    throw _httpError("E-mail ou senha incorretos.", 401);
  }
  if (account.status !== "active") throw _httpError("Esta conta está indisponível.", 403);
  const db = await pool.connect();
  try {
    await _updateLoginProfile(db, account.id);
    await db.query(
      `UPDATE user_identifiers SET last_seen_at = now()
       WHERE user_id = $1 AND type = 'email' AND value_norm = $2 AND revoked_at IS NULL`,
      [account.id, email],
    );
  } finally {
    db.release();
  }
  return { token: _session(account.id, email), user: await getProfile(account.id) };
};

const listOrders = async (userId) => publicService.findPublicOrdersByUserId(userId);

const listPaymentMethods = async (userId) => ({
  cards: await pagarmeService.listSavedCardsForUser(userId),
  saving_available: pagarmeService.savedCardsAvailable(),
});

const deletePaymentMethod = async (userId, id) =>
  pagarmeService.deleteSavedCardForUser(userId, id);

const setDefaultPaymentMethod = async (userId, id) =>
  pagarmeService.setDefaultSavedCardForUser(userId, id);

module.exports = {
  normalizeEmail,
  googleSignIn,
  startEmailRegistration,
  verifyEmailRegistration,
  emailSignIn,
  getProfile,
  listOrders,
  listPaymentMethods,
  deletePaymentMethod,
  setDefaultPaymentMethod,
};
