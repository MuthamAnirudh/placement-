const { verifyAccessToken } = require('../auth');

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token;
  // Preferred production path: short-lived access token in an HttpOnly cookie.
  // Bearer remains supported for backward compatibility with existing API clients.
  const cookieToken = req.cookies?.cp_access;
  return cookieToken ? String(cookieToken) : null;
}

function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ success:false, error:{ code:'AUTH_REQUIRED', message:'Not authenticated. Log in and try again.' }, requestId:req.requestId });
  try { req.user = verifyAccessToken(token); next(); }
  catch (_) { return res.status(401).json({ success:false, error:{ code:'TOKEN_EXPIRED', message:'Session expired. Please log in again.' }, requestId:req.requestId }); }
}

function optionalAuth(req, res, next) {
  const token = getBearerToken(req);
  if (token) { try { req.user = verifyAccessToken(token); } catch (_) {} }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') return res.status(403).json({ success:false, error:{ code:'ADMIN_REQUIRED', message:'Admin access required.' }, requestId:req.requestId });
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
