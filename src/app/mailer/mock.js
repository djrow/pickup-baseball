/**
 * Mock Email Adapter (`mock`)
 * Deterministic test/dev recorder with zero network calls.
 */

export const mockAdapter = {
  name: 'mock',

  async sendSingle(env, message, _options = {}) {
    if (env && env.NODE_ENV !== 'test') {
      console.log(`[Email Dispatch (Mock)] To: ${message.to} | Subject: ${message.subject}`);
    }
    return { messageId: 'mock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
  },

  async sendBatch(env, messages, _options = {}) {
    const sent = messages.map((m, idx) => ({
      index: m.originalIndex !== undefined ? m.originalIndex : idx,
      to: m.to,
      messageId: 'mock-batch-' + Date.now() + '-' + idx
    }));
    return { sent, failed: [] };
  }
};
