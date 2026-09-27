const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src/middleware/auth.js'), 'utf8');
const authRoutes = fs.readFileSync(path.join(root, 'src/routes/auth.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, '..', 'frontend', 'index.html'), 'utf8');
const ai = fs.readFileSync(path.join(root, '..', 'ai-ml-service', 'app', 'main.py'), 'utf8');

assert(server.includes('Content-Security-Policy'), 'CSP must be configured.');
assert(server.includes('nonce-'), 'CSP must use nonces for inline scripts.');
assert(server.includes('/api/ai-ml'), 'FastAPI must be reachable through an authenticated backend gateway.');
assert(server.includes('AI_ML_SERVICE_TOKEN'), 'FastAPI gateway must use an internal service token.');
assert(server.includes('OPERATIONS_TOKEN'), 'Operational endpoints must be protected.');
assert(auth.includes('cp_access'), 'Auth middleware must support HttpOnly access-cookie sessions.');
assert(authRoutes.includes("res.cookie('cp_access'"), 'Login/refresh must issue the access cookie.');
assert(frontend.includes("'/api/ai-ml'"), 'AI/ML frontend helper should default to the same-origin gateway.');
assert(ai.includes('AI_SERVICE_TOKEN'), 'AI/ML service must validate the internal service token.');
assert(ai.includes('compare_digest'), 'AI/ML service token comparison must be timing-safe.');
assert(!frontend.includes('onclick=\\"window.location.reload()\\"'), 'CSP-sensitive inline event handler must be removed.');

assert(server.includes("Strict-Transport-Security"), 'Production responses should include HSTS.');
assert(server.includes("Permissions-Policy"), 'Security headers should include Permissions-Policy.');
assert(server.includes("INVALID_SYSTEM_PROMPT"), 'AI endpoint must validate system prompt size/type.');
assert(server.includes("INVALID_AI_REQUEST"), 'Streaming AI endpoint must validate request options.');
assert(ai.includes('request.headers.get("x-request-id")'), 'AI/ML logs should preserve gateway request IDs.');
assert(ai.includes('Public liveness only'), 'AI/ML health must not expose implementation details.');

console.log('Final hardening static checks passed.');

const securityMiddleware = fs.readFileSync(path.join(root, 'src/middleware/security.js'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const productionAudit = fs.readFileSync(path.join(root, 'scripts/production-audit.js'), 'utf8');
assert(securityMiddleware.includes('CSRF_ORIGIN_REJECTED'), 'Cookie-authenticated mutations need an origin guard.');
assert(securityMiddleware.includes('API_RATE_LIMIT_PER_MINUTE'), 'Global API rate limiting must be configurable.');
assert(server.includes('gzipSync'), 'Server should compress sufficiently large text/JSON responses.');
assert(server.includes('Cache-Control'), 'Static assets and health responses need explicit cache policy.');
assert(authRoutes.includes('updateMany({') && authRoutes.includes('revokedAt: null'), 'Refresh rotation must use a conditional DB update.');
assert(envExample.includes('API_RATE_LIMIT_PER_MINUTE='), 'API rate-limit configuration must be documented.');
assert(productionAudit.includes('resumeSourceSha256'), 'Production audit must fingerprint the protected Resume source.');
console.log('Final production hardening checks passed.');
