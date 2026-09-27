## New: Adaptive Neural Teacher Voice (Phase 8)

The AI Video Tutor, Striver AI Mentor ("Listen") and Mock Interview question reader can now speak with a
natural neural teacher voice (ElevenLabs v3) served by `POST /api/voice/generate`, with automatic fallback to
the browser voice. Set `ELEVENLABS_API_KEY` and `TEACHER_VOICE_ID` in `backend/.env` to enable it. Full details:
`CHANGELOG_PHASE8.md`.

## New: Student Digital Twin Dashboard (frontend, wires up existing backend)

The backend already shipped a real Student Digital Twin (`backend/src/routes/twin.js` +
`digitalTwin.js`/`digitalTwinRepo.js` over the `StudentCompetency`/`LearningEvent` Prisma
models) and a Knowledge Graph (`backend/src/routes/graph.js` + `knowledgeGraph.js` over
`Skill`/`SkillRelation`) — but nothing in the UI surfaced them. The **Dashboard tab** now
shows, for any signed-in student who has completed at least one Adaptive Diagnostic:

- **Overall Placement Readiness** — a ring gauge plus four sub-scores (Technical,
  Aptitude, Communication, Interview readiness), each a roll-up of real per-skill BKT
  mastery (`p_know`) from `GET /api/twin`. This is an explicit, documented **baseline
  heuristic** (weighted average: Technical 40% / Aptitude 25% / Interview 20% /
  Communication 15%, with an in-UI "How is this calculated?" disclosure) — **not** a
  trained ML model, because no labeled placement-outcome data exists in this project to
  train/validate one against. See `computeTwinReadiness()` in `frontend/index.html`.
