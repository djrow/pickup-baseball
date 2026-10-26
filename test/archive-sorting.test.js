const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

const testDbPath = path.join(os.tmpdir(), `archive_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase } = require('../src/db');
initDatabase();

const eventRoutes = require('../src/routes/events');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/events', eventRoutes);

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Seed events with known relative timestamps
  const now = new Date();
  
  // Past game 1: 14 days ago
  const pastDate1 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  // Past game 2: 7 days ago
  const pastDate2 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Next game: 3 days in future
  const nextDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  // Future game: 10 days in future
  const futureDate = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();

  const insertEvent = db.prepare(`
    INSERT INTO events (title, event_date, location, description)
    VALUES (?, ?, ?, ?)
  `);

  insertEvent.run('Past Sunday Game (Two Weeks Ago)', pastDate1, 'Field A', 'Old game');
  insertEvent.run('Past Sunday Game (Last Week)', pastDate2, 'Field B', 'Recent past game');
  insertEvent.run('Next Sunday Pickup', nextDate, 'Field C', 'This is the next game');
  insertEvent.run('Future Sunday Pickup', futureDate, 'Field D', 'Game after next');
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (e) {}
});

test('Event sorting and archive API verification', async (t) => {
  await t.test('1. Default GET /api/events returns only upcoming games sorted ASC (next game first)', async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.events));
    assert.equal(data.events.length, 2);

    // Earliest upcoming must be index 0 (Next game)
    assert.equal(data.events[0].title, 'Next Sunday Pickup');
    assert.equal(data.events[1].title, 'Future Sunday Pickup');
    assert.ok(new Date(data.events[0].event_date) < new Date(data.events[1].event_date));
  });

  await t.test('2. GET /api/events?filter=past returns past games sorted DESC (most recent past game first)', async () => {
    const res = await fetch(`${baseUrl}/api/events?filter=past`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.events));
    assert.equal(data.events.length, 2);

    // Most recent past game must be index 0
    assert.equal(data.events[0].title, 'Past Sunday Game (Last Week)');
    assert.equal(data.events[1].title, 'Past Sunday Game (Two Weeks Ago)');
    assert.ok(new Date(data.events[0].event_date) > new Date(data.events[1].event_date));
  });

  await t.test('3. Archive page HTML exists and contains required components', () => {
    const archiveHtmlPath = path.join(__dirname, '../public/archive.html');
    assert.ok(fs.existsSync(archiveHtmlPath), 'archive.html must exist in public/');

    const content = fs.readFileSync(archiveHtmlPath, 'utf8');
    assert.ok(content.includes('archive-games-container'), 'archive.html must have container for past games');
    assert.ok(content.includes('archive.back_to_upcoming'), 'archive.html must have back link to upcoming games');
    assert.ok(content.includes('/js/archive.js'), 'archive.html must include archive.js script');
    assert.ok(content.includes('/js/api.js'), 'archive.html must include api.js script');
  });

  await t.test('4. Home page index.html links to archive page and displays Future Scheduled Games section', () => {
    const indexHtmlPath = path.join(__dirname, '../public/index.html');
    assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist');

    const content = fs.readFileSync(indexHtmlPath, 'utf8');
    assert.ok(content.includes('/archive.html'), 'index.html must contain link to /archive.html');
    assert.ok(content.includes('home.future_games'), 'index.html must have Future Scheduled Games header');
    assert.ok(content.includes('featured-game-container'), 'index.html must have next game container');
    assert.ok(content.includes('games-list-container'), 'index.html must have future games container');
  });

  await t.test('5. Navigation in api.js includes Archive link', () => {
    const apiJsPath = path.join(__dirname, '../public/js/api.js');
    const content = fs.readFileSync(apiJsPath, 'utf8');
    assert.ok(content.includes('/archive.html'), 'api.js renderNav must link to /archive.html');
    assert.ok(content.includes('nav.archive'), 'api.js must have translation for nav.archive');
  });
});
