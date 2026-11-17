/**
 * Brevo (Sendinblue) Email Adapter (`brevo`)
 * Handles single sends and batch sends (up to 100 messageVersions) via `POST https://api.brevo.com/v3/smtp/email`.
 */

export const brevoAdapter = {
  name: 'brevo',

  async sendSingle(env, message, _options = {}) {
    const apiKey = env && env.BREVO_API_KEY ? env.BREVO_API_KEY.trim() : '';
    if (!apiKey) {
      throw new Error('BREVO_API_KEY is not configured');
    }

    const toList = Array.isArray(message.to)
      ? message.to.map((addr) => (typeof addr === 'string' ? { email: addr } : addr))
      : [{ email: message.to }];

    const payload = {
      sender: { email: message.fromEmail || message.from, name: message.fromName },
      to: toList,
      subject: message.subject,
      textContent: message.text,
      htmlContent: message.html
    };
    if (message.replyTo) {
      payload.replyTo = { email: message.replyTo };
    }
    if (message.headers) {
      payload.headers = message.headers;
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Brevo API error (${response.status})`);
    }

    return { messageId: data.messageId || data.id };
  },

  async sendBatch(env, messages, _options = {}) {
    const apiKey = env && env.BREVO_API_KEY ? env.BREVO_API_KEY.trim() : '';
    if (!apiKey) {
      throw new Error('BREVO_API_KEY is not configured');
    }

    if (messages.length === 0) {
      return { sent: [], failed: [] };
    }

    // Brevo smtp/email endpoint supports messageVersions up to 100
    const first = messages[0];
    const messageVersions = messages.map((m) => {
      const toList = Array.isArray(m.to)
        ? m.to.map((addr) => (typeof addr === 'string' ? { email: addr } : addr))
        : [{ email: m.to }];
      const item = {
        to: toList,
        subject: m.subject,
        htmlContent: m.html,
        textContent: m.text
      };
      if (m.headers) item.headers = m.headers;
      return item;
    });

    const payload = {
      sender: { email: first.fromEmail || first.from, name: first.fromName },
      messageVersions
    };
    if (first.replyTo) {
      payload.replyTo = { email: first.replyTo };
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Brevo batch API error (${response.status})`);
    }

    // Brevo returns { messageIds: ['<...>', ...] }
    const messageIds = Array.isArray(data.messageIds) ? data.messageIds : [];
    const sent = [];
    const failed = [];

    for (let i = 0; i < messages.length; i++) {
      const mId = messageIds[i] || `brevo-batch-${Date.now()}-${i}`;
      sent.push({
        index: messages[i].originalIndex !== undefined ? messages[i].originalIndex : i,
        to: messages[i].to,
        messageId: mId
      });
    }

    return { sent, failed };
  }
};
