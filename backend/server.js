// server.js
// Secure LLM proxy for the AI Powered Campus Placement Portal.
//
// Why this exists: the original frontend called Anthropic/OpenAI/Gemini directly from the
// browser using API keys typed into Settings and stored in localStorage. That means every
// visitor's browser holds a real, usable API key — anyone can open devtools and steal it.
// This backend fixes that: the frontend now calls THIS server (same-origin or a configured
// BACKEND URL), and only this server holds the real provider API key, read from environment
// variables that are never shipped to the browser.
//
// It exposes the SAME provider-agnostic contract as before (nothing in the frontend needs to
// change, and no previous feature is removed):
//   POST /api/ai          { systemPrompt, userPrompt, opts }  -> { text }
//   POST /api/ai/stream    same body, but streams Server-Sent Events shaped like Anthropic's
//                          `content_block_delta` events, so the existing frontend streaming
//                          reader (which already knows how to parse that shape) works unmodified.
//   GET  /api/health
//
// New in this version (all additive — see README "What's new" section):
//   - Real token-by-token streaming for OpenAI and Gemini (previously faked as one big chunk)
//   - Automatic fallback across configured providers if the requested/default one fails
//   - Retries with exponential backoff + per-request timeouts (no more hung requests)
//   - In-memory response caching for repeated identical prompts (cheaper + faster)
//   - JSON-mode self-repair: one corrective retry if `jsonMode` output isn't valid JSON
//   - Basic prompt-injection / abuse guardrails and input size limits
//   - Structured request logging with request IDs and latency
//   - GET /api/usage — simple in-memory usage counters (requests, cache hits, errors, per-provider)
//   - Startup environment validation with clear warnings
//   - Graceful shutdown on SIGINT/SIGTERM
//
// `opts` supports: { provider, model, maxTokens, temperature, jsonMode, noCache }
//   - provider: "groq" | "gemini" (defaults to AI_PROVIDER env var)
//   - model: overrides the default model for that provider
//   - jsonMode: asks the provider to return raw JSON (used by ATS scorer, mock-interview
//     grading, roadmap generator, etc.)
//   - noCache: set true to bypass the response cache for this call

require('dotenv').config();
const config = require('./src/config');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const zlib = require('zlib');
const { createApiRateLimiter, createCsrfOriginGuard } = require('./src/middleware/security');

// --- Persistence layer (Postgres via Prisma) --------------------------------------------
// Additive: user accounts, auth, and saved quiz/interview/roadmap/radar/resume results.
// Nothing below this line changes the existing /api/ai contract or behavior.
const authRoutes = require('./src/routes/auth');
const resultsRoutes = require('./src/routes/results');
const graphRoutes = require('./src/routes/graph');
const twinRoutes = require('./src/routes/twin');
const voiceRoutes = require('./src/routes/voice');
const storageRoutes = require('./src/routes/storage');
const gatePassRoutes = require('./src/routes/gatePasses');
const portalAuthRoutes = require('./src/routes/portalAuth');
const runtimeTelemetry = require('./src/runtime');   // Adaptive Neural Teacher Voice (ElevenLabs v3)

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

