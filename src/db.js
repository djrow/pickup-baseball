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
      actual_attendance INTEGER DEFAULT NULL,
      status TEXT DEFAULT 'active',
      created_by INTEGER REFERENCES users(id),
      reminder_sent INTEGER DEFAULT 0,
      rainout_note TEXT,
      rainout_at DATETIME,
      rainout_email_sent INTEGER DEFAULT 0,
      allowed_emails TEXT DEFAULT NULL,
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
      additional_guests INTEGER DEFAULT 0,
      guest_names TEXT,
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
  if (!userCols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'player'");
  }

  // Migrate events table columns for rainout handling
  const eventCols = db.pragma('table_info(events)').map(c => c.name);
  if (!eventCols.includes('rainout_note')) {
    db.exec('ALTER TABLE events ADD COLUMN rainout_note TEXT');
  }
  if (!eventCols.includes('rainout_at')) {
    db.exec('ALTER TABLE events ADD COLUMN rainout_at DATETIME');
  }
  if (!eventCols.includes('rainout_email_sent')) {
    db.exec('ALTER TABLE events ADD COLUMN rainout_email_sent INTEGER DEFAULT 0');
  }
  if (!eventCols.includes('allowed_emails')) {
    db.exec('ALTER TABLE events ADD COLUMN allowed_emails TEXT DEFAULT NULL');
  }
  if (!eventCols.includes('actual_attendance')) {
    db.exec('ALTER TABLE events ADD COLUMN actual_attendance INTEGER DEFAULT NULL');
  }

  // Migrate attendees table columns for additional guests
  const attendeeCols = db.pragma('table_info(attendees)').map(c => c.name);
  if (!attendeeCols.includes('additional_guests')) {
    db.exec('ALTER TABLE attendees ADD COLUMN additional_guests INTEGER DEFAULT 0');
  }
  if (!attendeeCols.includes('guest_names')) {
    db.exec('ALTER TABLE attendees ADD COLUMN guest_names TEXT');
  }

  // Ensure role synchronization
  db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND (role IS NULL OR role = 'player')");
  db.exec("UPDATE users SET is_admin = 1 WHERE role = 'admin'");
  db.exec("UPDATE users SET role = 'player' WHERE role IS NULL");

  // Bootstrap admin: Ensure at least one admin exists
  const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
  if (adminCount === 0) {
    const targetUser = db.prepare("SELECT id, email FROM users WHERE email = 'pickupbaseballfoundation@gmail.com'").get()
      || db.prepare("SELECT id, email FROM users ORDER BY id ASC LIMIT 1").get();
    if (targetUser) {
      db.prepare("UPDATE users SET role = 'admin', is_admin = 1 WHERE id = ?").run(targetUser.id);
      console.log(`[Database] Auto-promoted initial user ${targetUser.email} to Administrator.`);
    }
  }

  // Auto-correct any legacy events saved with naive 12:00:00Z (which was intended to be 12:00 PM Pacific Time)
  db.exec(`
    UPDATE events
    SET event_date = '2026-10-25T19:00:00.000Z'
    WHERE event_date = '2026-10-25T12:00:00.000Z'
  `);
  db.exec(`
    UPDATE events
    SET event_date = '2026-11-01T20:00:00.000Z'
    WHERE event_date = '2026-11-01T12:00:00.000Z'
  `);

  // Seed default duties if table is empty or missing facilitator/water-food
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
  } else {
    const hasFacilitator = db.prepare("SELECT COUNT(*) as c FROM default_duties WHERE title LIKE '%facilitator%'").get().c > 0;
    if (!hasFacilitator) {
      db.prepare("INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)").run(
        'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4
      );
    }
    const hasWaterFood = db.prepare("SELECT COUNT(*) as c FROM default_duties WHERE title LIKE '%water%' OR title LIKE '%food%'").get().c > 0;
    if (!hasWaterFood) {
      db.prepare("INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)").run(
        'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5
      );
    }
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
  { title: "Bases", description: "Bring 3 throw-down bases.", slots_needed: 1 },
  { title: "Pitching machine and power", description: "Bring a pitching machine and a way to run it on the field.", slots_needed: 1 },
  { title: "Game Baseballs", description: "Bring game balls bucket.", slots_needed: 1 },
  { title: "Field Dragging", description: "Arrive 20 mins early to drag the infield with the pull rake.", slots_needed: 2 },
  { title: "Game Facilitator", description: "Help coordinate teams, batting order, and fair play throughout the game.", slots_needed: 1 },
  { title: "Water / Food", description: "Bring drinking water, ice, and dugout snacks or fruit for players.", slots_needed: 1 }
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
    list.filter(d => d && d.title && d.title.trim()).forEach((d, idx) => {
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
