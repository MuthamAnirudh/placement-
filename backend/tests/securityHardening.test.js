const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const portalAuth = fs.readFileSync(path.join(root, 'src/routes/portalAuth.js'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/routes/storage.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, '..', 'frontend', 'index.html'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'src/routes/gatePasses.js'), 'utf8');

assert(!portalAuth.includes("req.body?.codeHash"), 'Recovery must not trust a client-supplied code hash.');
assert(!portalAuth.includes("req.body?.salt"), 'Recovery must not trust a client-supplied salt.');
assert(!portalAuth.includes("req.body?.expiresAt"), 'Recovery expiry must be server generated.');
assert(portalAuth.includes('crypto.randomInt(0, 1000000)'), 'Recovery code must be generated server-side.');
assert(portalAuth.includes('crypto.timingSafeEqual'), 'Recovery comparison must be timing-safe.');
assert(portalAuth.includes('passwordRecovery'), 'Recovery must use the dedicated database model.');
assert(portalAuth.includes("refreshToken"), 'Portal authentication must continue issuing sessions.');
assert(storage.includes("delete value.passwordHash"), 'Shared account storage must not persist password hashes.');
assert(storage.includes("role!=='ADMIN'"), 'Non-admin shared account updates must not change roles.');
assert(server.includes("if (config.isProduction && !configuredOrigins.length)"), 'Production CORS must be explicitly configured.');
assert(server.includes("credentials: true"), 'Cookie-based refresh sessions require credentialed CORS.');
assert(frontend.includes("credentials:'include'"), 'Frontend authentication requests must send refresh cookies.');
assert(!/recovery\/start.*codeHash/.test(frontend), 'Frontend must not submit recovery hashes.');
assert(gate.includes('crypto.randomBytes(32)'), 'Gate-pass tokens must be cryptographically random.');
assert(gate.includes('qrUsed: false'), 'Gate-pass redemption must use conditional state.');
assert(gate.includes("status: 'approved'"), 'Gate-pass redemption must verify approval server-side.');
console.log('Security hardening static checks passed.');
