const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createD1Adapter } = require('./d1-sqlite');
const {
  DEFAULT_BASEBALL_DUTIES,
  CREATE_TABLES_SQL,
  ALTER_STATEMENTS,
  CREATE_CHAT_TABLES_SQL,
  DEFAULT_CHAT_CHANNELS
} = require('./app/schema.js');

const dbDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 1. Baseball DB (existing production database)
const baseballDbPath = process.env.DB_PATH || process.env.BASEBALL_DB_PATH || path.join(dbDir, 'baseball_charity.db');
const baseballDb = new Database(baseballDbPath);
baseballDb.pragma('journal_mode = WAL');
baseballDb.pragma('foreign_keys = ON');
const baseballD1 = createD1Adapter(baseballDb);

// 2. Chat DB (dedicated Clubhouse community database)
const chatDbPath = process.env.CHAT_DB_PATH || path.join(dbDir, 'pickup_chat.db');
const chatDb = new Database(chatDbPath);
chatDb.pragma('journal_mode = WAL');
chatDb.pragma('foreign_keys = ON');
const chatD1 = createD1Adapter(chatDb);

// Backward-compatibility aliases
const db = baseballDb;
const d1 = baseballD1;

function initBaseballDatabase(force = false) {
  for (const sql of CREATE_TABLES_SQL) {
    baseballDb.exec(sql);
  }
  for (const sql of ALTER_STATEMENTS) {
    try { baseballDb.exec(sql); } catch (e) {}
  }

  baseballDb.exec(`
    UPDATE attendees
    SET players_count = CASE WHEN status = 'declined' THEN 0 ELSE 1 + COALESCE(additional_guests, 0) END
    WHERE players_count IS NULL
  `);

  baseballDb.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND (role IS NULL OR role = 'player')");
  baseballDb.exec("UPDATE users SET is_admin = 1 WHERE role = 'admin'");
  baseballDb.exec("UPDATE users SET role = 'player' WHERE role IS NULL");
  baseballDb.exec("UPDATE users SET role = 'organizer' WHERE role = 'facilitator'");

  const adminCount = baseballDb.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
  if (adminCount === 0) {
    const targetUser = baseballDb.prepare("SELECT id, email FROM users WHERE email = 'pickupbaseballfoundation@gmail.com'").get()
      || baseballDb.prepare('SELECT id, email FROM users ORDER BY id ASC LIMIT 1').get();
    if (targetUser) {
      baseballDb.prepare("UPDATE users SET role = 'admin', is_admin = 1 WHERE id = ?").run(targetUser.id);
      console.log(`[Database] Auto-promoted initial user ${targetUser.email} to Administrator.`);
    }
  }

  const defaultDutiesCount = baseballDb.prepare('SELECT COUNT(*) as c FROM default_duties').get().c;
  if (defaultDutiesCount === 0) {
    const insertDefault = baseballDb.prepare(
      'INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)'
    );
    DEFAULT_BASEBALL_DUTIES.forEach((d, idx) => {
      insertDefault.run(d.title, d.description || '', d.slots_needed || 1, idx);
    });
  } else {
    const hasFacilitator = baseballDb.prepare("SELECT COUNT(*) as c FROM default_duties WHERE title LIKE '%facilitator%'").get().c > 0;
    if (!hasFacilitator) {
      baseballDb.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').run(
        'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4
      );
    }
    const hasWaterFood = baseballDb.prepare("SELECT COUNT(*) as c FROM default_duties WHERE title LIKE '%water%' OR title LIKE '%food%'").get().c > 0;
    if (!hasWaterFood) {
      baseballDb.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').run(
        'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5
      );
    }
  }

  const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim().toLowerCase() : null;
  const adminName = process.env.ADMIN_NAME || 'Organization Admin';
  if (adminEmail) {
    const existing = baseballDb.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(adminEmail);
    if (!existing) {
      baseballDb.prepare("INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, 'admin', 1)").run(adminName, adminEmail);
    } else if (!existing.is_admin) {
      baseballDb.prepare("UPDATE users SET role = 'admin', is_admin = 1 WHERE id = ?").run(existing.id);
    }
  }
}

function initChatDatabase(force = false) {
  for (const sql of CREATE_CHAT_TABLES_SQL) {
    try { chatDb.exec(sql); } catch (e) {}
  }
  const insertChannel = chatDb.prepare(`
    INSERT INTO channels (slug, name, category, channel_type, topic, min_role_read, min_role_write, is_encrypted, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `);
  for (const ch of DEFAULT_CHAT_CHANNELS) {
    try {
      insertChannel.run(
        ch.slug,
        ch.name,
        ch.category,
        ch.channel_type,
        ch.topic,
        ch.min_role_read,
        ch.min_role_write,
        ch.is_encrypted,
        ch.sort_order
      );
    } catch (e) {}
  }
}

function initDatabase(force = false) {
  initBaseballDatabase(force);
  initChatDatabase(force);
}

function getDefaultDuties() {
  const duties = baseballDb.prepare('SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC').all();
  return duties.length > 0 ? duties : DEFAULT_BASEBALL_DUTIES;
}

function saveDefaultDuties(duties) {
  if (!Array.isArray(duties)) return;
  const insert = baseballDb.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)');
  const txn = baseballDb.transaction((list) => {
    baseballDb.prepare('DELETE FROM default_duties').run();
    list.filter(d => d && d.title && d.title.trim()).forEach((d, idx) => {
      insert.run(d.title.trim(), (d.description || '').trim(), parseInt(d.slots_needed || 1, 10), idx);
    });
  });
  txn(duties);
}

module.exports = {
  baseballDb,
  chatDb,
  db,
  baseballD1,
  chatD1,
  d1,
  initDatabase,
  initBaseballDatabase,
  initChatDatabase,
  DEFAULT_BASEBALL_DUTIES,
  getDefaultDuties,
  saveDefaultDuties
};