function setSecurityHeaders(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  // Defense-in-depth headers that do not depend on frontend markup. HSTS is only
  // emitted over HTTPS in production so local HTTP development is unaffected.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, 'https://cdn.tailwindcss.com', 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'];
  const connectSrc = ["'self'", 'https://gnews.io', 'https://api.emailjs.com', 'https://api.groq.com', 'https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com', 'https://api.qrserver.com', 'https://emkc.org', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
  const csp = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'self'`,
    `form-action 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data: https:`,
    `connect-src ${connectSrc.join(' ')}`,
    `media-src 'self' blob: data: https:`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `upgrade-insecure-requests`
  ].join('; ');
  res.setHeader(config.isProduction ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', csp);
}

app.use((req, res, next) => {
  setSecurityHeaders(req, res);
  next();
});
// Exam-paper photos/scanned PDFs are sent as base64 image parts to the vision-capable
// Gemini path. The portal caps individual uploads at 8MB, so allow enough JSON headroom
// for base64 expansion without changing the normal text request contract.
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
// Dependency-free response compression for text/JSON assets. SSE and already-compressed
// responses are intentionally left alone. This avoids adding another runtime dependency.
app.use((req, res, next) => {
  if (req.headers.accept === 'text/event-stream' || req.method === 'HEAD') return next();
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (res.headersSent || body == null || res.getHeader('Content-Encoding')) return originalSend(body);
    const type = String(res.getHeader('Content-Type') || '');
    const encoding = String(req.headers['accept-encoding'] || '').toLowerCase();
    if (!/(text|json|javascript|css|svg|xml|html)/i.test(type) || !encoding.includes('gzip')) return originalSend(body);
    const input = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (input.length < 1024) return originalSend(body);
    try {
      const compressed = zlib.gzipSync(input, { level: 6 });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      return originalSend(compressed);
    } catch (_) { return originalSend(body); }
  };
  next();
});
app.use(createCsrfOriginGuard());
app.use((req, res, next) => {
  const length = Number(req.get('content-length') || 0);
  const max = req.path.startsWith('/api/ai') ? 20 * 1024 * 1024 : 12 * 1024 * 1024;
  if (Number.isFinite(length) && length > max) return res.status(413).json({ success:false, error:{code:'PAYLOAD_TOO_LARGE', message:'Request payload is too large.'}, requestId:req.requestId || null });
  next();
});

// --- Production-grade request context / security hardening (additive) ---------------------
// Keeps existing API contracts unchanged while making failures traceable and responses safer.
const runtimeMetrics = { startedAt: Date.now(), requests: 0, errors: 0, latencyMs: 0, active: 0, byRoute: {} };
app.disable('x-powered-by');
app.use((req, res, next) => {
  const incoming = String(req.get('x-request-id') || '').trim();
  const id = /^[A-Za-z0-9._:-]{1,100}$/.test(incoming) ? incoming : requestId();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const started = process.hrtime.bigint();
  runtimeMetrics.requests++; runtimeMetrics.active++;
  res.on('finish', () => {
    runtimeMetrics.active = Math.max(0, runtimeMetrics.active - 1);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    runtimeMetrics.latencyMs += ms;
    const route = req.route?.path || req.path || 'unknown';
    const item = runtimeMetrics.byRoute[route] || { requests: 0, errors: 0, totalMs: 0 };
    item.requests++; item.totalMs += ms; if (res.statusCode >= 500) item.errors++;
    runtimeMetrics.byRoute[route] = item;
    if (res.statusCode >= 500) runtimeMetrics.errors++;
    runtimeTelemetry.observe(route, res.statusCode, ms);
  });
  next();
});
function requireOperationalAccess(req, res, next) {
  const configured = String(process.env.OPERATIONS_TOKEN || '').trim();
  if (!configured) return config.isProduction ? res.status(503).json({ success:false, error:{code:'OPERATIONS_NOT_CONFIGURED', message:'Operational diagnostics are not configured.'}, requestId:req.requestId }) : next();
  const presented = String(req.get('x-operations-token') || '').trim();
  const a=Buffer.from(presented), b=Buffer.from(configured);
  if (!presented || a.length !== b.length || !crypto.timingSafeEqual(a,b)) {
    return res.status(404).json({ success:false, error:{code:'NOT_FOUND', message:'Not found.'}, requestId:req.requestId });
  }
  next();
}

app.get('/api/health/runtime', requireOperationalAccess, (req, res) => {
  const avg = runtimeMetrics.requests ? runtimeMetrics.latencyMs / runtimeMetrics.requests : 0;
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), active: runtimeMetrics.active,
    requests: runtimeMetrics.requests, errors: runtimeMetrics.errors, avgLatencyMs: Math.round(avg),
    routes: Object.fromEntries(Object.entries(runtimeMetrics.byRoute).map(([k,v]) => [k, { ...v, avgLatencyMs: Math.round(v.totalMs / Math.max(1,v.requests)) }])) });
});

app.get('/api/health/live', (req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.json({ ok: true, status: 'live', uptimeSec: Math.round(process.uptime()) });
});

app.get('/api/health/ready', async (req, res) => {
  let db = 'not_configured';
  if (process.env.DATABASE_URL) {
    try { const prisma = require('./src/db'); await prisma.$queryRaw`SELECT 1`; db = 'ok'; }
    catch (_) { db = 'error'; }
  }
  const aiConfigured = Object.values(KEYS).some(Boolean);
  const ready = db !== 'error';
  res.status(ready ? 200 : 503).setHeader('Cache-Control','no-store').json({ok:ready,status:ready?'ready':'degraded',db,aiConfigured});
});

app.get('/api/health/metrics', requireOperationalAccess, (req, res) => {
  const data = runtimeTelemetry.snapshot();
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,...data});
});

app.get('/api/health/runtime/deep', requireOperationalAccess, (req, res) => {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  res.json({ ok: true, node: process.version, pid: process.pid, uptimeSec: Math.round(process.uptime()),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    cpu: { userMicros: cpu.user, systemMicros: cpu.system },
    eventLoop: { activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null }
  });
});

// Serve the frontend from the same server/origin. index.html is nonce-injected at request
// time so production CSP can allow the existing inline boot/app scripts without falling back
// to unsafe-inline for JavaScript. Static assets continue to use the normal express handler.
const frontendRoot = path.join(__dirname, '..', 'frontend');
function sendIndex(req, res) {
  try {
    let html = fs.readFileSync(path.join(frontendRoot, 'index.html'), 'utf8');
    const nonce = res.locals.cspNonce;
    html = html.replace(/<script(?![^>]*\bsrc\s*=)([^>]*)>/gi, (m, attrs) => `<script nonce=\"${nonce}\"${attrs}>`);
    return res.type('html').send(html);
  } catch (_) { return res.status(500).json({success:false,error:{code:'FRONTEND_UNAVAILABLE',message:'Frontend is temporarily unavailable.'},requestId:req.requestId}); }
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
app.use(express.static(frontendRoot, {
  index: false,
  fallthrough: true,
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (/\.(?:css|js|mjs|json|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// --- CORS --------------------------------------------------------------------------------
const configuredOrigins = String(process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (config.isProduction && !configuredOrigins.length) throw new Error('CORS_ORIGIN is required in production.');
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (configuredOrigins.includes(origin)) return callback(null, true);
    if (config.isDevelopment && /^https?:\/\/(localhost|127\.0\.1)(:\d+)?$/i.test(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
}));

// --- Rate limiting -------------------------------------------------------------------------
// A global API ceiling prevents accidental request storms against non-AI endpoints too;
// feature-specific limiters below remain in place for authentication/AI/gate redemption.
app.use('/api', createApiRateLimiter());
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MINUTE || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests from this device — please wait a moment and try again.' },
});
app.use('/api/ai', limiter);

// --- Authenticated FastAPI AI/ML gateway ----------------------------------------------------
// The browser talks to this same-origin endpoint; only the Express server knows the internal
// service URL/token. This prevents the FastAPI service from being an anonymous public API.
const { requireAuth } = require('./src/middleware/auth');
const AI_ML_SERVICE_URL = String(process.env.AI_ML_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const AI_ML_SERVICE_TOKEN = String(process.env.AI_ML_SERVICE_TOKEN || '').trim();
app.use('/api/ai-ml', requireAuth, async (req, res, next) => {
  const target = `${AI_ML_SERVICE_URL}${req.originalUrl.replace(/^\/api\/ai-ml/, '') || '/'}`;
  const headers = {};
  for (const [k,v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (!['host','content-length','connection','authorization','cookie','x-service-token'].includes(lower) && typeof v === 'string') headers[k] = v;
  }
  headers['x-service-token'] = AI_ML_SERVICE_TOKEN;
  headers['x-request-id'] = req.requestId;
  let body;
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    body = JSON.stringify(req.body);
    headers['content-type'] = 'application/json';
  } else if (!['GET','HEAD'].includes(req.method)) {
    body = req;
    headers['content-type'] = req.get('content-type') || 'application/octet-stream';
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.AI_ML_PROXY_TIMEOUT_MS || 45000));
    const upstream = await fetch(target, { method:req.method, headers, body, signal:controller.signal, duplex: body && body === req ? 'half' : undefined });
    clearTimeout(timer);
    res.status(upstream.status);
    upstream.headers.forEach((v,k) => { if (!['content-length','transfer-encoding','connection'].includes(k.toLowerCase())) res.setHeader(k,v); });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    return next(Object.assign(new Error('AI/ML service unavailable'), { status:502, cause:err }));
  }
});

// --- Auth & saved-results routes -------------------------------------------------------------
// Own internal rate limiter (see src/routes/auth.js) — separate from the AI limiter above.
app.use('/api/auth', authRoutes);
app.use('/api/results', resultsRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/twin', twinRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/gate-passes', gatePassRoutes);
app.use('/api/portal-auth', portalAuthRoutes);

// --- Config --------------------------------------------------------------------------------
// Priority order for automatic fallback: Groq is tried first (fast + cheap), and if it fails
// (missing key, error, timeout, rate limit, etc.) requests automatically shift to Gemini.
// Override with AI_PROVIDER / AI_PROVIDER_ORDER env vars if needed.
const PROVIDER_PRIORITY = (process.env.AI_PROVIDER_ORDER || 'groq,gemini')
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_PROVIDER = (process.env.AI_PROVIDER || PROVIDER_PRIORITY[0] || 'groq').toLowerCase();
// .trim() guards against copy-pasted keys that pick up stray quotes/whitespace from .env —
// a key like `"AIza..."` (with literal quotes) or one with a trailing newline will silently
// fail upstream with a confusing "invalid authentication credentials" error otherwise.
const KEYS = {
  groq: (process.env.GROQ_API_KEY || '').trim(),
  gemini: (process.env.GEMINI_API_KEY || '').trim(),
};
// llama-3.3-70b-versatile was decommissioned by Groq (Aug 16, 2026). Groq's recommended
// replacement is openai/gpt-oss-120b. See https://console.groq.com/docs/deprecations
const MODELS = {
  groq: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  gemini: process.env.GEMINI_MODEL || 'gemini-flash-latest',
};

const REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.AI_MAX_RETRIES || 2);
const MAX_PROMPT_CHARS = Number(process.env.AI_MAX_PROMPT_CHARS || 48000);
const CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 5 * 60 * 1000);
const CACHE_MAX_ENTRIES = Number(process.env.AI_CACHE_MAX_ENTRIES || 200);

// --- Startup environment validation ---------------------------------------------------------
(function validateEnv() {
  const configured = Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k);
  if (configured.length === 0) {
    console.warn('⚠️  No LLM API keys configured. Set GROQ_API_KEY / GEMINI_API_KEY in backend/.env');
  } else {
    console.log(`✅ Configured providers: ${configured.join(', ')} (default: ${DEFAULT_PROVIDER})`);
    if (!KEYS[DEFAULT_PROVIDER]) {
      console.warn(`⚠️  AI_PROVIDER="${DEFAULT_PROVIDER}" has no key set — requests will automatically fall back to: ${configured.join(', ')}`);
    }
  }
  if (configuredOrigins.includes('*')) {
    console.warn('⚠️  CORS_ORIGIN is "*" — fine for local dev, but set it to your real frontend URL(s) in production.');
  }
})();

