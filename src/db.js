const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createD1Adapter } = require('./d1-sqlite');
const {
  DEFAULT_BASEBALL_DUTIES,
  ensureDualD1Schema
} = require('./app/schema.js');
const { getPresetDefaultDuties } = require('./app/schema/engine.js');

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

function seedNodeBootstrapDefaults() {
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

async function initDatabase(force = false) {
  await ensureDualD1Schema({ BASEBALL_DB: baseballD1, CHAT_DB: chatD1 }, force, process.env);
  seedNodeBootstrapDefaults();
}

function getDefaultDuties() {
  const duties = baseballDb.prepare(
    'SELECT title, description, slots_needed, sort_order, COALESCE(grants_coordinator, 0) as grants_coordinator, required_badge FROM default_duties ORDER BY sort_order ASC, id ASC'
  ).all();
  return duties.length > 0 ? duties : getPresetDefaultDuties(process.env);
}

module.exports = {
  baseballDb,
  chatDb,
  db,
  baseballD1,
  chatD1,
  d1,
  initDatabase,
  DEFAULT_BASEBALL_DUTIES,
  getDefaultDuties
};
