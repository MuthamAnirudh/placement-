// Vercel serverless entry point.
//
// This file intentionally contains almost no logic. It exists only because Vercel's
// zero-config Node runtime needs a handler under an `api/` directory — the actual
// application (every route, every piece of middleware, rate limiting, auth, the
// storage/kv endpoints, everything) lives in ../server.js exactly as it always has.
//
// Because server.js now does `module.exports = app` and only calls app.listen(...) when
// run directly (see the `require.main === module` guard at the bottom of server.js), the
// same file works unmodified as:
//   - a normal long-running Node process (`node server.js`, Railway, Render, local dev)
//   - a Vercel serverless function (this file, invoked per-request)
//
// vercel.json at the repo root routes every `/api/*` request to this function.
module.exports = require('../server.js');
