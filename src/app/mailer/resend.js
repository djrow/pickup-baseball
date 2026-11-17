/**
 * Resend Email Adapter (`resend`)
 * Handles single sends and batch sends (up to 100 emails/batch) with short 429 retry + bounded jitter.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(response) {
  const header = response.headers.get('Retry-After');
  if (!header) return null;
  const sec = parseFloat(header);
  return Number.isFinite(sec) ? sec : null;
}

export const resendAdapter = {
  name: 'resend',

  async sendSingle(env, message, options = {}) {
    const apiKey = env && env.RESEND_API_KEY ? env.RESEND_API_KEY.trim() : '';
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    const payload = {
      from: message.from,
      to: Array.isArray(message.to) ? message.to : [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html
    };
    if (message.replyTo) {
      payload.reply_to = message.replyTo;
    }
    if (message.headers) {
      payload.headers = message.headers;
    }

    let attempts = 0;
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;

    while (true) {
      attempts++;
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 429) {
        const retryAfterSec = parseRetryAfter(response);
        let errorData = null;
        try {
          errorData = await response.json();
        } catch {
          /* ignore json parse error */
        }

        const isDailyExceeded = Boolean(errorData && errorData.name === 'daily_quota_exceeded');
        if (isDailyExceeded || (retryAfterSec !== null && retryAfterSec > 5)) {
          const err = /** @type {any} */ (new Error((errorData && errorData.message) || 'daily_quota_exceeded'));
          err.code = 'daily_quota_exceeded';
          err.status = 429;
          throw err;
        }

        if (attempts <= maxRetries) {
          const waitMs = Math.min(5000, ((retryAfterSec !== null ? retryAfterSec : 1) * 1000) + Math.floor(Math.random() * 200));
          await sleep(waitMs);
          continue;
        }

        const err = /** @type {any} */ (new Error((errorData && errorData.message) || `Resend rate limit exceeded (429)`));
        err.code = 'rate_limit_exceeded';
        err.status = 429;
        throw err;
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Resend API error (${response.status})`);
      }

      return { messageId: data.id };
    }
  },

  async sendBatch(env, messages, options = {}) {
    const apiKey = env && env.RESEND_API_KEY ? env.RESEND_API_KEY.trim() : '';
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    // Resend batch endpoint: POST https://api.resend.com/emails/batch
    // Body is an array of email objects (max 100)
    const payload = messages.map((m) => {
      const item = {
        from: m.from,
        to: Array.isArray(m.to) ? m.to : [m.to],
        subject: m.subject,
        text: m.text,
        html: m.html
      };
      if (m.replyTo) item.reply_to = m.replyTo;
      if (m.headers) item.headers = m.headers;
      return item;
    });

    let attempts = 0;
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;

    while (true) {
      attempts++;
      const response = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 429) {
        const retryAfterSec = parseRetryAfter(response);
        let errorData = null;
        try {
          errorData = await response.json();
        } catch {
          /* ignore json parse error */
        }

        const isDailyExceeded = Boolean(errorData && errorData.name === 'daily_quota_exceeded');
        if (isDailyExceeded || (retryAfterSec !== null && retryAfterSec > 5)) {
          const err = /** @type {any} */ (new Error((errorData && errorData.message) || 'daily_quota_exceeded'));
          err.code = 'daily_quota_exceeded';
          err.status = 429;
          throw err;
        }

        if (attempts <= maxRetries) {
          const waitMs = Math.min(5000, ((retryAfterSec !== null ? retryAfterSec : 1) * 1000) + Math.floor(Math.random() * 200));
          await sleep(waitMs);
          continue;
        }

        const err = /** @type {any} */ (new Error((errorData && errorData.message) || `Resend batch rate limit exceeded (429)`));
        err.code = 'rate_limit_exceeded';
        err.status = 429;
        throw err;
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Resend batch API error (${response.status})`);
      }

      // Resend batch response is { data: [ { id: '...' }, ... ] }
      const resultsData = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
      const sent = [];
      const failed = [];

      for (let i = 0; i < messages.length; i++) {
        const itemRes = resultsData[i];
        if (itemRes && itemRes.id) {
          sent.push({
            index: messages[i].originalIndex !== undefined ? messages[i].originalIndex : i,
            to: messages[i].to,
            messageId: itemRes.id
          });
        } else if (itemRes && itemRes.error) {
          failed.push({
            index: messages[i].originalIndex !== undefined ? messages[i].originalIndex : i,
            to: messages[i].to,
            error: itemRes.error.message || 'Resend batch item error'
          });
        } else {
          // If response lacked explicit error but no ID
          sent.push({
            index: messages[i].originalIndex !== undefined ? messages[i].originalIndex : i,
            to: messages[i].to,
            messageId: `resend-batch-${Date.now()}-${i}`
          });
        }
      }

      return { sent, failed };
    }
  }
};
