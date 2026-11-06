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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  if (!req.path.startsWith('/api/')) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com https://api.open-meteo.com https://geocoding-api.open-meteo.com; frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com https://www.youtube.com; media-src 'self' https: data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
  next();
});

const uploadsDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads', 'avatars');
app.use('/uploads/avatars', express.static(uploadsDir));

app.get(['/handbook', '/rules'], (req, res) => {
  res.writeHead(301, {
    'Location': '/handbook.html',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'Content-Length': '0'
  });
  res.end();
});

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
