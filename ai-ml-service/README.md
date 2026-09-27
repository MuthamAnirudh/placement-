# AI/ML Intelligence Service (FastAPI)

The "advanced AI/ML layer" for the Campus A-Z Placement Training Portal. This is a
**separate, additive** service — it does not replace or modify `backend/` (the existing
Express secure LLM proxy) or anything in `frontend/index.html`'s existing features. It only
adds new capabilities that the frontend calls **when you configure its URL** in
**Settings → AI/ML Intelligence Service**. Every feature that uses it has a working
fallback when it isn't configured, so nothing that worked before stops working.

## What it adds

| Endpoint | Capability |
|---|---|
| `POST /parse/resume` | Upload a PDF/DOCX resume → structured JSON: contact info, extracted skills (spaCy + curated vocab), sections, and optional LLM enrichment (experience level, top projects, red flags) |
| `POST /parse/jd` | Extract skills from a pasted job description |
| `POST /roadmap/generate` | **The "Intelligence" feature**: turns a skill gap into a week-by-week plan that names a *specific project to build* each week, not just topics to study, plus resume-bullet phrasing for each week's output |
| `POST /match/resume-jd` | Semantic (embedding-based) similarity between a resume and a JD — catches paraphrased/synonymous skills that plain keyword matching misses |
| `POST /match/index` + `POST /match/search` | Vector semantic search across indexed student/recruiter profiles (FAISS locally by default; swap to Qdrant or Pinecone with one env var, zero code change) |
| `POST /interview/transcribe` | Whisper speech-to-text for mock interview answers — works in any browser (unlike the existing browser-only SpeechRecognition), more accurate for accented speech |
| `POST /interview/analyze` | **AI Mock Interviewer — NLP/speech analysis**: filler-word & hedge-language rate, pace (WPM), lexicon-based sentiment/confidence score, plus LLM-backed STAR-structure check, technical-depth score, and an adaptive follow-up question |
| `POST /interview/analyze/linguistic` | Cheap, no-LLM-call variant of the above for live/real-time scoring while the candidate is still speaking |
| `POST /interview/session/start` + `POST /interview/session/respond` | Multi-turn adaptive mock interview: each answer is evaluated and the next question adapts to probe the weakest part of the previous answer, ending in a session summary |
| `GET /adaptive/topics`, `POST /adaptive/session/start`, `POST /adaptive/session/answer`, `POST /adaptive/session/coding-submit`, `GET /adaptive/session/{id}/report` | **Adaptive Skill Diagnostic Engine**: an IRT/Rasch-model adaptive quiz that raises or lowers question difficulty in real time based on correctness, converges on a per-topic ability estimate (theta) mapped to Beginner→Expert, and escalates into an LLM-graded coding challenge once a topic's ability rises into medium/hard territory |
| `GET /market/roles`, `POST /market/radar`, `GET /market/trending` | **Skill Gap & Market Intelligence Radar**: compares a candidate's skills against a target role's market-demand profile (curated dataset, optionally blended with live Adzuna/JSearch job-posting data) and returns exactly which high-demand skills are missing, ranked by priority |

### New in this release

