-- Sunday Pickup Baseball D1 Schema (DDL Only)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  bio TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'player',
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
  attempts INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 1,
  window_start INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS banned_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_attendees_event ON attendees(event_id);
CREATE INDEX IF NOT EXISTS idx_comments_event ON comments(event_id);

-- Default Duties Template
INSERT OR IGNORE INTO default_duties (title, description, slots_needed, sort_order) VALUES
  ('Bases', 'Bring 3 throw-down bases.', 1, 0),
  ('Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1),
  ('Game Baseballs', 'Bring game balls bucket.', 1, 2),
  ('Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3),
  ('Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4),
  ('Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5);
