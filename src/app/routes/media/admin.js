/**
 * Admin Storage Status Handler (Ticket #68 / ADR-0008)
 * Exposes active STORAGE_PROVIDER health, quotas, R2/Drive/Local status, and dual-D1 metrics.
 */

import { logEvent } from '../../errors.js';
import { getStorageAdapter, resolveStorageProvider, r2StorageAdapter, localStorageAdapter } from '../../storage/index.js';
import { getGDriveStorageQuota } from '../../gdrive.js';

/**
 * GET /api/admin/storage-status (requireAdmin)
 * @param {import('hono').Context} c
 */
export async function getAdminStorageStatusHandler(c) {
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);

  const activeProvider = resolveStorageProvider(c.env);
  const adapter = getStorageAdapter(c.env);
  const activeStatus = await adapter.getStorageStatus(c.env);

  const gdriveQuota = await getGDriveStorageQuota(c.env);
  const r2Status = await r2StorageAdapter.getStorageStatus(c.env);
  const localStatus = await localStorageAdapter.getStorageStatus(c.env);

  const chatCounts = { channels: 0, messages: 0, attachments: 0, keys: 0 };
  if (chatDb) {
    try {
      const [chRes, msgRes, attRes, kyRes] = await chatDb.batch([
        chatDb.prepare('SELECT COUNT(*) as c FROM channels'),
        chatDb.prepare('SELECT COUNT(*) as c FROM messages'),
        chatDb.prepare('SELECT COUNT(*) as c FROM chat_attachments'),
        chatDb.prepare('SELECT COUNT(*) as c FROM user_crypto_keys')
      ]);
      chatCounts.channels = (chRes && chRes.results && chRes.results[0]) ? chRes.results[0].c : 0;
      chatCounts.messages = (msgRes && msgRes.results && msgRes.results[0]) ? msgRes.results[0].c : 0;
      chatCounts.attachments = (attRes && attRes.results && attRes.results[0]) ? attRes.results[0].c : 0;
      chatCounts.attachmentCount = chatCounts.attachments;
      chatCounts.keys = (kyRes && kyRes.results && kyRes.results[0]) ? kyRes.results[0].c : 0;
    } catch (e) {
      logEvent('warn', 'admin_storage_status_chat_counts_failed', { err: e });
    }
  }

  const baseballCounts = { users: 0, events: 0, attendees: 0, media_items: 0 };
  if (baseballDb) {
    try {
      const [uRes, evRes, atRes, miRes] = await baseballDb.batch([
        baseballDb.prepare('SELECT COUNT(*) as c FROM users'),
        baseballDb.prepare('SELECT COUNT(*) as c FROM events'),
        baseballDb.prepare('SELECT COUNT(*) as c FROM attendees'),
        baseballDb.prepare('SELECT COUNT(*) as c FROM media_items')
      ]);
      baseballCounts.users = (uRes && uRes.results && uRes.results[0]) ? uRes.results[0].c : 0;
      baseballCounts.events = (evRes && evRes.results && evRes.results[0]) ? evRes.results[0].c : 0;
      baseballCounts.attendees = (atRes && atRes.results && atRes.results[0]) ? atRes.results[0].c : 0;
      baseballCounts.media_items = (miRes && miRes.results && miRes.results[0]) ? miRes.results[0].c : 0;
      baseballCounts.mediaCount = baseballCounts.media_items;
    } catch (e) {
      logEvent('warn', 'admin_storage_status_baseball_counts_failed', { err: e });
    }
  }

  return c.json({
    status: 'ok',
    storageProvider: activeProvider,
    activeProvider,
    storage: activeStatus,
    r2: r2Status,
    gdrive: gdriveQuota,
    local: localStatus,
    chatDb: chatCounts,
    baseballDb: baseballCounts
  });
}
