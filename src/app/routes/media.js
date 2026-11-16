/**
 * Media Router Aggregator (Ticket #68 / ADR-0008 / ADR-0010)
 * Mounts focused sub-routers for Gallery media items, Clubhouse attachments, and Admin storage status.
 */

import { Hono } from 'hono';
import { mediaGalleryRouter } from './media/gallery.js';
import { mediaAttachmentsRouter } from './media/attachments.js';
import { getAdminStorageStatusHandler } from './media/admin.js';

export { getAdminStorageStatusHandler };

export const mediaRouter = /** @type {AppHono} */ (new Hono());
export const attachmentsRouter = /** @type {AppHono} */ (new Hono());

mediaRouter.route('/', mediaGalleryRouter);
attachmentsRouter.route('/', mediaAttachmentsRouter);