- **Weakest/strongest skills** and a **category drill-down** (tap a category to see every
  tracked skill's mastery %, attempt count, and BKT standard-error/uncertainty).
- **Knowledge-Graph Gap Analysis** — pick any target skill and see the real prerequisite
  chain (`GET /api/twin/gap-analysis`, backed by the graph's topological sort), colored by
  which prerequisites you've already satisfied vs. still need, in learn order.

Nothing here is faked: every number comes from `GET /api/twin` / `GET /api/twin/gap-analysis`,
which in turn read real `StudentCompetency` rows populated by the existing
`window.CP_syncTwinReport()` call after each Adaptive Diagnostic. Signed-out visitors, or
signed-in students with no diagnostic history yet, see an explicit empty/sign-in state —
never placeholder numbers.

## New: AI Video Tutor — Concept-to-Video Doubt Clarification

**Skill Hub → AI Video Tutor** (`frontend/index.html`, `AiVideoTutorPanel`) is a new, additive tab
sitting alongside Coding & IDE, Aptitude, Quiz, PYQs, and Learn to Code. A student types a doubt
("Explain polymorphism", "I don't understand inheritance in Java"...), picks a duration (1/2/3/5/10
min) and difficulty (Beginner/Intermediate/Advanced), and the AI plans a timed lesson — narration
script plus on-screen visuals (bullets, code, auto-generated flow diagrams, worked examples, a
closing summary) broken into duration-matched segments. This reuses the **existing secure `/api/ai`
backend proxy** (`callAiProvider`) that every other AI Tools tab already uses — no new backend
routes, servers, or API keys were introduced.

The lesson plays back as a real watch-and-listen "video": the browser's built-in speech engine
(Web Speech API) narrates each segment with a natural-sounding voice (with a voice picker when the
browser exposes multiple English voices) while the matching visual is shown, captions run
underneath, and the player auto-advances to the next segment when narration finishes. Full
controls: play/pause, previous/next segment, playback speed, mute, captions toggle, fullscreen,
transcript, restart, and regenerate. Below the player: AI summary, key concepts, important points,
examples, and related topics (click one to start a new lesson on it). An "Ask a Follow-Up
Question" chat keeps the lesson's context and offers one-tap actions — Explain More Simply, Give
Another Example, Explain Step-by-Step, Show a Diagram, Real-World Example, Regenerate Video.

This is intentionally built on Web Speech API narration plus generated visuals rather than an
uploaded/rendered `.mp4`: it needs no video-generation or paid TTS API key and works fully
client-side today, while leaving the door open to swap in a real TTS/video-rendering provider later
(the segment JSON — narration text, captions, per-segment visual spec — is already the exact shape
a server-side FFmpeg/TTS pipeline would consume, if one is added to `ai-ml-service/` down the line).
Recent doubts are remembered locally (`aiVideoTutorHistory_v1`) so a student can quickly revisit one.

# AI-Powered Campus Placement Portal — with a secure LLM backend, accounts & saved results

This project has three parts:

- **`frontend/index.html`** — the full campus placement/training portal (all existing
  features unchanged — eligibility checker, recruiters, PYQs, resume builder, mock
  interviews, etc.), plus a new, self-contained **Account widget** (top-right corner) for
  sign-up/login and a "My Progress" panel.
- **`backend/`** — a Node/Express server that holds the real LLM API key (`POST /api/ai`,
  `POST /api/ai/stream`, unchanged) **and now also** a Postgres-backed persistence layer:
  user accounts, JWT auth, and saved quiz/interview/roadmap/radar/resume results
  (`/api/auth/*`, `/api/results/*`).
- **`ai-ml-service/`** — the FastAPI microservice with the heavier AI/ML capabilities
  (resume/JD parsing, roadmaps, semantic match, Whisper, adaptive diagnostics, mock
  interview NLP, market intelligence) — now with **two new capabilities** (Career Path
  Predictor, Peer Percentile Benchmarking) and **deepened** versions of the three existing
  advanced features. See `ai-ml-service/README.md`.

## New: Mock Interview Studio — Project Reviewer, Viva Voce, Insights

The **Mock Interview** tab is now a hub with four modes (frontend only; no backend changes):

- **Company Rounds** — the existing MirrorMentor-X simulator, Full Interview Loop, Coach Analytics,
  MirrorMentor Advanced Coaching and Elevator Pitch Analyzer, mounted completely unchanged.
- **Project Reviewer** *(new)* — profile your project (or upload a README/report PDF), pick a review
  panel (Internal Guide, External Examiner, Industry Architect, Devil's Advocate), get a desk review
  (9-dimension rubric, risk flags, likely questions) and/or a live Q&A with cross-questioning, then a
  verdict, action plan, PDF and Markdown report. Stage-aware (Review-0 … Final Review).
- **Viva Voce** *(new)* — adaptive oral exam: subject viva (10 subjects, 80 built-in questions),
  project viva, or mixed. Spoken questions, timed answers, hints, cross-questions, revision deck, PDF.
- **Insights** *(new)* — readiness score, trends across all modes, project-rubric radar, viva subject
  mastery, next-best-actions and a 7-day plan.

Everything works offline with local heuristics; with an AI provider configured, questions and grading are
AI-generated. Only text you typed/dictated is sent, wrapped as untrusted input. Results are stored on-device
(`mockHubHistory_v1`, `mockHubProject_v1`) and synced via `CP_syncResult` as `INTERVIEW` results.
A small app-wide UI polish layer (`<style id="mis-ui-polish">`) was also added.

## New: AI Tools tabs — full parity upgrade (Predictor, Resume Match, Interview, MirrorMentor, Skill Gap)

All five **AI Tools** tabs now follow one consistent pattern — persisted history, peer
percentile benchmarking, and (where applicable) a real algorithmic layer, not just an LLM
call:

- **AI Placement Predictor** (Readiness Forecast) — now fits an ordinary-least-squares
  linear regression over your logged readiness snapshots (client-side, zero dependencies)
  to report a trend direction, a projected next score, and an R² fit-quality number, which
  is also fed to the LLM as quantitative context for its narrative forecast. Every snapshot
  and forecast now saves to your account (`PLACEMENT_PREDICTION` result type) and shows
  peer-percentile benchmarking.
- **MirrorMentor-X** (live webcam coaching) and the **Elevator Pitch Analyzer** now both save
  to the same shared `MIRROR_MENTOR` result type and show peer benchmarking, so text-pitch
  practice and live mock sessions build one combined trend line.
- **Resume-JD Matcher**, **AI Mock Interview**, and **Skill Gap Analyzer** already had this
  (semantic embedding similarity, multi-turn adaptive interview + competency rubric, and
  live market-intelligence radar, respectively, via `ai-ml-service/`) — unchanged.

## New: accounts & saved results (backend)

`backend/` now ships a Prisma schema (`backend/prisma/schema.prisma`) for Postgres with:

- **`User`** — email/password (bcrypt-hashed) accounts, `STUDENT`/`ADMIN` role.
- **`RefreshToken`** — short-lived JWT access tokens (15m default) + long-lived, hashed,
  rotating refresh tokens (30d default) — a leaked-but-unused refresh token becomes useless
  the moment the real owner refreshes once, and "log out of all devices" is a real DB
  operation, not just clearing localStorage.
- **`Result`** — one flexible table (JSON payload + a few indexed summary columns) for every
  quiz, mock-interview, roadmap, radar, resume-analysis, **placement-prediction, and
  MirrorMentor** result a student saves. `ResultType` now has 7 values (was 5) —
  `PLACEMENT_PREDICTION` and `MIRROR_MENTOR` were added so the **AI Placement Predictor**
  (Readiness Forecast) and **MirrorMentor-X** tabs get the exact same persistence + peer
  benchmarking treatment the other three AI Tools tabs already had. Run the included
  migration (`backend/prisma/migrations/20260912000000_add_predictor_mirrormentor_result_types`)
  or `npx prisma migrate deploy` to apply it to an existing database.

New endpoints (all under the same Express app, same port, same deployment as `/api/ai`):

| Route | What it does |
|---|---|
| `POST /api/auth/register` / `/login` | Create an account / sign in |
| `POST /api/auth/refresh` | Exchange a refresh token for a new access token (rotates it) |
| `POST /api/auth/logout` | Revoke one session, or all sessions (`allDevices: true`) |
| `GET /api/auth/me` / `PATCH /api/auth/me` | Read/update the logged-in profile |
| `POST /api/results` | Save a result (`type`, `topic`, `summaryScore`, `summaryLabel`, `payload`) |
| `GET /api/results` | List the logged-in user's own saved results |
| `GET /api/results/dashboard` | Per-type counts + score trend, powers "My Progress" |
| `GET /api/results/peer-stats` | **Anonymized** score list for a type/topic — no names or IDs — feeds the AI/ML service's new Peer Benchmarking endpoint |
| `DELETE /api/results/:id` | Delete a saved result |

Set up locally:

```bash
cd backend
cp .env.example .env
# fill in DATABASE_URL (a local/managed Postgres), JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
npm install                 # postinstall runs `prisma generate` automatically
npx prisma migrate dev      # creates the tables
npm start
```

Any Postgres works — a local instance, or a managed one (Neon, Railway, Render).

## New: Account widget (frontend)

A small, **independently-mounted** React root (its own `ReactDOM.createRoot`, entirely
separate from the main app's component tree — zero risk to any existing feature or state)
appears as a "Sign in" pill in the top-right corner. It talks to the endpoints above using
the *same* Settings → AI Providers → Secure Backend URL already configured for `/api/ai`
(blank = same-origin). Once signed in:

- A few existing flows automatically save their result in the background via a single
  `window.CP_syncResult(type, topic, score, label, payload)` call — currently wired into the
  **Quiz** tab, the **Adaptive Diagnostic** report, the **Skill Gap AI Roadmap**, and the
  **Market Radar** — silently, and only for logged-in users; logged-out visitors see zero
  change in behavior anywhere in the app.
- The widget's panel shows a live "My Progress" summary (count + best score per result type).

## What's new — AI/ML Intelligence Layer (ai-ml-service/)

Two genuinely **new** capabilities, plus the existing three advanced features each got a
further deepening on top of what they already had:

- **NEW — AI Career Path Predictor** (`/career-path/*`): ranks a curated set of career
  archetypes (Backend Engineer, Data Scientist, DevOps, PM, Security Analyst, …) against a
  student's current skills / adaptive-engine mastery by weighted overlap, returning each
  match's own week-by-week milestone plan. Works fully offline; adds a short LLM rationale
  on top of the #1 match when a provider key is configured.
- **NEW — Peer Percentile Benchmarking** (`/benchmark/percentile`): now that results persist
  in Postgres, this turns an anonymized score list (`GET /api/results/peer-stats`) into a
  percentile, z-score, decile, and histogram — "where do I actually stand?" for any quiz,
  diagnostic, roadmap, or radar result.
- **Deepened — Adaptive Diagnostic Engine**: `POST /adaptive/mastery/freshness` applies a
  spaced-repetition-style forgetting curve to saved per-topic theta values, so a diagnostic
  from a month ago is flagged as stale instead of trusted forever.
- **Deepened — AI Mock Interviewer**: `POST /interview/analyze/rubric` recombines the
  existing linguistic + LLM feedback into a 4-competency breakdown (Communication, Technical
  Depth, Problem Solving, Confidence) — no extra LLM call, reuses `/analyze`'s own output.
- **Deepened — Skill Gap & Market Intelligence Radar**: `GET /market/heat-index?role=...`
  ranks a role's overall market "heat" against every other role in the dataset.

Full endpoint list: `ai-ml-service/README.md`.


## Why this change

The original file called the LLM provider straight from the browser using a key stored in
`localStorage`. Anyone could open devtools → Application → Local Storage and copy a working
API key out of any visitor's browser. Moving the call to a backend means:

- the real API key never reaches the browser,
- you can rate-limit and monitor usage centrally,
- you can switch providers/models in one place (`.env`) without touching the frontend,
- the frontend still supports "bring your own key" mode for anyone who prefers it (Settings →
  AI Providers → pick Claude/Gemini/OpenAI instead of "Secure Backend"). This BYOK OpenAI
  option is a separate, unchanged frontend feature — it's independent of which provider the
  *secure backend* itself defaults to (see below: the backend now defaults to Groq instead of
  OpenAI, but a student/admin can still type in their own personal OpenAI key if they want to
  bypass the backend entirely).

## Run it locally

```bash
cd backend
cp .env.example .env
# edit .env and set AI_PROVIDER=groq and GROQ_API_KEY=gsk_...
# (or AI_PROVIDER=gemini and GEMINI_API_KEY=..., or AI_PROVIDER=claude and ANTHROPIC_API_KEY=sk-ant-...)
#  — default priority is Groq first; if it fails, requests auto-shift to Gemini, then Claude.
#  Set more than one key and the backend will auto-fallback between them in that order.
npm install
npm start
# -> AI backend proxy listening on http://localhost:8787
```

Then open `frontend/index.html` in a browser (or serve it with any static file server), and
in **Settings → AI Providers**, set the **Secure Backend URL** to `http://localhost:8787`.
Leave it blank instead if you serve the frontend *from* the same backend (see below) — then
calls default to same-origin `/api/ai`.

## Serving the frontend from the backend (single deployment)

Add this to `backend/server.js` (or ask me to wire it in) to serve `frontend/` as static files
from the same Express app, so one deployment (one URL, one process) handles both the UI and
the AI proxy, and the Settings → Backend URL field can stay blank:

```js
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'frontend')));
```

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS, etc.):

1. Push this project to a git repo.
2. Deploy the `backend/` folder as a Node web service. Set the environment variables from
   `.env.example` in the host's dashboard (never commit your real `.env`).
3. Deploy `frontend/index.html` as a static site (or serve it from the same backend as above).
4. In the deployed frontend, set Settings → AI Providers → Secure Backend URL to your backend's
   public URL (skip this if serving both from the same origin).

## What's new — three advanced AI/ML features, now embedded in their own tabs

These used to live behind a separate floating **"AI/ML Tools+"** button. They're now embedded
directly in the tab each one belongs to (the floating button has been removed), and each got a
genuinely new capability on top of what it had before. All three activate once
**Settings → AI/ML Intelligence Service URL** is set — still a pure addition, gated entirely on
that URL, so nothing already built had to change:

1. **Adaptive Skill Diagnostic Engine** — now on the **Quiz** tab. A real-time-adjusting quiz
   (IRT/Rasch ability model): gets harder or easier after every answer, converges on a per-topic
   skill level (Beginner → Expert) in as few questions as possible, and escalates into an
   AI-graded coding challenge once you're doing well in a topic. **New:** the final report now
   plots your full ability trajectory (θ) across every answer in the session as a chart, not just
   the end-state per-topic numbers. See `POST /adaptive/session/*` in `ai-ml-service/`.
2. **AI Mock Interviewer with NLP/Speech Analysis** — now on the **Interview** tab. A multi-turn
   adaptive interview where every answer is scored for filler-word rate, hedging language,
   speaking pace (WPM), sentiment/confidence, STAR structure, and technical depth, with the next
   question adapting to probe your weakest point. **New:** a live, debounced linguistic read-out
   (filler/hedge/confidence) updates *while you type* your answer, before you submit — using the
   cheap no-LLM-call `POST /interview/analyze/linguistic` endpoint — plus a confidence-across-turns
   chart on the summary screen. See `POST /interview/session/*`.
3. **Skill Gap & Market Intelligence Radar** — now on the **Skill Gap** tab, alongside the
   existing Actionable Weekly Roadmap. Shows exactly which in-demand skills you're missing for a
   target role, ranked by market demand (a curated dataset by default, optionally blended with
   live Adzuna/JSearch job-posting data). **New:** a role autocomplete (`GET /market/roles`), a
   cross-role "Trending Skills Right Now" section (`GET /market/trending`), and a market-demand-
   vs-your-coverage dual chart built from the radar response's `radar_chart` data. See
   `POST /market/radar`.

All three run entirely offline off deterministic/curated logic when no LLM or live-data key is
configured, so they're always demoable, and degrade gracefully to richer AI-backed output once
keys are added. Full details: `ai-ml-service/README.md`.

**Also fixed:** the page's Content-Security-Policy `connect-src` previously only allow-listed a
handful of named AI-provider hosts, which silently blocked `fetch()` calls to whatever URL you
type into Settings → AI/ML Intelligence Service (e.g. `http://localhost:8000` or your own deployed
host) — so these panels, and the existing Resume-JD/Roadmap ones, could never actually reach the
service. `connect-src` now also allows any `https:` origin plus `http://localhost:*` /
`http://127.0.0.1:*` for local development.

## What's new — Advanced AI/ML Intelligence Layer (ai-ml-service/)

A new **FastAPI microservice** (`ai-ml-service/`) adds the heavier AI/ML capabilities that
go beyond a simple LLM-proxy: real resume/JD parsing (PyPDF2 + spaCy), actionable week-by-week
career roadmaps ("build this specific project next week", not a passive dashboard), semantic
(vector) skill matching pluggable across FAISS/Qdrant/Pinecone, and Whisper speech-to-text for
mock interviews. See **`ai-ml-service/README.md`** for full details and setup.

This is a pure addition — `frontend/index.html`'s existing features and `backend/` are
unchanged. The three new panels (Skill Gap → Actionable Weekly Roadmap, Resume-JD → Semantic
Vector Match, Mock Interview → Whisper record button) only activate once you set
**Settings → AI/ML Intelligence Service URL**; until then everything behaves exactly as before.



The frontend and its API contract (`POST /api/ai`, `POST /api/ai/stream`) are **unchanged** —
every existing feature keeps working exactly as before with zero frontend edits. What changed
is that `backend/server.js` is now a much sturdier LLM proxy:

| Improvement | What it does |
|---|---|
| **Backend provider: Groq (instead of OpenAI)** | The secure backend now talks to **Claude, Groq, or Gemini** (was Claude/OpenAI/Gemini). Groq uses an OpenAI-compatible API, so it gets the same JSON-mode, streaming, retry, and fallback support. Set `GROQ_API_KEY` in `backend/.env`. |
| **Real streaming for all providers** | Groq and Gemini now stream token-by-token via SSE, same as Claude. Previously non-Claude providers faked streaming by sending the whole answer as one chunk. |
| **Automatic fallback in any direction** | Whichever provider is set as default (e.g. Gemini) — if it fails or errors, the backend automatically shifts to the next configured provider (e.g. Groq, then Claude) with no user-visible interruption. |
| **Automatic provider fallback** | If the requested/default provider fails (rate limit, outage, timeout), the backend automatically retries on any *other* provider you've configured a key for, before giving up. |
| **Retries with backoff + timeouts** | Each provider call gets a request timeout (`AI_REQUEST_TIMEOUT_MS`) and up to `AI_MAX_RETRIES` retries with exponential backoff on transient errors (429s, 5xxs, timeouts). |
| **Response caching** | Identical `(systemPrompt, userPrompt, opts)` calls within `AI_CACHE_TTL_MS` are served from an in-memory cache instead of hitting the provider again — faster and cheaper for repeated actions like ATS scoring. Pass `opts.noCache: true` to bypass it for a specific call. |
| **JSON-mode self-repair** | If `opts.jsonMode` is set but the model's output isn't valid JSON, the backend automatically retries once with a stricter "JSON only" instruction before giving up. |
| **Guardrails** | Requests are rejected above `AI_MAX_PROMPT_CHARS`, and obvious prompt-injection patterns (e.g. "ignore previous instructions", "reveal your system prompt") are flagged in the logs for review. |
| **Structured logging** | Every request gets a short request ID; logs show provider used, latency, retries, fallbacks, and errors. |
| **`GET /api/usage`** | Simple in-memory counters: total requests, errors, cache hits, and per-provider usage — handy for a quick usage dashboard. |
| **Startup validation** | The server warns clearly on boot if no API key is configured, or if `CORS_ORIGIN` is left as `*` in what looks like production. |
| **Graceful shutdown** | Responds correctly to `SIGINT`/`SIGTERM` (important for containerized deployments). |

New optional environment variables (all have sensible defaults — see `.env.example`):
`AI_REQUEST_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_MAX_PROMPT_CHARS`, `AI_CACHE_TTL_MS`, `AI_CACHE_MAX_ENTRIES`.

## What still works exactly as before

Every existing feature — Resume-JD AI Analysis, Mock Interview AI grading, AI ATS Score &
Keyword Optimizer, the Ask AI assistant (streaming), speaker-note generation, code hints, etc.
— calls the same `callAiProvider` / `callAiProviderStream` functions as before. Only their
internals changed to prefer the secure backend; students never need to paste an API key
anymore (the "Secure Backend" provider is the default), and Admins can still switch to a
bring-your-own-key provider per-browser if they want to bypass the backend for testing.

## New: Explainable AI layer — "why this recommendation?" (ai-ml-service/)

`ai-ml-service/app/services/explainability.py` adds a shared, honest explanation builder used
by two existing recommendation surfaces:

- **Career Path Predictor** (`POST /career-path/predict`) — each returned match now includes an
  `evidence` object with the *exact* arithmetic decomposition of its confidence score (60% core-skill
  coverage + 40% average mastery on matched skills, +15 flat for a stated-interest match), plus
  caveats about which mastery values are unverified defaults vs. real Adaptive Diagnostic results.
- **Skill Gap & Market Intelligence Radar** (`POST /market/radar`) — the response now includes
  `top_priority_skill_evidence`: why that specific missing skill was surfaced first (its market-demand
  percentile among the role's whole skill set, its rank among your other gaps, and its growth trend),
  with a caveat that demand scores reflect posting frequency, not a guaranteed outcome.

This deliberately does **not** use SHAP/LIME-style approximation: both underlying scores are simple,
fully-known formulas (a weighted sum, a sorted rank), so an exact factor breakdown is both possible and
more honest than an approximation technique built for genuinely opaque models. If a trained/black-box
model is added later, the `Evidence`/`Factor` dataclasses are designed to stay the same shape while the
builder function swaps to a real SHAP explainer.

Frontend: both panels (Skill Gap → Career Path Predictor, Skill Gap → Market Intelligence Radar) now
render a collapsible **"Why this recommendation?"** disclosure (`WhyThisRecommendation` component,
`frontend/index.html`) showing the factors and caveats — collapsed by default so it adds zero clutter
to the existing UI.

## New: Sequential Decision Engine — contextual bandit for "what to practice next" (backend/)

Spec §15 asks for a full RL/sequential-decision engine over actions = {video, quiz, coding,
revision, interview, project}. Today only ONE of those actions is reward-instrumented (the
Adaptive Diagnostic writes a real `pKnowAfter` to `LearningEvent` per graded response) — per
the project's own rule #33/#15 escape hatch ("if full RL isn't justified, implement a
contextual bandit and document the decision"), this is scoped and documented accordingly:

- **`backend/src/services/banditEngine.js`** — a pure, dependency-free **LinUCB contextual
  bandit** (Li et al., 2010) with a single model shared across arms (documented reasoning for
  why disjoint per-arm models don't fit this data regime inline). Includes its own
  from-scratch matrix inversion (Gauss-Jordan) — no numerical library needed for a 6x6.
- **`backend/src/services/banditEngineRepo.js`** — builds real context features (current
  mastery, practice volume, prerequisite coverage from the Knowledge Graph, category
  weakness) and real reward examples (from `LearningEvent.pKnowAfter`) for every candidate
  skill, then calls the pure algorithm. Candidates are exactly the skills the Knowledge Graph
  says are unblocked (all prerequisites already mastered) and not yet mastered — recommending
  a blocked skill wouldn't be actionable, so it's excluded from the arm set entirely.
- **`backend/src/services/recommendationEvidence.js`** — turns the bandit's pick into the
  same `Evidence`/`Factor` shape the Python Explainable-AI layer uses, so the frontend's one
  `WhyThisRecommendation` component renders either.
- **`GET /api/twin/next-recommendation`** (new route in `twin.js`) — returns the pick +
  evidence for the logged-in user. Falls back to an explicit, labeled cold-start heuristic
  (rank by prerequisite coverage only) when the student has zero graded attempts yet, rather
  than showing a fabricated confidence number from an untrained model.
- **Frontend**: Dashboard → Student Digital Twin now shows an "AI Recommended Next Skill"
  card with the bandit's pick and its Why-this-recommendation disclosure.

Tests: `backend/tests/banditEngine.test.js` (pure algorithm — matrix ops, cold-start
fallback, and that a feature profile with consistently higher observed reward actually scores
higher after fitting) and `backend/tests/_manual_integration_check_bandit.js` (an in-memory
Prisma mock verifying candidate filtering by mastery/prerequisites end-to-end, following the
same pattern as `_manual_integration_check.js`).


## Upgrade — Phase 1: Advanced Design System & Shell

- Added an additive design-system layer for the existing single-file React application: shared surface, border, elevation, focus-ring, radius and responsive tokens.
- Upgraded existing cards, inputs, tables and navigation states without changing routes, tabs, state keys, API contracts or feature logic.
- Added stronger keyboard focus treatment and an accessible skip-to-application link.
- Added a first-paint system dark-mode preference only when `TNP_DARK_MODE` has never been set; the existing preference key remains unchanged.
- Added mobile touch-target safeguards and reduced-motion behavior.
- Added a small runtime guard against interaction with controls already marked `aria-busy`; no feature is disabled by default.
- No new top-level tab, route, database field, backend endpoint, or AI dependency was introduced in this phase.

### Phase 1 QA

- Existing `frontend/index.html` remains the single deployable frontend file.
- Existing Striver A2Z, Solve Mode/Judge, AI pair programmer, AI Video Tutor, MirrorMentor-X, Project Reviewer, Viva, Digital Twin and Gate Pass code paths were not removed or renamed.
- The phase is presentation/accessibility focused; feature-level changes remain for subsequent in-place tab upgrades.


## Gate Pass — cross-device QR scanning (Phase 4 hardening)

Gate Pass QR codes now encode an absolute, device-independent verification URL. On a
normal public deployment, the current HTTPS origin is detected automatically. The
verification page is intentionally login-free so a guard can scan from any phone,
tablet, or laptop that can reach the portal.

For localhost/LAN development, `localhost` cannot be opened by another physical device.
Set `window.TNP_PUBLIC_BASE_URL` to the portal URL reachable by the gate device (prefer
HTTPS), or use the included `frontend/gate-pass-public-config.example.js` as the
deployment template.

The QR redemption remains server-authoritative and single-use. The PostgreSQL
`frontend/gate-passes-atomic-redeem.sql` migration must be applied so concurrent scans
are serialized by the database and a used QR can never be restored by a stale client.

## Gate Pass cross-device verification
See `GATE_PASS_CROSS_DEVICE_SETUP.md`. New QR codes open the lightweight `frontend/gate-pass-verify.html` page and are atomically consumed server-side, so one scan expires the pass globally across devices.


## Complete Supabase removal — PostgreSQL/Prisma migration

This build removes the portal's runtime dependency on Supabase. Persistent application data now follows:

**Frontend → Express → Prisma → PostgreSQL**

The browser does not load a database SDK, does not contain a database credential, and does not call a hosted database service directly.

### 1. PostgreSQL setup

Create a PostgreSQL database and copy the environment template:

```bash
cd backend
cp .env.example .env
```

Set at least:

- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `PORTAL_ADMIN_EMAIL`
- `PORTAL_ADMIN_PASSWORD`
- `PORTAL_ADMIN_NAME`
- the existing AI/voice provider keys required by the features you use (`GROQ_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `TEACHER_VOICE_ID`, etc.)

Never commit `backend/.env`.

### 2. Install and migrate

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate deploy
```

The new migration is additive. It adds:

- `PortalKV` — replacement for the legacy `remoteGet/remoteSet/remoteList/remoteDelete` persistence layer.
- `CampusRecord` — PostgreSQL/JSONB adapter for the existing campus data tables while preserving their row fields.
- `GatePass` — typed/indexed gate-pass state used for server-side atomic QR redemption.
- additional profile/authentication fields on `User`.

Existing `Result`, `RefreshToken`, Digital Twin, Knowledge Graph and AI service models remain in the same Prisma/PostgreSQL architecture.

### 3. Start the backend

```bash
npm start
```

Express serves the frontend as well as `/api/*` when deployed from this repository.

### 4. Administrator bootstrap

The portal calls `POST /api/portal-auth/bootstrap-admin` during startup/login initialization. The backend creates the first admin only when `PORTAL_ADMIN_EMAIL` and `PORTAL_ADMIN_PASSWORD` are configured and no user exists for that email.

The bootstrap password is therefore **not shipped in `frontend/index.html`**.

### 5. Authentication

Portal registration, login, Face ID login, fingerprint/WebAuthn login, refresh, logout, password recovery, profile updates and role handling use Express + Prisma. Passwords are bcrypt-hashed server-side. Access tokens are short-lived JWTs; refresh tokens are stored hashed and rotated/revocable.

Legacy account records can still be represented in `PortalKV` during an import. New passwords are always stored using bcrypt.

### 6. Gate-pass verification

QR codes open `frontend/gate-pass-verify.html` and call:

```text
POST /api/gate-passes/public/redeem
```

No login and no database credential are required on the guard device. The backend performs a conditional PostgreSQL update:

```text
id + qrToken + approved + qrUsed=false + not expired
        ↓
set qrUsed=true and qrUsedAt=NOW()
```

Only the first concurrent request can update the row. A second device receives `already_used`, so the used/expired state is global rather than tied to the scanning browser.

For a separately hosted verifier, set `window.TNP_BACKEND_URL` in `frontend/gate-pass-public-config.js`. For QR codes that must be reachable outside the local machine, set `window.TNP_PUBLIC_BASE_URL` to the public HTTPS portal URL.

### 7. Realtime replacement

The old hosted realtime channel is replaced by the existing frontend polling mechanism over Express APIs. Gate-pass usage and other shared state are refreshed from PostgreSQL every few seconds where the UI previously depended on cross-device updates. This keeps the behavior cross-device without introducing another hosted realtime service.

### 8. Storage replacement

The repository's logical storage API is now `backend/src/routes/storage.js`:

- `GET/PUT/DELETE /api/storage/kv`
- `GET /api/storage/kv/list`
- `GET/POST/PUT/DELETE /api/storage/data/:table...`

Private values are associated with the authenticated PostgreSQL user. Shared values use the server-owned `PUBLIC` scope. Campus table rows are persisted in PostgreSQL through Prisma.

### 9. Existing data migration

If an export of the old persistence data is available, use the included SDK-free importer:

```bash
cd backend
node scripts/import-postgresql-export.js /path/to/portal-export.json
```

The importer accepts `users`/`accounts`, `kv`/`tnp_kv`, campus table arrays or `campusRecords`, and `gatePasses`/`gate_passes`. It preserves gate-pass IDs/tokens/statuses and legacy account password metadata for controlled migration/reset.

No destructive migration is run automatically. The PostgreSQL migration does not `DROP`, `TRUNCATE`, or overwrite unrelated existing tables.

### 10. Verification

Static checks performed for this migration include:

```bash
node --check frontend/index.html   # use the main inline script extraction when checking the single-file app
cd backend
node --check server.js
node --check src/routes/*.js
npx prisma validate
```

In an environment with dependency installation/network access, also run:

```bash
npm test
npm run prisma:generate
npm run prisma:deploy
```

Then verify authentication, campus data, AI routes, cross-device persistence and the gate-pass two-device sequence.

### Migration report

- **Supabase dependencies found:** browser Supabase JS client, Supabase Auth, direct table access for campus data, the `tnp_kv` persistence layer, gate-pass table/RPC/SQL references, Supabase Realtime polling/subscription hooks, Supabase configuration/CSP entries, and Supabase-specific environment/configuration references.
- **Replaced with:** Express API routes backed by Prisma/PostgreSQL; a `PortalKV` model; a `CampusRecord` model; a first-class `GatePass` model; Express/JWT/bcrypt authentication; and server-side authorization/persistence.
- **New PostgreSQL models:** `PortalKV`, `CampusRecord`, `GatePass`; plus required existing `User` profile fields and role enum values.
- **New/modified API endpoints:** `/api/storage/*`, `/api/gate-passes/*`, `/api/portal-auth/*`, while existing `/api/auth/*`, `/api/results/*`, `/api/graph/*`, `/api/twin/*`, `/api/voice/*` and `/api/ai*` remain available.
- **Authentication:** Supabase Auth removed; Express/Prisma authentication is authoritative, with bcrypt passwords, JWT access tokens and rotating hashed refresh tokens.
- **Gate pass:** public login-free verifier, server-side conditional redemption, global one-time consumption, and concurrency-safe PostgreSQL state.
- **Realtime:** replaced by controlled API polling; no Supabase Realtime dependency remains.
- **Storage:** logical upload/data persistence remains behind Express; Supabase-specific storage/database calls are removed.
- **Environment:** all `SUPABASE_*`, `VITE_SUPABASE_*` and hosted Supabase URL/key requirements are removed. Backend secrets remain server-side.
- **UI/features:** no new application tab was introduced for the migration; the existing portal structure and feature paths remain in place.
- **Validation status:** JavaScript syntax checks and repository-wide runtime Supabase-reference search pass. Full npm/Prisma execution could not be completed in this environment because dependency installation timed out; this is explicitly not being reported as a successful build/test run.

## Production hardening in this build

This build keeps PostgreSQL + Prisma as the authoritative persistence layer and removes the remaining security-sensitive client-side recovery flow. In particular:

- Production startup validates `DATABASE_URL`, distinct strong JWT secrets, explicit CORS origins, and server-side recovery delivery configuration.
- Refresh sessions use an HttpOnly cookie; refresh tokens are still opaque, random, hashed in PostgreSQL, rotated, revoked on logout/reset, and reuse of a revoked replacement token revokes the user's active refresh sessions.
- Password recovery codes are generated and hashed only by the backend, expire after 10 minutes, are single-use, rate-limited, attempt-limited, compared in constant time, and never returned in production responses.
- Shared account records never persist password hashes/salts in the generic `PortalKV` store. Non-admin users cannot change their own role through that legacy synchronization path.
- Gate-pass QR tokens are server-generated cryptographically random values, and redemption remains a PostgreSQL conditional update so concurrent scans can redeem a pass only once.
- Production CORS is explicit and credential-aware; security headers, request IDs, generic API errors, graceful shutdown, and additional rate limits are enabled without reintroducing Supabase.
- AI provider credentials remain backend-only. AI provider failures return safe generic client messages while detailed diagnostics stay server-side.

### Production environment

Copy `backend/.env.example` to a deployment-specific environment file and provide real values through the hosting platform's secret manager. Do not commit `.env` files or real credentials. Password recovery requires the server-side `RECOVERY_EMAILJS_*` variables in production.

### Validation performed on the source package

- Repository-wide executable Supabase reference scan: passed.
- Backend JavaScript syntax checks: passed.
- Static security regression checks: passed.
- Repository secret-pattern scan: no obvious live API/private-key credential patterns found.
- Full dependency installation / Prisma execution could not be completed in this environment because `npm install` timed out; therefore a live PostgreSQL migration/test run is not claimed as completed here.

## Final production hardening (September 2026)

This build adds a targeted hardening pass without removing application tabs or replacing working business logic. The Resume tab was not intentionally refactored.

### Security/runtime changes
- HttpOnly `cp_access` session cookie support added while retaining bearer-token compatibility for existing clients.
- Refresh-token rotation remains enabled.
- Production CORS requires explicit HTTPS origins.
- Production CSP uses per-response nonces for the existing inline JavaScript instead of enabling `unsafe-inline` for scripts.
- Security headers include HSTS (production), frame protection, referrer policy, Permissions Policy, COOP/CORP, and `nosniff`.
- `/api/health/runtime`, `/api/health/runtime/deep`, `/api/health/metrics`, and `/api/usage` are protected by `OPERATIONS_TOKEN` in production.
- FastAPI AI/ML traffic can be routed through the authenticated Express `/api/ai-ml/*` gateway. Express injects `AI_ML_SERVICE_TOKEN`; the FastAPI service validates it in production.
- Production startup now requires `AI_ML_SERVICE_TOKEN` and `OPERATIONS_TOKEN` in addition to the existing production secrets.
- Generic API error handling/request IDs remain in place; internal provider/stack details are not returned to clients.
- Repository cleanup removes Python bytecode/cache/log artifacts and extends `.gitignore` coverage.

### Required production variables
See `backend/.env.example` for placeholders. In production configure at minimum:
`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGIN`, `AI_ML_SERVICE_TOKEN`, `OPERATIONS_TOKEN`, and the existing password-recovery variables. Configure `AI_ML_SERVICE_URL` to the private FastAPI service address.

### Validation performed
- Backend JavaScript syntax checks: passed.
- Existing backend regression tests: passed (security, knowledge graph, digital twin, bandit engine, teacher voice).
- AI/ML pytest suite: 36 passed.
- New final hardening static checks: passed.
- AI/ML application import check: passed.
- Dependency installation/audit was attempted, but the package-manager operation exceeded the execution environment timeout; it is not represented as a completed vulnerability audit.