| Endpoint | Capability |
|---|---|
| `GET /career-path/archetypes`, `POST /career-path/predict` | **NEW — AI Career Path Predictor**: scores a curated set of career archetypes (Backend Engineer, Data Scientist, DevOps, PM, Security Analyst, …) against a student's current skills / adaptive-engine mastery by weighted skill overlap, returning ranked matches each with their own week-by-week milestone plan. Fully offline by default; adds a short LLM rationale on the #1 match when a provider key is configured. |
| `POST /benchmark/percentile` | **NEW — Peer Percentile Benchmarking**: pure statistics (percentile, z-score, decile, histogram) over an anonymized peer score list. Pairs with the backend's new `GET /api/results/peer-stats` (no names/IDs, just numbers) now that results persist in Postgres. Stateless — never talks to the database itself. |
| `POST /adaptive/mastery/freshness` | **Deepens the Adaptive Diagnostic Engine**: applies a spaced-repetition-style forgetting curve to a batch of saved per-topic theta values, flagging which are stale and worth re-testing instead of trusting an old snapshot forever. |
| `POST /interview/analyze/rubric` | **Deepens the AI Mock Interviewer**: recombines `/interview/analyze`'s existing output into a 4-competency rubric (Communication, Technical Depth, Problem Solving, Confidence) with no extra LLM call. |
| `GET /market/heat-index?role=...` | **Deepens the Market Intelligence Radar**: a single comparable "how hot is this role right now" score, ranked against every other role in the dataset (e.g. "#3 of 12 roles"). |
| `POST /match/resume-jd/explain` | **NEW — Explainable Competency Matching**: upgrades `/match/resume-jd` from one opaque similarity number into a per-skill matched/partially-matched/missing breakdown with evidence and confidence for each skill. Feed `matched_skills` into the backend's `POST /api/twin/sync-resume-match` to record them on the Student Digital Twin. |
| `POST /interview/session/respond/multimodal` | **NEW — Multimodal Interview Intelligence**: same adaptive session as `/interview/session/respond`, plus optional speech-prosody (pauses, pitch/monotone-delivery — DSP over the raw audio) and visual-behavior (face presence, posture stability, rough gaze-toward-camera — OpenCV Haar cascades) analysis when audio/video is attached. These are explicitly labeled behavioral indicators, never merged into the competency rubric or claimed as a measure of competence/honesty/personality. |
| *(internal)* `app/services/ai_reliability.py` | **NEW — AI Reliability / Hallucination Detection layer**: wired into `/career-path/predict`'s LLM rationale (as `rationale_reliability`) and `/roadmap/generate`'s `priority_gap` (as `priority_gap_reliability`). Extracts each claim, checks it against the known facts already computed for that request (proper-noun/figure matching + lexical overlap + embedding similarity), and reports a groundedness score — it never edits or blocks the original text, only labels it. |

## Quick start (for the demo)

```bash
cd ai-ml-service
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m spacy download en_core_web_sm   # optional but recommended — improves skill extraction
cp .env.example .env
# Edit .env: set at least one of ANTHROPIC_API_KEY / GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY
uvicorn app.main:app --reload --port 8000
```

Then in the portal: **Settings → AI/ML Intelligence Service → URL** → `http://localhost:8000`.

Open `http://localhost:8000/docs` for interactive Swagger UI — the fastest way to demo the
API directly to judges even before wiring up the frontend.

## Why this design (judge-facing rationale)

- **Actionable over passive**: `/roadmap/generate` is deliberately schema-constrained so the
  model *cannot* return a generic topic list — every week must name a specific thing to build
  and a resume bullet for it. This is the "tells a student exactly what to build next week"
  requirement.
- **Working MVP over slide decks**: every endpoint has an offline/local fallback path
  (keyword-based skill extraction if spaCy's model isn't downloaded, a deterministic template
  roadmap if no LLM key is set, hashed embeddings if `sentence-transformers` can't reach the
  internet, local FAISS if no vector DB is configured) — so the whole thing still runs and
  demos end-to-end on a laptop with zero cloud accounts.
- **Data privacy**: resumes/PDFs are processed in memory and never written to disk unless you
  explicitly set `DATABASE_URL`; `PII_REDACTION_ENABLED` and `DATA_RETENTION_DAYS` in `.env`
  document the retention policy for the judge Q&A; CORS is locked down (`CORS_ORIGINS`) in
  production instead of the wildcard used for local dev; no third-party analytics/tracking.

## Running alongside the existing backend

You now have two backend processes for local dev:

```bash
# Terminal 1 — existing secure LLM proxy (Ask AI, ATS score, mock interview grading)
cd backend && npm install && npm start        # http://localhost:8787

# Terminal 2 — new AI/ML intelligence service (parsing, roadmap, semantic match, Whisper)
cd ai-ml-service && uvicorn app.main:app --reload --port 8000
```

