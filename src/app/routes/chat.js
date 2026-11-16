/**
 * Clubhouse Chat Router Aggregator
 * Mounts focused sub-routers for bootstrap/sync, channels, messages/reactions, and moderation/mutes.
 */

import { Hono } from 'hono';
import { chatSyncRouter } from './chat/sync.js';
import { chatChannelsRouter } from './chat/channels.js';
import { chatMessagesRouter } from './chat/messages.js';
import { chatModerationRouter } from './chat/moderation.js';
import { chatBlocksRouter } from './chat/blocks.js';

export {
  abbreviateMemberNames,
  resolveChannel,
  isPrivateEncryptedBoard,
  isPublicGuestChannel,
  canUserAccessChannel,
  getBlockedUserIds,
  isPeerBlocked,
  getDmPeerIds,
  isAnyPeerBlocked,
  rejectIfDmPeerBlocked
} from './chat/helpers.js';

export const chatRouter = /** @type {AppHono} */ (new Hono());

chatRouter.route('/', chatSyncRouter);
chatRouter.route('/', chatChannelsRouter);
chatRouter.route('/', chatMessagesRouter);
chatRouter.route('/', chatModerationRouter);
chatRouter.route('/', chatBlocksRouter);
