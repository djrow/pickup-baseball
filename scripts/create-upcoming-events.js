const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { db, DEFAULT_BASEBALL_DUTIES } = require('../src/db');

// List of 13 upcoming Sundays for Dec 2026, Jan 2027, Feb 2027 (12:00 PM Pacific / 20:00:00 UTC)
const upcomingSundays = [
  '2026-12-06T20:00:00.000Z',
  '2026-12-13T20:00:00.000Z',
  '2026-12-20T20:00:00.000Z',
  '2026-12-27T20:00:00.000Z',
  '2027-01-03T20:00:00.000Z',
  '2027-01-10T20:00:00.000Z',
  '2027-01-17T20:00:00.000Z',
  '2027-01-24T20:00:00.000Z',
  '2027-01-31T20:00:00.000Z',
  '2027-02-07T20:00:00.000Z',
  '2027-02-14T20:00:00.000Z',
  '2027-02-21T20:00:00.000Z',
  '2027-02-28T20:00:00.000Z'
];

console.log(`Generating ${upcomingSundays.length} upcoming Sunday games...`);

// 1. Insert into local SQLite database if not already present
let localInserted = 0;
const checkEvent = db.prepare('SELECT id FROM events WHERE event_date = ?');
const insertEvent = db.prepare(`
  INSERT INTO events (title, description, location, location_url, event_date, max_players, created_by)
  VALUES (?, ?, ?, ?, ?, NULL, ?)
`);
const insertDuty = db.prepare(`
  INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
  VALUES (?, ?, ?, ?, ?)
`);

// Get admin user id
let adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' OR is_admin = 1 LIMIT 1").get();
const adminId = adminUser ? adminUser.id : 1;

for (const iso of upcomingSundays) {
  const existing = checkEvent.get(iso);
  if (!existing) {
    const res = insertEvent.run(
      'Sunday Pickup Baseball',
      '',
      'Bushrod Park Field 1',
      '',
      iso,
      adminId
    );
    const newId = res.lastInsertRowid;
    DEFAULT_BASEBALL_DUTIES.forEach((d, idx) => {
      insertDuty.run(newId, d.title, d.description || '', d.slots_needed || 1, idx);
    });
    localInserted++;
  }
}
console.log(`Local SQLite: Inserted ${localInserted} new events with default duties.`);

// 2. Generate SQL file for Cloudflare D1
let sqlStatements = [];
sqlStatements.push('-- Seed next three months of Sunday pickup baseball games (Dec 2026 - Feb 2027)');

for (const iso of upcomingSundays) {
  sqlStatements.push(`
INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '${iso}', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '${iso}');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '${iso}' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '${iso}' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '${iso}' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '${iso}' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '${iso}' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '${iso}' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');
  `.trim());
}

const sqlPath = path.join(__dirname, 'seed_3_months.sql');
fs.writeFileSync(sqlPath, sqlStatements.join('\n\n'), 'utf8');
console.log(`Generated SQL file at ${sqlPath}`);
