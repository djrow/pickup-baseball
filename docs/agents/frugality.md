# Agent Token-Frugality & Eval Protocol

On-demand workflow reference for keeping agentic coding fast, cheap, and high-signal without sacrificing correctness.

## 1. Quick-Reference Toolbelt
- **Lookup before reading:** Consult [docs/AGENT_MAP.md](../AGENT_MAP.md) (`npm run map:gen` / `npm run map:check`) before grepping routes, DB columns, backend exports, or page globals.
- **Scoped inner-loop checks:**
  - `npm run test:impact -- --json` (or `--run`) maps dirty/branch files to minimal `VERIFY_SUITES`, standalone tests, and `workerd` suites.
  - `VERIFY_SUITES=waiver-telemetry npm run test:quiet` runs a single suite inside `scripts/verify-all.js` using `--test-reporter=dot`.
- **Zero-token bulk codemods:**
  - `npm run i18n:sync -- --add <key> --en "<text>" --surface <core|clubhouse|admin> --fill-en` patches `EN_DICT` + all 15 locale JSON files in one command.
  - `npm run asset:register -- --sync` syncs `public/sw.js` `STATIC_ASSETS` and optional page `<link>`/`<script>` `?v=` tags.
- **Quiet release gate:** `npm run check:quiet` runs `lint`, `typecheck`, `test:quiet`, `test:workerd:quiet`, `test:browser:quiet`, and `security:scan:quiet` with minimal passing stdout.
- **Telemetry:** `npm run tokens:profile -- <path/to/transcript.jsonl> [--json]` measures category spend, unedited/duplicate reads, and turn amplification.

## 2. Contract-First Handoff Pattern
Before handing a backend or shared-interface change from planning to execution:
1. Update the type contract first in `types/backend.d.ts`, `types/client-globals.d.ts`, or JSDoc (`npm run typecheck` checks exact shapes).
2. Name or add a single targeted failing test oracle (e.g., `VERIFY_SUITES=<suite>`) describing inputs, HTTP status, and error taxonomy codes.
3. Hand off exact line-bounded file paths + contract diff so the executor does zero exploratory discovery.

## 3. Wave-Boundary State Snapshot Template (<= 30 Lines)
Use this compact `O(1)` handoff between waves or before `/compact` so stale tool logs do not compound quadratically:

```markdown
### Wave Snapshot (<feature/milestone>)
- **Goal:** <1 sentence outcome>
- **Changed Symbols:** `<file>:<symbol>` — <1-line delta>
- **Verified Invariants:** `<command>` -> `<pass summary>`
- **Open Risks:** <edge cases or deferred items>
- **Next Target:** `<exact files / command for next wave>`
```

## 4. Historical Replay Eval Protocol
Evaluate new prompting, workflow, or model-routing changes against **6 real `pickup-baseball` commits** from `git log`:

| # | Commit | Scope | Evaluates |
|---|---|---|---|
| 1 | `1bcfe66` | `v174: Show walk-up song titles directly on Clubhouse BP slots` | Small cross-layer display change |
| 2 | `703f688` | `fix: make waitlist promotion capacity check atomic` | Concurrency / SQL atomicity bugfix |
| 3 | `aea013e` | `fix: repair YouTube walk-up embed, timestamp playback, and session persistence (v176)` | Multi-file frontend & CSP debugging |
| 4 | `a2b6ff0` | `feat: carry over profile avatars and allow mods to add BP batters & walk-up songs (v177)` | Multi-surface RBAC + UI feature |
| 5 | `0acc85c` | `feat(clubhouse): opt-in push settings and Web Push sender` | Schema + backend module + UI + tests |
| 6 | `382e079` | `fix(clubhouse): make sidebar user bar scroll when taller than window` | Minimal targeted CSS restraint |

### A/B Replay Procedure & Scoring Rubric
1. Create an isolated worktree at `<commit>^` (e.g., `git worktree add ../replay-<sha> <sha>^`).
2. Replay **Baseline A** (default workflow) and **Variant B** (frugal workflow: `AGENT_MAP.md`, `test:impact`, `check:quiet`, contract-first briefs) from the same issue prompt.
3. Profile both conversation logs with `npm run tokens:profile -- <transcript.jsonl> --json`.
4. Score each run on:
   - **Total / Cache-Read Tokens** & **Quadratic Amplification Ratio** (`cumulativeContextTokens / uniqueContentTokens`)
   - **Turn Count**, **Unedited File Reads**, and **Duplicate Reads**
   - **First-Pass Gate Rate** (`npm run check:quiet` exit 0 on first verification run)
   - **Diff Quality (1-5)**: adherence to `AGENTS.md` invariants (strict CSP, ES6 vanilla JS, parameterized SQL, minimal scope).

> **Cascade Gate:** Keep automated cheap-model best-of-N routing (**Rank #8**) disabled until this 6-commit replay baseline is recorded so regressions in architecture or reward-hacking tests are caught empirically.

## 5. Longitudinal Effectiveness Check-In & Pruning
After 2–4 weeks of normal feature/bugfix work, measure real Before-vs.-After medians and per-wave adoption across your local Antigravity conversation transcripts:

```bash
node scripts/token-profile.js --cohort --since 2026-11-01 --split 2026-11-21
```

*(Note: in Windows PowerShell, invoke `node scripts/...` directly or quote `'--'` before flags when using `npm run`, e.g. `npm run tokens:scorecard '--' --since 2026-11-01 --split 2026-11-21`. Use `--split 2026-11-20T17:00:00Z` instead if you also want sessions from later today in the `After` cohort.)*

Or ask in a fresh chat:
> *"Run `node scripts/token-profile.js --cohort --since 2026-11-01 --split 2026-11-21`, review any `prune-candidate` or low-adoption tools, and remove the ones that aren't helping."*

Scorecard verdicts:
- **`keep`** — adopted in >=30–50% of matching opportunities (or active in recent workflow checks).
- **`review`** — partial adoption or elevated `mapDriftHits`; inspect whether prompt hints need adjustment or the tool adds friction.
- **`prune-candidate`** — 0 uses across multiple qualifying opportunities (`>=2`–`3`); safe candidate to remove cleanly.
- **`insufficient-data`** — too few qualifying opportunities since `--split`; wait for more sessions before deciding.
