const rateLimit = require('express-rate-limit');

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function createApiRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 120),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready',
    handler: (req, res) => res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
      requestId: req.requestId || null,
    }),
  });
}

// Cookie-authenticated state-changing requests need an origin check. Bearer-token API
// clients remain compatible because they can omit Origin; browsers using the HttpOnly
// auth cookies send Origin for state-changing requests.
function createCsrfOriginGuard() {
  const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return (req, res, next) => {
    if (!mutating.has(req.method)) return next();
    const hasAuthCookie = Boolean(req.cookies?.cp_access || req.cookies?.cp_refresh);
    const origin = normalizeOrigin(req.get('origin'));
    if (!hasAuthCookie || !origin) return next();

    const configured = String(process.env.CORS_ORIGIN || '')
      .split(',').map(normalizeOrigin).filter(Boolean);
    const hostOrigin = normalizeOrigin(`${req.protocol}://${req.get('host')}`);
    if (configured.includes(origin) || origin === hostOrigin) return next();

    return res.status(403).json({
      success: false,
      error: { code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' },
      requestId: req.requestId || null,
    });
  };
}

module.exports = { createApiRateLimiter, createCsrfOriginGuard };
