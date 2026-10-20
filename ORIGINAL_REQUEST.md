# Original User Request

## Initial Request — 2026-10-20T21:04:39Z

Audit, test, and repair all broken, non-responsive, or hanging features in the Sunday Pickup Baseball charity web application. In particular, diagnose and fix the failing 1-Click Sunday game creator, resolve the custom game creation tool hanging indefinitely on 'publishing', audit all buttons across the application, and ensure role-based permissions operate seamlessly.

Working directory: c:\Users\david\Documents\antigravity\lucid-maxwell
Integrity mode: development

## Requirements

### R1. Diagnose and Fix Event Creation Failures
- Fix the 1-Click "Post Next Sunday @ Noon" button so it reliably creates the event and default equipment duties in SQLite without failing.
- Fix the custom game creation form so it completes submission, clears any hanging 'publishing' state, provides immediate user feedback, and navigates to the created game.
- Ensure all backend routes (POST /api/events, PUT /api/events/:id, duties endpoints) properly validate inputs, handle errors gracefully, return appropriate JSON responses, and never hang unhandled.

### R2. Comprehensive Button and Interaction Audit
- Perform a thorough audit of every interactive button, link, form, and dropdown across all views (login.html, admin.html, index.html, event.html, profile.html).
- Fix any buttons that are dead, unhandled, produce uncaught JavaScript console errors, or fail to provide visual loading/completion feedback.

### R3. Role-Based Permissions & User Management Validation
- Verify and enforce the three-tier permission model (admin, organizer, player) across all API routes and UI views.
- Ensure Organizers and Admins can create and manage games and duties, while standard Players cannot access unauthorized management endpoints.
- Ensure the User Management screen accurately lists accounts and allows changing roles seamlessly without breaking session state.

### R4. Automated Programmatic Test Suite
- Create an automated verification script (e.g. scripts/verify-all.js or npm test) that tests authentication, session cookies, role upgrades/downgrades, 1-click event creation, custom event creation with duties, attendee RSVPs, and error boundaries.
- Ensure 100% of the verification script tests pass cleanly against the live local application.

## Acceptance Criteria

### Event Scheduling
- [ ] 1-Click Sunday Game creator executes, writes event and volunteer duties to SQLite, and successfully redirects to event.html?id=<new_id>.
- [ ] Custom game creation form successfully publishes events with all specified fields (date/time, location, map URL, description) without hanging on 'publishing'.
- [ ] Appropriate user feedback (success notification or clear error message) is always rendered upon form submission.

### UI & Interaction
- [ ] Every button and form across index.html, login.html, event.html, profile.html, and admin.html performs its intended action without uncaught errors.
- [ ] The role-based dashboard cards on login.html and admin.html correctly render based on the logged-in user's role.

### Verification
- [ ] An automated test script executes all critical user paths and exits with status code 0 (all tests passing).
- [ ] Zero unhandled promise rejections, hanging requests, or uncaught frontend errors during user workflows.
