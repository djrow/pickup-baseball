/**
 * @fileoverview Aggregator router and re-exports for `/api/events`.
 * @module routes/events
 *
 * Submodules:
 * - `events/core.js`: listing, detail view, CRUD, ICS feeds, reminders, rainout/reopen, SQL backup
 * - `events/rsvps.js`: RSVP submission, waitlist promotion, attendee removal, comments
 * - `events/bp-duties.js`: Batting Practice slot order and default/event volunteer tasks
 * - `events/helpers.js`: shared waitlist, email concurrency, and reminder helpers
 */

import { Hono } from 'hono';
import { eventsBpDutiesRouter } from './events/bp-duties.js';
import { eventsRsvpsRouter } from './events/rsvps.js';
import { eventsCoreRouter } from './events/core.js';

export { sendRemindersForEventD1, processUpcomingEventRemindersD1 } from './events/helpers.js';

export const eventsRouter = new Hono();

// Register static `/default-duties` and nested `/:id/...` subroutes before `eventsCoreRouter`'s `/:id` handler.
eventsRouter.route('/', eventsBpDutiesRouter);
eventsRouter.route('/', eventsRsvpsRouter);
eventsRouter.route('/', eventsCoreRouter);