// --- Usage stats (simple in-memory counters; resets on restart) ----------------------------
const usageStats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  totalErrors: 0,
  cacheHits: 0,
  byProvider: { groq: 0, gemini: 0 },
};

// --- Response cache (in-memory, TTL + simple LRU eviction) ----------------------------------
const responseCache = new Map(); // key -> { text, expiresAt }

function cacheKeyFor({ systemPrompt, userPrompt, opts }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ systemPrompt, userPrompt, opts: { ...opts, noCache: undefined } }))
    .digest('hex');
}

function cacheGet(key) {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  responseCache.delete(key);
  responseCache.set(key, hit); // refresh recency
  return hit.text;
}

function cacheSet(key, text) {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { text, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- Basic guardrails ------------------------------------------------------------------------
// Not a substitute for real content moderation — just cheap, useful defensive checks.
const SUSPICIOUS_PATTERNS = [
  /ignore (all|any|previous|prior) instructions/i,
  /disregard (all|any|previous|prior) (instructions|prompt)/i,
  /reveal (your |the )?system prompt/i,
  /you are now (in )?(dan|developer) mode/i,
];

function checkGuardrails(userPrompt) {
  if (typeof userPrompt !== 'string' || !userPrompt.trim()) {
    return 'userPrompt is required';
  }
  if (userPrompt.length > MAX_PROMPT_CHARS) {
    return `Prompt too long (${userPrompt.length} chars). Max allowed is ${MAX_PROMPT_CHARS}.`;
  }
  return null;
}

function flagSuspicious(userPrompt) {
  return SUSPICIOUS_PATTERNS.some((re) => re.test(userPrompt));
}

// --- Request logging ---------------------------------------------------------------------
function requestId() {
  return crypto.randomBytes(6).toString('hex');
}

function logRequest(id, msg, extra) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${id}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

// --- Retry / timeout helper ----------------------------------------------------------------
async function withRetries(fn, { retries = MAX_RETRIES, id } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retriable = err.retriable !== false; // default: retry unless explicitly marked non-retriable
      if (!retriable || attempt === retries) break;
      const backoffMs = Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200;
      if (id) logRequest(id, `retrying after error (attempt ${attempt + 1}/${retries})`, { error: err.message, backoffMs: Math.round(backoffMs) });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Request timed out after ${timeoutMs}ms.`);
      e.retriable = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function resolveProvider(opts) {
  const p = (opts && opts.provider) || DEFAULT_PROVIDER;
  if (!KEYS[p]) {
    // Fall back to whichever provider actually has a key, respecting PROVIDER_PRIORITY
    // (groq -> gemini by default) rather than arbitrary object order.
    const configured = PROVIDER_PRIORITY.find((k) => KEYS[k]);
    if (configured) return configured;
  }
  return p;
}

// Ordered fallback chain: requested/default provider first, then the remaining configured
// providers in PROVIDER_PRIORITY order (groq -> gemini by default). If Groq fails for any
// reason, the next provider tried is Gemini.
function fallbackChain(opts) {
  const wantsVision = !!(opts && Array.isArray(opts.images) && opts.images.length);
  if (wantsVision) {
    // Groq's current text endpoint is not a vision endpoint in this backend. Route image
    // prompts directly to Gemini, which accepts inlineData image parts. This prevents an
    // uploaded question-paper photo from being silently described to a text-only model.
    return KEYS.gemini ? ['gemini'] : [];
  }
  const primary = resolveProvider(opts);
  const rest = PROVIDER_PRIORITY.filter((k) => KEYS[k] && k !== primary);
  return [primary, ...rest];
}

// --- Non-streaming provider calls -----------------------------------------------------------
// Groq exposes an OpenAI-compatible Chat Completions API, so the request/response shape is
// identical to OpenAI's — only the base URL, key, and default model differ.
async function callGroq({ systemPrompt, userPrompt, opts }) {
  const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS.groq}` },
    body: JSON.stringify({
      model: (opts && opts.model) || MODELS.groq,
      max_tokens: (opts && opts.maxTokens) || 1000,
      temperature: opts && opts.temperature !== undefined ? opts.temperature : 0.4,
      response_format: opts && opts.jsonMode ? { type: 'json_object' } : undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    const e = new Error((err && err.error && err.error.message) || `Groq API returned HTTP ${resp.status}`);
    e.retriable = resp.status === 429 || resp.status >= 500;
    throw e;
  }
  const data = await resp.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  if (!text) throw Object.assign(new Error('Groq returned an empty response.'), { retriable: true });
  return text.trim();
}

async function callGemini({ systemPrompt, userPrompt, opts }) {
  const model = (opts && opts.model) || MODELS.gemini;
  // As of Sept 2026, Google has migrated Gemini API keys from the old `AIza...` format to a
  // new `AQ....` format, and new-format keys must be sent via the `x-goog-api-key` header —
  // the old `?key=` query param returns "invalid authentication credentials" for them (and
  // Google's own docs now recommend the header for all keys regardless of format anyway).
  const resp = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEYS.gemini },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
        contents: [{
          role: 'user',
          parts: [
            { text: userPrompt },
            ...((opts && Array.isArray(opts.images)) ? opts.images.slice(0, 8).map((img) => ({
              inlineData: { mimeType: String(img.mimeType || 'image/jpeg'), data: String(img.base64 || '') }
            })).filter((part) => part.inlineData.data) : []),
          ],
        }],
        generationConfig: {
          maxOutputTokens: (opts && opts.maxTokens) || 1000,
          temperature: opts && opts.temperature !== undefined ? opts.temperature : 0.4,
          ...(opts && opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    const e = new Error((err && err.error && err.error.message) || `Gemini API returned HTTP ${resp.status}`);
    e.retriable = resp.status === 429 || resp.status >= 500;
    throw e;
  }
  const data = await resp.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw Object.assign(new Error('Gemini returned an empty response (it may have been blocked by safety filters).'), { retriable: false });
  return text;
}

const CALLERS = { groq: callGroq, gemini: callGemini };

function looksLikeJson(text) {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

// Calls a provider, with retries, and — if jsonMode was requested but the output isn't valid
// JSON — one corrective retry that explicitly re-asks for JSON only.
async function callProviderRobust({ provider, systemPrompt, userPrompt, opts, id }) {
  const caller = CALLERS[provider];
  let text = await withRetries((attempt) => caller({ systemPrompt, userPrompt, opts, attempt }), { id });

  if (opts && opts.jsonMode && !looksLikeJson(text)) {
    logRequest(id, 'jsonMode output was not valid JSON, attempting one corrective retry');
    const repairSystemPrompt = `${systemPrompt}\n\nIMPORTANT: Respond with ONLY raw, valid JSON. No markdown code fences, no commentary, no explanation before or after the JSON.`;
    text = await withRetries(
      (attempt) => caller({ systemPrompt: repairSystemPrompt, userPrompt, opts, attempt }),
      { id, retries: 1 }
    );
  }
  return text;
}

// --- /api/ai (non-streaming, cached, with provider fallback) --------------------------------
app.post('/api/ai', async (req, res) => {
  const id = requestId();
  const startedAt = Date.now();
  usageStats.totalRequests += 1;
  try {
    const { systemPrompt = '', userPrompt = '', opts = {} } = req.body || {};
    if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ success:false, error:{code:'INVALID_SYSTEM_PROMPT',message:'System prompt is invalid or too large.'}, requestId:id });
    }
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      return res.status(400).json({ success:false, error:{code:'INVALID_OPTIONS',message:'AI options must be an object.'}, requestId:id });
    }

    const guardrailError = checkGuardrails(userPrompt);
    if (guardrailError) return res.status(400).json({ error: guardrailError });

    if (flagSuspicious(userPrompt)) {
      logRequest(id, 'suspicious prompt pattern flagged (allowed through, logged for review)');
    }

    const cacheKey = cacheKeyFor({ systemPrompt, userPrompt, opts });
    if (!opts.noCache) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        usageStats.cacheHits += 1;
        logRequest(id, 'cache hit', { ms: Date.now() - startedAt });
        return res.json({ text: cached, provider: 'cache', cached: true });
      }
    }

    const chain = fallbackChain(opts);
    let lastErr;
    for (const provider of chain) {
      try {
        const text = await callProviderRobust({ provider, systemPrompt, userPrompt, opts, id });
        usageStats.byProvider[provider] = (usageStats.byProvider[provider] || 0) + 1;
        if (!opts.noCache) cacheSet(cacheKey, text);
        logRequest(id, 'success', { provider, ms: Date.now() - startedAt, fellBack: provider !== chain[0] });
        return res.json({ text, provider, fellBack: provider !== chain[0] });
      } catch (err) {
        lastErr = err;
        logRequest(id, `provider "${provider}" failed`, { error: err.message });
      }
    }
    throw lastErr || new Error('No provider configured on the server.');
  } catch (err) {
    usageStats.totalErrors += 1;
    logRequest(id, 'error', { error: err.message, ms: Date.now() - startedAt });
    res.status(502).json({ success:false, error:{code:'AI_PROVIDER_UNAVAILABLE',message:'The AI provider request failed. Please retry.'}, requestId:id });
  }
});

