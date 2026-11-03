const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createD1Adapter } = require('./d1-sqlite');
const { DEFAULT_BASEBALL_DUTIES, CREATE_TABLES_SQL, ALTER_STATEMENTS } = require('./app/schema.js');

const dbDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dbDir, 'baseball_charity.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const d1 = createD1Adapter(db);

function initDatabase() {
  for (const sql of CREATE_TABLES_SQL) {
    db.exec(sql);
  }
  for (const sql of ALTER_STATEMENTS) {
    try { db.exec(sql); } catch (e) {}
  }

  db.exec(`
    UPDATE attendees
    SET players_count = CASE WHEN status = 'declined' THEN 0 ELSE 1 + COALESCE(additional_guests, 0) END
    WHERE players_count IS NULL
  `);

  db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND (role IS NULL OR role = 'player')");
  db.exec("UPDATE users SET is_admin = 1 WHERE role = 'admin'");
  db.exec("UPDATE users SET role = 'player' WHERE role IS NULL");
  db.exec("UPDATE users SET role = 'organizer' WHERE role = 'facilitator'");

  const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
  if (adminCount === 0) {
    const targetUser = db.prepare("SELECT id, email FROM users WHERE email = 'pickupbaseballfoundation@gmail.com'").get()
      || db.prepare('SELECT id, email FROM users ORDER BY id ASC LIMIT 1').get();
    if (targetUser) {
      db.prepare("UPDATE users SET role = 'admin', is_admin = 1 WHERE id = ?").run(targetUser.id);
      console.log(`[Database] Auto-promoted initial user ${targetUser.email} to Administrator.`);
    }
  }

  const defaultDutiesCount = db.prepare('SELECT COUNT(*) as c FROM default_duties').get().c;
  if (defaultDutiesCount === 0) {
    const insertDefault = db.prepare(
      'INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)'
    );
    DEFAULT_BASEBALL_DUTIES.forEach((d, idx) => {
      insertDefault.run(d.title, d.description || '', d.slots_needed || 1, idx);
    });
  } else {
    const hasFacilitator = db.prepare("SELECT COUNT(*) as c FROM default_duties WHERE title LIKE '%facilitator%'").get().c > 0;
    if (!hasFacilitator) {
      db.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').run(
        'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4
      );
    }
    const hasWaterFood = db.prepare("SELECT COUNT(*) as c FROM default_duties WHERE title LIKE '%water%' OR title LIKE '%food%'").get().c > 0;
    if (!hasWaterFood) {
      db.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').run(
        'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5
      );
    }
  }

  const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim().toLowerCase() : null;
  const adminName = process.env.ADMIN_NAME || 'Organization Admin';
  if (adminEmail) {
    const existing = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(adminEmail);
    if (!existing) {
      db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, 'admin', 1)").run(adminName, adminEmail);
    } else if (!existing.is_admin) {
      db.prepare("UPDATE users SET role = 'admin', is_admin = 1 WHERE id = ?").run(existing.id);
    }
  }
}

function getDefaultDuties() {
  const duties = db.prepare('SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC').all();
  return duties.length > 0 ? duties : DEFAULT_BASEBALL_DUTIES;
}

function saveDefaultDuties(duties) {
  if (!Array.isArray(duties)) return;
  const insert = db.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)');
  const txn = db.transaction((list) => {
    db.prepare('DELETE FROM default_duties').run();
    list.filter(d => d && d.title && d.title.trim()).forEach((d, idx) => {
      insert.run(d.title.trim(), (d.description || '').trim(), parseInt(d.slots_needed || 1, 10), idx);
    });
  });
  txn(duties);
}

module.exports = {
  db,
  d1,
  initDatabase,
  DEFAULT_BASEBALL_DUTIES,
  getDefaultDuties,
  saveDefaultDuties
};
