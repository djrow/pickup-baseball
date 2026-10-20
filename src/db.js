const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Path to SQLite database file (can be overridden via DB_PATH env var)
const dbDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dbDir, 'baseball_charity.db');
const db = new Database(dbPath);

// Enable WAL mode (Write-Ahead Logging) for superior performance and high concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      bio TEXT,
      avatar_url TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE,
      name TEXT,
      code TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT NOT NULL,
      location_url TEXT,
      event_date DATETIME NOT NULL,
      max_players INTEGER DEFAULT NULL,
      status TEXT DEFAULT 'active',
      created_by INTEGER REFERENCES users(id),
      reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event_duties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      slots_needed INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      is_guest INTEGER DEFAULT 0,
      status TEXT DEFAULT 'attending',
      gear_bringing TEXT,
      notes TEXT,
      management_token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, email)
    );

    CREATE TABLE IF NOT EXISTS duty_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duty_id INTEGER NOT NULL REFERENCES event_duties(id) ON DELETE CASCADE,
      attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(duty_id, attendee_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS default_duties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      slots_needed INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
    CREATE INDEX IF NOT EXISTS idx_attendees_event ON attendees(event_id);
    CREATE INDEX IF NOT EXISTS idx_comments_event ON comments(event_id);
  `);

  // Migrate users table columns if upgrading
  const userCols = db.pragma('table_info(users)').map(c => c.name);
  if (!userCols.includes('bio')) {
    db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
  }
  if (!userCols.includes('avatar_url')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  }

  // Seed default duties if table is empty
  const defaultDutiesCount = db.prepare('SELECT COUNT(*) as c FROM default_duties').get().c;
  if (defaultDutiesCount === 0) {
    const insertDefault = db.prepare(`
      INSERT INTO default_duties (title, description, slots_needed, sort_order)
      VALUES (?, ?, ?, ?)
    `);
    DEFAULT_BASEBALL_DUTIES.forEach((d, idx) => {
      insertDefault.run(d.title, d.description || '', d.slots_needed || 1, idx);
    });
    console.log(`[Database] Initialized default duties template (${DEFAULT_BASEBALL_DUTIES.length} tasks).`);
  }

  // Check if admin email is defined in env and ensure they exist
  const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim().toLowerCase() : null;
  const adminName = process.env.ADMIN_NAME || 'Organization Admin';
  if (adminEmail) {
    const existing = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(adminEmail);
    if (!existing) {
      db.prepare('INSERT INTO users (name, email, is_admin) VALUES (?, ?, 1)').run(adminName, adminEmail);
      console.log(`[Database] Initialized default admin user: ${adminEmail}`);
    } else if (!existing.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
      console.log(`[Database] Promoted ${adminEmail} to admin`);
    }
  }
}

// Default duties template for baseball charity
const DEFAULT_BASEBALL_DUTIES = [
  { title: "Bases & Home Plate", description: "Bring 3 throw-down/stake bases and home plate", slots_needed: 1 },
  { title: "Game Baseballs & Scorebook", description: "Bring game balls bucket and pickup roster/scorebook", slots_needed: 1 },
  { title: "Catcher's Gear", description: "Bring shin guards, chest protector, and catcher's helmet", slots_needed: 1 },
  { title: "Team Bats & Helmets", description: "Bring community wood/BBCOR bats & batting helmets", slots_needed: 1 },
  { title: "Field Setup & Cones", description: "Arrive 20 mins early to lay out foul lines and inspect turf/dirt", slots_needed: 2 },
  { title: "Cold Water & First Aid", description: "Bring community ice water jug and basic sports first aid kit", slots_needed: 1 },
  { title: "Umpire / Inning Coordinator", description: "Volunteer to umpire or coordinate team inning rotations", slots_needed: 2 },
  { title: "Post-Game Dugout Cleanup", description: "Ensure dugouts and bleachers are completely clean after the game", slots_needed: 2 }
];

function getDefaultDuties() {
  const duties = db.prepare('SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC').all();
  return duties.length > 0 ? duties : DEFAULT_BASEBALL_DUTIES;
}

function saveDefaultDuties(duties) {
  if (!Array.isArray(duties)) return;
  const insert = db.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)');
  
  const txn = db.transaction((list) => {
    db.prepare('DELETE FROM default_duties').run();
    list.forEach((d, idx) => {
      insert.run(d.title.trim(), (d.description || '').trim(), parseInt(d.slots_needed || 1, 10), idx);
    });
  });
  
  txn(duties);
}

module.exports = {
  db,
  initDatabase,
  DEFAULT_BASEBALL_DUTIES,
  getDefaultDuties,
  saveDefaultDuties
};
