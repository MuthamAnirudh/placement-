# Striver A2Z Coding Integration

The supplied `striver-a2z-dsa-main.zip` is integrated into the existing **Skill Hub → Coding** area.

## What was added
- **No new top-level navigation tab.**
- Added a **Striver A2Z** subtab beside the existing Judge Practice and A-Z DSA Sheet controls.
- Integrated the supplied repository's problem/code files into the frontend so the feature can work as a standalone portal.
- Search by problem/file name and filter by Striver step.
- Original supplied solution viewer.
- Local completion/progress tracking using `TNP_STRIVER_A2Z_PROGRESS`.
- AI mentor actions grounded in the selected source:
  - Explain with AI
  - AI Hint
  - Review & Optimize
  - Generate Tests
  - Interview Drill
- Uses the portal's existing secure `callAiProvider` / streaming AI infrastructure and existing API-key flow.
- The original supplied Striver source is also retained under `frontend/striver-a2z-source/`.

## Compatibility
The existing coding judge, existing A-Z DSA Sheet, Code Review, animations/explainer features, AI tutor, and all other portal functionality are left intact. This integration only adds the Striver subtab and supporting assets.

## Advanced Solve Mode

The Striver A2Z subtab now supports a complete learn-to-solve workflow without creating a new top-level portal tab:

- **Solve this** / **Start Solve Mode** generates a fresh AI-authored practice challenge from the selected Striver source.
- The challenge contains a problem statement, constraints, I/O contract, incomplete Python 3 starter code, and deterministic tests.
- Students edit their own code in an integrated editor.
- **Run all tests** executes the student's Python code through the portal's existing execution engine and reports pass/fail per test.
- The supplied/reference solution stays hidden until the student chooses **Reveal reference**.
- **Next hint** and **AI debug** provide Socratic coaching based on the student's current code and judge results.
- A fully passing challenge automatically contributes to Striver progress.
- Existing Explain, Hint, Review, Tests and Interview AI actions remain available.
- No existing top-level tab or previous portal feature is removed.

## v2 upgrade (study workflow)
All earlier features (Explain/Hint/Review/Tests/Interview, Solve Mode + judge, AI pair programmer, editor tools) are unchanged. Added:
- Dashboard: completion ring, day streak, revisions due, practice time, 12-week activity heatmap, per-step progress cards.
- Syntax-highlighted reference-solution viewer (copy / download / font / wrap) with a "try it first" gate and a Study-mode toggle.
- Filters (To do, Done, Saved, Due, Low confidence, Notes), 4 sort orders, Prev/Next, keyboard shortcuts (J K X S /).
- Per-problem notes, confidence rating, timer, judge-run counters, spaced-repetition revision ladder (1-3-7-14-30-60 days).
- Static facts from the code (lines, loop nesting, recursion, detected patterns) and LeetCode / video / GFG search links.
- AI weekly plan built from your real progress numbers.
- Progress syncs per account across devices (cloud key `striver_a2z_v2:<email>`), merges safely, export/import JSON; old progress migrated automatically.

## Gate pass QR expiry fix
Run `gate-passes-atomic-redeem.sql` once in PostgreSQL SQL Editor (atomic redeem function, sticky qr_used trigger, realtime). Set `GATE_PASS_PUBLIC_BASE_URL` near the top of the gate-pass data layer in index.html if the portal is opened from localhost.

## Phase 7 — original question links + cleaner AI text
See `../CHANGELOG_PHASE7.md`. Each file maps to its original question via `STRIVER_PROBLEM_MAP` (also exported as `striver-question-links.json`).
