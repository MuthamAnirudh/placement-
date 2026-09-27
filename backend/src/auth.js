// Auth utilities shared by routes/auth.js and the auth middleware.
//
// Token model:
//   - Access token: short-lived JWT (default 15m), sent as `Authorization: Bearer <jwt>`,
//     carries { sub, email, role }. Never stored server-side — verified by signature alone.
//   - Refresh token: long-lived opaque random string (default 30d). The client stores it
//     (frontend keeps it in localStorage next to its existing AI-provider settings) and
//     exchanges it at POST /api/auth/refresh for a new access token. Only its SHA-256 hash
//     is stored in the DB (RefreshToken table), so a DB leak alone can't be used to log in
//     as anyone. Rotated on every use (old one is revoked, replaced by a new one) so a
//     stolen-but-unused refresh token becomes useless the moment the real owner uses theirs.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = config.accessSecret;
const REFRESH_SECRET = config.refreshSecret;
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '15m';
const REFRESH_EXPIRES_DAYS = Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 30);
const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, name: user.name }, ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRES,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET); // throws on invalid/expired
}

// Opaque refresh tokens (not JWTs) — a random 256-bit string. We only ever need to look
// them up by hash, never decode claims out of them, so there's no reason for them to be
// self-describing JWTs (and it keeps the DB the sole source of truth for revocation).
function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token + REFRESH_SECRET).digest('hex');
}

function refreshExpiryDate() {
  return new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
  REFRESH_EXPIRES_DAYS,
};
