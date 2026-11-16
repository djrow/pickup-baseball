/**
 * @fileoverview Channel ACLs & Hono RBAC Route Middleware Guards.
 *
 * @module app/security/guards
 */

import { ERROR_CODES, jsonError } from '../errors.js';
import { CANONICAL_MEMBER_ROLE } from './crypto.js';

// RBAC & Channel Access Helpers
export function canAccessChannel(user, channel, mode = 'read') {
  if (!user || !channel || typeof channel !== 'object') return false;

  // Super-admin has unrestricted access to all channels
  if (user.role === 'admin' || user.isAdmin || user.is_admin === 1) {
    return true;
  }

  const minRole = (mode === 'write' ? channel.min_role_write : channel.min_role_read) || CANONICAL_MEMBER_ROLE;

  // Role Rank hierarchy: admin: 4, organizer: 3, facilitator: 2, member/player: 1, guest/public: 0
  const ROLE_RANKS = {
    admin: 4,
    organizer: 3,
    facilitator: 2,
    member: 1,
    player: 1,
    guest: 0,
    public: 0
  };

  let userRank;
  if (user.role === 'admin' || user.isAdmin || user.is_admin === 1) {
    userRank = 4;
  } else if (user.role === 'organizer') {
    userRank = 3;
  } else if (user.isGameFacilitator || user.is_game_facilitator) {
    userRank = 2;
  } else {
    userRank = 1;
  }

  const requiredRank = Object.prototype.hasOwnProperty.call(ROLE_RANKS, minRole) ? ROLE_RANKS[minRole] : 999;
  return userRank >= requiredRank;
}

// Hono RBAC Middleware Guards
export async function requireAuth(c, next) {
  if (!c.get('user')) {
    return jsonError(c, 401, ERROR_CODES.AUTH_REQUIRED, 'Authentication required. Please sign in.');
  }
  await next();
}

export async function requireOrganizer(c, next) {
  const user = c.get('user');
  if (!user) {
    return jsonError(c, 401, ERROR_CODES.AUTH_REQUIRED, 'Authentication required. Please sign in.');
  }
  if (!user.canManageEvents) {
    return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Access denied: Event Organizer or Administrator privileges required.');
  }
  await next();
}

export async function requireAdmin(c, next) {
  const user = c.get('user');
  if (!user) {
    return jsonError(c, 401, ERROR_CODES.AUTH_REQUIRED, 'Authentication required. Please sign in.');
  }
  if (!user.isAdmin) {
    return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Access denied: Admin privileges required.');
  }
  await next();
}

export async function requireModerator(c, next) {
  const user = c.get('user');
  if (!user) {
    return jsonError(c, 401, ERROR_CODES.AUTH_REQUIRED, 'Authentication required. Please sign in.');
  }
  if (!user.isAdmin && !user.canModerateChat && !user.isModerator) {
    return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Access denied: Clubhouse Moderator or Admin privileges required.');
  }
  await next();
}

export function rejectIfChatMuted(c, user) {
  if (user && (user.chatMuted || user.chat_muted === 1)) {
    const reasonSuffix = user.chatMutedReason ? `: ${user.chatMutedReason}` : '.';
    return c.json({
      error: `You are currently muted in Clubhouse${reasonSuffix}`,
      code: 'USER_MUTED',
      muted_reason: user.chatMutedReason || null
    }, 403);
  }
  return null;
}

export function rejectIfClubhouseOptedOut(c, user) {
  if (user && !user.clubhouseOptedIn && user.clubhouse_opted_in !== 1) {
    return c.json({
      error: 'Please opt in to the Clubhouse to participate in chat, reactions, DMs, or voice.',
      code: 'CLUBHOUSE_OPT_OUT'
    }, 403);
  }
  return null;
}
