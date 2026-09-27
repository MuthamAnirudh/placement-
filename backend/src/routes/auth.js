const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const {
  hashPassword,
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
} = require('../auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const cookieBase = () => ({ httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:process.env.COOKIE_SAMESITE || 'lax', path:'/' });
const accessCookieMaxAge = () => { const m = String(process.env.JWT_ACCESS_EXPIRES || '15m').match(/^(\d+)([smhd])$/i); if (!m) return 15*60*1000; const n=Number(m[1]); return n*({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]); };


// Auth endpoints get their own (tighter) rate limit, separate from /api/ai — this is what
// actually matters for brute-force protection, not the AI-proxy limiter.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_PER_15MIN || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait a few minutes and try again.' },
});
router.use(authLimiter);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, branch: u.branch, graduationYear: u.graduationYear };
}

async function issueSession(user, req, res) {
  const accessToken = signAccessToken(user);
  const refreshToken = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: refreshExpiryDate(),
      userAgent: req.headers['user-agent'] || null,
      ip: req.ip,
    },
  });
  res.cookie('cp_refresh', refreshToken, { ...cookieBase(), path:'/api/auth', maxAge:Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 30)*24*60*60*1000 });
  res.cookie('cp_access', accessToken, { ...cookieBase(), maxAge: accessCookieMaxAge() });
  res.json({ accessToken, user: publicUser(user) });
}

// --- POST /api/auth/register --------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, branch, graduationYear } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        name: name.trim(),
        branch: branch || null,
        graduationYear: graduationYear ? Number(graduationYear) : null,
      },
    });
    await issueSession(user, req, res);
  } catch (err) {
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// --- POST /api/auth/login -----------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    // Same generic error whether the email doesn't exist or the password is wrong — avoids
    // leaking which emails have accounts.
    const invalid = () => res.status(401).json({ error: 'Invalid email or password.' });
    if (!user) return invalid();

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return invalid();

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await issueSession(user, req, res);
  } catch (err) {
    res.status(500).json({ error: 'Login failed.' });
  }
});

// --- POST /api/auth/refresh ---------------------------------------------------------------
// Rotates the refresh token on every use: the presented one is revoked and a fresh one is
// issued, so a leaked-but-unused refresh token stops working as soon as the real owner
// refreshes once.
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = String(req.cookies?.cp_refresh || req.body?.refreshToken || '');
    if (!refreshToken) return res.status(400).json({ error: 'Refresh session is required.' });

    const tokenHash = hashRefreshToken(refreshToken);
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

    if (!record || record.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Refresh token is invalid or expired. Please log in again.' });
    }
    if (record.revokedAt) {
      if (record.replacedByTokenHash) {
        await prisma.refreshToken.updateMany({ where:{userId:record.userId, revokedAt:null}, data:{revokedAt:new Date()} });
      }
      res.clearCookie('cp_refresh', { ...cookieBase(), path:'/api/auth' });
      res.clearCookie('cp_access', cookieBase());
      return res.status(401).json({ error: 'Refresh session is no longer valid. Please log in again.' });
    }

    const newRefreshToken = generateRefreshToken();
    const newRefreshHash = hashRefreshToken(newRefreshToken);
    const rotated = await prisma.$transaction(async (tx) => {
      // Conditional update is the concurrency boundary: if two requests race with the same
      // refresh token, exactly one can transition revokedAt from NULL to a timestamp.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), replacedByTokenHash: newRefreshHash },
      });
      if (claimed.count !== 1) return { ok: false };
      await tx.refreshToken.create({
        data: {
          tokenHash: newRefreshHash,
          userId: record.userId,
          expiresAt: refreshExpiryDate(),
          userAgent: req.headers['user-agent'] || null,
          ip: req.ip,
        },
      });
      return { ok: true };
    });
    if (!rotated.ok) {
      res.clearCookie('cp_refresh', { ...cookieBase(), path:'/api/auth' });
      res.clearCookie('cp_access', cookieBase());
      return res.status(401).json({ error: 'Refresh session is no longer valid. Please log in again.' });
    }

    res.cookie('cp_refresh', newRefreshToken, { ...cookieBase(), path:'/api/auth', maxAge:Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 30)*24*60*60*1000 });
    const nextAccessToken = signAccessToken(record.user);
    res.cookie('cp_access', nextAccessToken, { ...cookieBase(), maxAge: accessCookieMaxAge() });
    res.json({ accessToken: nextAccessToken, user: publicUser(record.user) });
  } catch (err) {
    res.status(500).json({ error: 'Could not refresh session.' });
  }
});

// --- POST /api/auth/logout ------------------------------------------------------------------
router.post('/logout', async (req, res) => {
  try {
    const refreshToken = String(req.cookies?.cp_refresh || req.body?.refreshToken || '');
    const { allDevices } = req.body || {};
    if (allDevices && req.headers.authorization) {
      const { verifyAccessToken } = require('../auth');
      try {
        const claims = verifyAccessToken(req.headers.authorization.split(' ')[1]);
        await prisma.refreshToken.updateMany({
          where: { userId: claims.sub, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } catch (_) { /* ignore — falls through to single-token revoke below */ }
    } else if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        data: { revokedAt: new Date() },
      });
    }
    res.clearCookie('cp_refresh', { ...cookieBase(), path:'/api/auth' });
      res.clearCookie('cp_access', cookieBase());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed.' });
  }
});

// --- GET /api/auth/me ------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (!user) return res.status(404).json({ error: 'Account no longer exists.' });
  res.json({ user: publicUser(user) });
});

// --- PATCH /api/auth/me ----------------------------------------------------------------------
router.patch('/me', requireAuth, async (req, res) => {
  const { name, branch, graduationYear } = req.body || {};
  const user = await prisma.user.update({
    where: { id: req.user.sub },
    data: {
      ...(name ? { name: name.trim() } : {}),
      ...(branch !== undefined ? { branch: branch || null } : {}),
      ...(graduationYear !== undefined ? { graduationYear: graduationYear ? Number(graduationYear) : null } : {}),
    },
  });
  res.json({ user: publicUser(user) });
});

module.exports = router;
