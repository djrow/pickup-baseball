/**
 * Standalone hourly Cron Worker for Pickup Baseball Foundation (Ticket #73 / ADR-0008)
 *
 * Runs on an hourly schedule (crons = ["0 * * * *"]) with zero D1 bindings.
 * Calls POST ${targetOrigin}/api/events/reminders/check authenticated via
 * Authorization: Bearer ${CRON_SECRET}.
 *
 * Target origin selection:
 * - Uses PUBLIC_ORIGIN whenever LOCK_PREVIEW_ORIGIN === "1" or 1.
 * - Otherwise falls back to PAGES_ORIGIN, PUBLIC_ORIGIN, or default https://www.pickupbaseballfoundation.org.
 */

export function resolveTargetOrigin(env) {
  const isLockPreview = env && (env.LOCK_PREVIEW_ORIGIN === '1' || env.LOCK_PREVIEW_ORIGIN === 1);
  if (isLockPreview && env && env.PUBLIC_ORIGIN) {
    return String(env.PUBLIC_ORIGIN).trim().replace(/\/+$/, '');
  }
  if (env && env.PAGES_ORIGIN) {
    return String(env.PAGES_ORIGIN).trim().replace(/\/+$/, '');
  }
  if (env && env.PUBLIC_ORIGIN) {
    return String(env.PUBLIC_ORIGIN).trim().replace(/\/+$/, '');
  }
  return 'https://www.pickupbaseballfoundation.org';
}

export default {
  /**
   * Cron Trigger handler executed every hour (0 * * * *).
   * @param {ScheduledEvent} event
   * @param {Record<string, any>} env
   * @param {ExecutionContext} [_ctx]
   */
  async scheduled(event, env, _ctx) {
    const origin = resolveTargetOrigin(env);
    const cronSecret = (env && (env.CRON_SECRET || env.REMINDERS_SECRET)) || '';

    if (!cronSecret) {
      console.warn('[cron-reminders] CRON_SECRET is not configured; skipping reminder check.');
      return { skipped: true, reason: 'CRON_SECRET missing' };
    }

    const targetUrl = `${origin}/api/events/reminders/check`;
    const headers = {
      'Authorization': `Bearer ${cronSecret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pickup-baseball-cron-reminders/1.0'
    };

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(`[cron-reminders] POST /api/events/reminders/check failed with HTTP ${response.status}: ${text}`);
        throw new Error(`Cron reminders check failed: HTTP ${response.status}`);
      }

      const data = await response.json().catch(() => ({}));
      console.log('[cron-reminders] Reminder check dispatched successfully:', JSON.stringify(data));
      return data;
    } catch (err) {
      console.error('[cron-reminders] Network or dispatch error:', err);
      throw err;
    }
  }
};
