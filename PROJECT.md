# Project: Sunday Pickup Baseball — Comprehensive Repair & Audit

## Architecture
- **Runtime**: Node.js v22.23.3 (ESM / CommonJS hybrid, native `node:test`, `node:assert`, `fetch`).
- **Web Server**: Express 5 (`src/server.js`), static asset hosting (`public/`).
- **Database**: SQLite (`better-sqlite3`), schema and initial migrations in `src/db.js`.
- **Authentication**: Passwordless email verification with 6-digit codes and magic links (`src/auth.js`, `src/routes/auth.js`). Session management via HttpOnly cookies (`baseball_session`).
- **RBAC**: 3-tier authorization model: `admin`, `organizer`, `player`.
  - `admin`: Full administrative access, database backup, role management, default duty templates, event deletion, email reminders.
  - `organizer`: Event creation (1-Click & Custom), event updating, duty assignment and management.
  - `player`: View games, RSVP, claim duty slots, edit personal profile.
- **Frontend**: Vanilla JavaScript (`public/js/app.js`, `public/js/admin.js`, `public/js/api.js`, `public/js/event.js`), HTML5 views (`index.html`, `login.html`, `admin.html`, `event.html`, `profile.html`), custom CSS (`public/css/style.css`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Express Route Order Fix | Move static routes (`/default-duties`, `/admin/backup-db`, `/reminders/check`) before dynamic `/:id` routes in `src/routes/events.js` | M1 | Survey (Explorer 1) |
| 2 | Atomic Event Creation | Wrap `INSERT INTO events` and `event_duties` in a `db.transaction` in `POST /api/events` | M1 | Survey (Explorer 1 & 2) |
| 3 | Event Creation API Contract | Return `{ success: true, eventId, event: { id: eventId }, message }` from `POST /api/events` | M1 | Survey (Explorer 1, 2, 3) |
| 4 | Event Update Field Preservation | Fix `PUT /api/events/:id` so omitting `max_players` does not erase existing player limits | M1 | Survey (Explorer 3) |
| 5 | Route 404 & Constraint Hardening | Check `result.changes === 0` on `PUT`/`DELETE` routes, validate dates, handle missing IDs with 404 | M1 | Survey (Explorer 1, 2, 3) |
| 6 | SQLite Timestamp Evaluation | Replace raw `CURRENT_TIMESTAMP` comparisons with `datetime(expires_at) > datetime('now')` in auth logic | M1 | Survey (Explorer 1) |
| 7 | Homepage Syntax Repair | Remove orphaned HTML tags on lines 177–183 of `public/js/app.js` to restore script execution on `index.html` | M2 | Survey (Explorer 1, 2, 3) |
| 8 | 1-Click Game Creator Redirect (login.html) | Fix `res.event.id` error, ensure defensive ID extraction and redirection to `event.html?id=<new_id>` | M2 | Survey (Explorer 1, 2, 3) |
| 9 | Custom Game Creator Hang Fix (login.html) | Clear `Publishing...` state, extract ID defensively, provide success feedback, redirect to `event.html?id=<new_id>` | M2 | Survey (Explorer 1, 2, 3) |
| 10 | Admin 1-Click & Custom Game Redirects (admin.js) | Redirect to `event.html?id=<new_id>` upon creation instead of remaining on `admin.html` | M2 | Survey (Explorer 1, 2) |
| 11 | Admin Form Exception Safety (admin.js) | Move date parsing inside `try...finally` block so `Publishing...` never hangs on invalid dates | M2 | Survey (Explorer 1, 3) |
| 12 | Inline Task Edit Apostrophe Escaping | Properly escape apostrophes in task titles (e.g. "Catcher's Gear") in `admin.js:547` | M2 | Survey (Explorer 1) |
| 13 | Profile Organizer Role Badge | Display `🛡️ Event Organizer` badge on `profile.html` for organizer users | M2 | Survey (Explorer 2, 3) |
| 14 | Organizer Access on Homepage | Allow organizers (`canManageEvents`) to see "Create Next Sunday Game" button in empty state on `index.html` | M2 | Survey (Explorer 2) |
| 15 | Interactive Button & Control Audit | Verify all buttons, links, forms across all 5 views perform intended actions with visual feedback | M2 | Survey (Explorer 2) |
| 16 | Admin Panel RBAC Filtering | Hide admin-only controls (DB backup, default template editor, delete game, send reminders) from Organizers on `admin.html` | M3 | Survey (Explorer 2, 3) |
| 17 | Self-Demotion Session Gracefulness | Handle admin self-demotion gracefully without throwing 403 on subsequent user table reload | M3 | Survey (Explorer 3) |
| 18 | RBAC Permission Verification | Verify strict access controls: Player cannot access admin/organizer endpoints, Organizer cannot access admin endpoints | M3 | Survey (Explorer 3) |
| 19 | Zero-Dependency E2E Test Suite | Implement `scripts/verify-all.js` using Node 22 native `node:test`, `node:assert`, and `fetch` | M4 | Survey (Explorer 3) |
| 20 | Test Suite Execution & npm test | Wire `npm test` in `package.json` to execute `scripts/verify-all.js` against the live local application | M4 | Survey (Explorer 3) |
| 21 | Full Acceptance Validation | Validate 100% test pass (status code 0, 0 unhandled rejections, 0 frontend crashes) | M4 | ORIGINAL_REQUEST |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Backend Routes & DB Hardening | Fix route shadowing, atomic event transactions, response contracts, timestamp checks, 404 guards | none | DONE |
| M2 | Frontend Fixes & UI Audit | Fix `app.js` syntax, 1-Click & custom game redirects/hangs on login/admin, apostrophe escaping, button audit | M1 | DONE |
| M3 | RBAC & User Management UI Guards | Admin/Organizer UI boundary guards on `admin.html`, self-demotion handling, permission enforcement | M1, M2 | DONE |
| M4 | Automated Programmatic Test Suite | Zero-dependency test suite covering Auth, RBAC, User Management, 1-Click Game, Custom Game, RSVPs, Error Boundaries | M1, M2, M3 | PLANNED |

## Interface Contracts
### Client ↔ Server: `POST /api/events`
- **Request Body**:
  ```json
  {
    "title": "string (required)",
    "description": "string (optional)",
    "location": "string (required)",
    "location_url": "string (optional)",
    "event_date": "ISO8601 string (required)",
    "max_players": 30,
    "use_default_duties": true,
    "custom_duties": [
      { "title": "Field Setup", "description": "Set bases", "slots_needed": 2 }
    ]
  }
  ```
- **Response Body**:
  ```json
  {
    "success": true,
    "eventId": 123,
    "event": {
      "id": 123,
      "title": "...",
      "event_date": "...",
      "location": "..."
    },
    "message": "Event created successfully."
  }
  ```

### Client ↔ Server: `GET /api/events/default-duties`
- **Response Body**:
  ```json
  {
    "duties": [
      { "title": "...", "description": "...", "slots_needed": 2 }
    ]
  }
  ```

### Client ↔ Server: `PUT /api/auth/users/:id/role`
- **Request Body**: `{ "role": "admin" | "organizer" | "player" }`
- **Response Body**: `{ "success": true, "user": { "id": 1, "role": "..." } }`

## Code Layout
- `src/server.js`: Server configuration and middleware.
- `src/db.js`: SQLite database connection, tables, migrations, default tasks.
- `src/auth.js`: Session cookie management, `optionalUser`, `requireUser`, `requireEventCreator`, `requireAdmin`.
- `src/routes/auth.js`: Auth endpoints (send-code, verify-code, verify-magic, logout, me, users, profile, avatar).
- `src/routes/events.js`: Event endpoints (events, default-duties, backup-db, duties, rsvp, comments).
- `public/js/app.js`: Homepage scripts (load games, filters, hero buttons).
- `public/js/admin.js`: Organizer/Admin control panel (1-click creator, custom game builder, task manager, users).
- `public/js/api.js`: Client API helper methods (`createEvent`, `fetchMe`, `logout`, etc.).
- `public/js/event.js`: Single event page scripts (RSVP, duties, discussion).
- `public/*.html`: HTML views (`index.html`, `login.html`, `admin.html`, `event.html`, `profile.html`).
- `scripts/verify-all.js`: Automated E2E verification test suite.
- `test/`: Unit & integration tests.
