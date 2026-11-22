# Option C: Zero-Build TypeScript Strictness Wave Plan

## 1. Goal & Strategy
Keep the project's **zero-build `.js` + `checkJs: true`** architecture intact while catching ~80% of real type, nullability, and implicit-`any` bugs on high-value backend modules:
- Introduce a ratchet config **`tsconfig.backend.strict.json`** extending `tsconfig.backend.json` with `"strictNullChecks": true` and `"noImplicitAny": true`.
- Wire `tsc -p tsconfig.backend.strict.json --noEmit` into `package.json`'s `"typecheck"` script so every completed wave is permanently enforced.
- Expand `types/backend.d.ts` with shared D1 row, environment, and Hono `Context` types.
- Leave `public/js/` and `public/sw.js` untouched (no bundler, no `.ts` runtime files).

## 2. Estimated Token Budget
- **Total:** **~150k–400k agentic tokens** across 4 sequential waves (~35k–100k per wave).
- **Local option:** **$0 API tokens** if executed one wave at a time on local `qwen3-coder-32k` (`opencode`).

---

## 3. Wave Breakdown (Sequential — 1 Wave at a Time)

### Wave 0 — Ratchet & Shared Contracts (~25k–45k tokens)
- **Files:**
  - `tsconfig.backend.strict.json` (new)
  - `package.json` (`"typecheck"` script)
  - `types/backend.d.ts`
  - `src/app/errors.js`, `src/app/config.js`, `src/app/policy.js`
- **Deliverables:**
  - Define shared D1 row types (`UserRow`, `EventRow`, `AttendeeRow`, `ChannelRow`, `MessageRow`, `PushSubscriptionRow`), `AppEnv`, and Hono `Context` variable types in `types/backend.d.ts`.
  - Create `tsconfig.backend.strict.json` (`strictNullChecks: true`, `noImplicitAny: true`) with Wave 0 files in `include`, and add it to `npm run typecheck`.
- **Verification:**
  ```bash
  npx tsc -p tsconfig.backend.strict.json --noEmit && npm run typecheck && npm run lint
  ```

### Wave 1 — Security, Auth & Privacy Core (~40k–80k tokens)
- **Files:**
  - `src/app/security.js`
  - `src/app/security/{crypto,session,guards,ssrf}.js`
  - `src/app/consent.js`, `src/app/erasure.js`
- **Deliverables:**
  - Add strict JSDoc `@param`, `@returns`, and `@typedef` annotations plus explicit null guards.
  - Add all Wave 1 files to `tsconfig.backend.strict.json` `include`.
- **Verification:**
  ```bash
  npm run typecheck && npm run test:impact
  ```

### Wave 2 — Push, Mailer & Storage Adapters (~35k–75k tokens)
- **Files:**
  - `src/app/push-sender.js`
  - `src/app/mailer/{index,resend,brevo,mock,preferences,templates}.js`
  - `src/app/storage/{index,r2,gdrive,local}.js`
- **Deliverables:**
  - Strict typing for push payloads, quiet-hours logic, mail provider adapters, and R2/Drive/local storage interfaces.
  - Add all Wave 2 files to `tsconfig.backend.strict.json` `include`.
- **Verification:**
  ```bash
  npm run typecheck && node --test tests/core/push-sender.test.js
  ```

### Wave 3 — High-Traffic Route Handlers (~50k–120k tokens)
*(Split into **3a Events** and **3b Chat** if context grows.)*
- **Files:**
  - `src/app/routes/events/{core,rsvps,bp-duties,helpers}.js`
  - `src/app/routes/chat/{sync,channels,messages,moderation,blocks,helpers}.js`
- **Deliverables:**
  - Strict request/response and D1 query result typing across event RSVP/duty flows and clubhouse chat/moderation/mentions.
  - Add all Wave 3 files to `tsconfig.backend.strict.json` `include`.
- **Verification:**
  ```bash
  npm run check:quiet
  ```

---

## 4. Hard Invariants & Guardrails
- **Zero build step:** `noEmit: true` only; no `.ts` runtime files; no changes to `public/js/` or `public/sw.js`.
- **No `any` silencing:** Never use `@type {any}` casts to hide real nullability bugs — add explicit null checks or narrow types.
- **Wave discipline (`GEMINI.md`):** Execute sequentially (one wave at a time), run targeted tests per wave, and run `npm run map:gen` only if module exports change.

---

## 5. Tracking Table

| Wave | Scope | Status | Verification |
|---|---|---|---|
| **Wave 0** | Ratchet config & `types/backend.d.ts` | `[ ]` Pending | `npx tsc -p tsconfig.backend.strict.json --noEmit && npm run typecheck && npm run lint` |
| **Wave 1** | Security, auth & privacy core | `[ ]` Pending | `npm run typecheck && npm run test:impact` |
| **Wave 2** | Push, mailer & storage adapters | `[ ]` Pending | `npm run typecheck && node --test tests/core/push-sender.test.js` |
| **Wave 3** | Events & chat route handlers | `[ ]` Pending | `npm run check:quiet` |
