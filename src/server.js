const express = require('express');
const path = require('path');
const { initDatabase, d1 } = require('./db');
const { createNodeHttpBridge, getFullRequestUrl, sendWebResponse } = require('./d1-sqlite');
const { app: honoApp } = require('./app/index.js');
const { CURRENT_APP_VERSION } = require('./app/version.js');
const { renderFeedXmlResponse } = require('./app/feeds.js');
const { startReminderScheduler, stopReminderScheduler } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3000;

initDatabase();

app.use((req, res, next) => {
  res.setHeader('X-App-Version', CURRENT_APP_VERSION);
  next();
});

const uploadsDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads', 'avatars');
app.use('/uploads/avatars', express.static(uploadsDir));

app.get(['/handbook', '/rules'], (req, res) => res.redirect(301, '/handbook.html'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/feed.xml', async (req, res) => {
  const webRes = await renderFeedXmlResponse(d1, getFullRequestUrl(req));
  await sendWebResponse(webRes, res);
});

app.use('/api', createNodeHttpBridge(honoApp, () => ({ ...process.env, DB: d1 })));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  next();
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚾ Sunday Pickup Baseball running on http://localhost:${PORT} (v${CURRENT_APP_VERSION})`);
  startReminderScheduler();
});

function shutdown() {
  stopReminderScheduler();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