Point the frontend at both in Settings: **Secure Backend URL** → `http://localhost:8787`,
**AI/ML Intelligence Service** → `http://localhost:8000`.

## Deploying

Any host that runs a Docker container or a plain Python process works (Render, Railway,
Fly.io, a VPS). A `Dockerfile` is included:

```bash
docker build -t campus-ai-ml-service .
docker run -p 8000:8000 --env-file .env campus-ai-ml-service
```

## New capabilities — how each degrades gracefully offline

- **Adaptive Skill Diagnostic Engine** (`/adaptive/*`): the ability-estimation math (Rasch/IRT
  1-parameter model) is pure Python stdlib — it needs zero ML packages and always works. Only
  the *coding-challenge grading* step calls an LLM; without a key it falls back to a heuristic
  length/structure check and clearly labels the grade as `offline-heuristic` in the response.
- **AI Mock Interviewer NLP layer** (`/interview/analyze`, `/interview/session/*`): filler-word
  rate, hedge-language rate, pace (WPM), and the lexicon-based sentiment/confidence score are
  all deterministic stdlib code — always available. The richer STAR-structure/technical-depth
  feedback and the adaptive follow-up question use an LLM when configured, and fall back to a
  template-based check (regex STAR detection, generic follow-up) otherwise.
- **Skill Gap & Market Intelligence Radar** (`/market/*`): runs entirely off the curated
  `data/market_skills.json` dataset by default — zero external calls, zero API keys needed.
  Set `MARKET_LIVE_PROVIDER=adzuna` (+ `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`) or
  `MARKET_LIVE_PROVIDER=jsearch` (+ `JSEARCH_RAPIDAPI_KEY`) in `.env` to blend in live
  job-posting skill-frequency data (60% live / 40% cached weighting); any live-provider error
  is caught and silently falls back to the cached dataset so a flaky API never breaks the demo.
- **Explainable Competency Matching** (`/match/resume-jd/explain`): pure numpy embedding
  similarity (the same fallback-capable embed() as `/match/resume-jd`) — always available,
  no extra deps.
- **Multimodal Interview Intelligence** (`/interview/session/respond/multimodal`): the text
  rubric is unchanged and always available. Speech-prosody analysis needs the `ffmpeg` binary
  on PATH (already added to the Dockerfile; install locally via your OS package manager);
  without it, `speech_prosody` comes back as `{"available": false, "reason": "..."}` instead
  of a fabricated number. Visual-behavior analysis needs `opencv-python` (in
  `requirements.txt`); without it, `visual_behavior` degrades the same honest way. Either or
  both can be omitted per-request — the session still works text-only.

## Swapping the vector backend (Pinecone / Qdrant / local FAISS)

Set `VECTOR_BACKEND=qdrant` or `VECTOR_BACKEND=pinecone` in `.env` plus the matching
`QDRANT_*` / `PINECONE_*` values — no code changes needed, all three backends implement the
same `upsert` / `query` interface (`app/services/matcher.py`). If the configured cloud
backend is unreachable at startup, the service automatically degrades to the local FAISS
index so a flaky venue wifi never breaks the demo.

## Notes on the tech-stack request

The originally requested stack (Next.js frontend, FastAPI *or* Django backend, LangChain,
Pinecone/Qdrant, Whisper, WebRTC) is only partially a drop-in replacement for what already
exists here: `frontend/index.html` is a mature, single-file React app (17,000+ lines,
dozens of working features built up over many iterations) and rewriting it into a
multi-file Next.js project is a large, separate undertaking with real risk of breaking
existing functionality — it was intentionally **not** done as part of this change, to honor
the standing "never remove a working feature" constraint on this project. This service adds
the FastAPI + LangChain-style LLM orchestration + Pinecone/Qdrant/FAISS + Whisper pieces of
that stack as a clean add-on instead. WebRTC (`getUserMedia`) was already present in the
frontend for the camera/mic features and mock interview.