// --- Streaming call (SSE), normalized to Anthropic's content_block_delta shape -----------
// (Groq and Gemini's native streaming shapes are converted below into that same
// content_block_delta shape so the existing frontend streaming reader works unmodified.)

// True incremental streaming for Groq's SSE chat-completions stream (OpenAI-compatible shape).
async function streamGroq({ systemPrompt, userPrompt, opts, sendDelta }) {
  const upstream = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS.groq}` },
    body: JSON.stringify({
      model: opts.model || MODELS.groq,
      max_tokens: opts.maxTokens || 1000,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.4,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!upstream.ok || !upstream.body) throw new Error(`Groq API returned HTTP ${upstream.status}`);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
        if (delta) sendDelta(delta);
      } catch (_) { /* ignore partial/non-JSON lines */ }
    }
  }
}

// True incremental streaming for Gemini's streamGenerateContent (SSE).
async function streamGemini({ systemPrompt, userPrompt, opts, sendDelta }) {
  const model = opts.model || MODELS.gemini;
  const upstream = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEYS.gemini },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: opts.maxTokens || 1000,
          temperature: opts.temperature !== undefined ? opts.temperature : 0.4,
        },
      }),
    }
  );
  if (!upstream.ok || !upstream.body) throw new Error(`Gemini API returned HTTP ${upstream.status}`);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
        const text = parts.map((p) => p.text || '').join('');
        if (text) sendDelta(text);
      } catch (_) { /* ignore partial/non-JSON lines */ }
    }
  }
}

const STREAMERS = { groq: streamGroq, gemini: streamGemini };

app.post('/api/ai/stream', async (req, res) => {
  const id = requestId();
  const startedAt = Date.now();
  usageStats.totalRequests += 1;
  const { systemPrompt = '', userPrompt = '', opts = {} } = req.body || {};
  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_PROMPT_CHARS || !opts || typeof opts !== 'object' || Array.isArray(opts)) {
    res.status(400).json({ success:false, error:{code:'INVALID_AI_REQUEST',message:'AI request payload is invalid.'}, requestId:id });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const sendDelta = (text) => {
    res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text } })}\n\n`);
  };
  const sendDone = () => {
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const guardrailError = checkGuardrails(userPrompt);
  if (flagSuspicious(userPrompt)) logRequest(id, 'suspicious prompt pattern flagged (allowed through, logged for review)');
  if (guardrailError) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: guardrailError })}\n\n`);
    return sendDone();
  }

  const chain = fallbackChain(opts);
  let lastErr;
  for (const provider of chain) {
    try {
      if (!KEYS[provider]) throw new Error(`No API key configured on the server for "${provider}".`);
      await withRetries(() => STREAMERS[provider]({ systemPrompt, userPrompt, opts, sendDelta }), { id, retries: 1 });
      usageStats.byProvider[provider] = (usageStats.byProvider[provider] || 0) + 1;
      logRequest(id, 'stream success', { provider, ms: Date.now() - startedAt, fellBack: provider !== chain[0] });
      return sendDone();
    } catch (err) {
      lastErr = err;
      logRequest(id, `stream provider "${provider}" failed`, { error: err.message });
    }
  }
  usageStats.totalErrors += 1;
  const message = 'The AI provider request failed. Please retry.';
  res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
  sendDone();
});

app.get('/api/health', async (req, res) => {
  let db = 'not_configured';
  if (process.env.DATABASE_URL) {
    try {
      const prisma = require('./src/db');
      await prisma.$queryRaw`SELECT 1`;
      db = 'ok';
    } catch (err) {
      db = 'error';
    }
  }
  const ready = db !== 'error';
  res.status(ready ? 200 : 503).setHeader('Cache-Control', 'no-store').json({
    ok: ready,
    status: ready ? 'healthy' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    db,
  });
});

app.get('/api/usage', requireOperationalAccess, (req, res) => {
  res.json(usageStats);
});


// Consistent API failure shape. Never expose database/stack/secret details to clients.
app.use('/api', (req, res) => {
  if (!res.headersSent) return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'The requested API resource was not found.' }, requestId:req.requestId });
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode || 500);
  const message = status >= 500 ? 'An internal server error occurred.' : (err.message || 'Request failed.');
  if (status >= 500) console.error(JSON.stringify({ level:'ERROR', requestId:req.requestId, method:req.method, path:req.path, error:err.message }));
  res.status(status).json({ success:false, error:{ code: status === 413 ? 'PAYLOAD_TOO_LARGE' : (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'), message }, requestId:req.requestId });
});

let acceptingTraffic = true;
app.use((req,res,next)=>{ if(!acceptingTraffic && req.path.startsWith('/api/')) return res.status(503).json({error:'Server is draining'}); next(); });

// --- Standalone server (node server.js / Railway / Render / local dev) -----------------------
// Vercel's serverless runtime imports `app` directly (see backend/api/index.js) and calls it
// as a request handler on each invocation — it never runs this file as the process entrypoint,
// so require.main !== module there and none of this block executes. Binding a port or wiring
// SIGTERM handlers would be meaningless (and can throw) inside a per-request Lambda, so this
// guard is what makes the exact same server.js work unmodified on both a long-running host and
// on Vercel, with no routes, middleware, or behavior above this line changed either way.
if (require.main === module) {
  const PORT = process.env.PORT || 8787;
  const server = app.listen(PORT, () => {
    console.log(`AI backend proxy listening on http://localhost:${PORT}`);
    console.log(`Default provider: ${DEFAULT_PROVIDER} (key configured: ${!!KEYS[DEFAULT_PROVIDER]})`);
  });

  // --- Graceful shutdown ---------------------------------------------------------------------
  const shutdown = (signal) => {
    acceptingTraffic = false;
    console.log(`\n${signal} received, shutting down gracefully...`);
    server.close(async () => {
      try { await require('./src/db').$disconnect(); } catch (_) {}
      console.log('Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('unhandledRejection', (err) => console.error('[runtime] unhandled rejection', err));
  process.on('uncaughtException', (err) => { console.error('[runtime] uncaught exception', err); shutdown('uncaughtException'); });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Exported so backend/api/index.js (Vercel) — or any other host/tests — can reuse this exact
// app instead of duplicating routes/middleware. An Express app is itself a valid
// `(req, res) => {}` handler, which is exactly what @vercel/node expects.
module.exports = app;
