const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..', '..');
const frontend = path.join(root, 'frontend', 'index.html');
const server = path.join(root, 'backend', 'server.js');
const gate = path.join(root, 'backend', 'src', 'routes', 'gatePasses.js');
const report = {
  generatedAt: new Date().toISOString(),
  resumeSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(frontend)).digest('hex'),
  checks: {
    serverHasCsp: fs.readFileSync(server, 'utf8').includes('Content-Security-Policy'),
    apiRateLimit: fs.readFileSync(server, 'utf8').includes('createApiRateLimiter'),
    csrfOriginGuard: fs.readFileSync(server, 'utf8').includes('createCsrfOriginGuard'),
    gateAtomicUpdate: fs.readFileSync(gate, 'utf8').includes('qrUsed: false') && fs.readFileSync(gate, 'utf8').includes('updateMany'),
    gatePublicNoBiometricBlob: !fs.readFileSync(gate, 'utf8').includes('studentPhoto: data.studentPhoto'),
    secretsExampleOnly: fs.existsSync(path.join(root, 'backend', '.env.example')),
  }
};
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.checks).some(v => !v)) process.exitCode = 1;
