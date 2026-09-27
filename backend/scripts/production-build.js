'use strict';

// The frontend is intentionally a source-served, single-file React application rather than
// a bundler project. This build gate therefore validates the production artifact and backend
// syntax without rewriting/bundling the protected Resume-containing frontend file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const backendRoot = path.join(__dirname, '..');
const projectRoot = path.join(backendRoot, '..');
const required = [
  path.join(backendRoot, 'server.js'),
  path.join(backendRoot, 'prisma', 'schema.prisma'),
  path.join(projectRoot, 'frontend', 'index.html'),
];

for (const file of required) {
  if (!fs.existsSync(file)) throw new Error(`Required production artifact is missing: ${file}`);
}

// Syntax-check the backend without requiring a network install or a running database.
execFileSync(process.execPath, ['--check', path.join(backendRoot, 'server.js')], { stdio: 'inherit' });

// Re-run the source-level production invariants, including the protected Resume fingerprint.
execFileSync(process.execPath, [path.join(__dirname, 'production-audit.js')], { stdio: 'inherit' });

console.log('Production build validation passed.');
