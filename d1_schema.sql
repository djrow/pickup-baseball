-- Sunday Pickup Baseball D1 Schema & Seed

CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , bio TEXT, avatar_url TEXT, role TEXT DEFAULT 'player');

INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (1, 'League Organizer', 'admin@baseballcharity.org', 1, '2026-10-19 22:13:28', NULL, NULL, 'admin');
INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (2, 'David Rowland', 'pickupbaseballfoundation@gmail.com', 1, '2026-10-19 22:53:19', NULL, NULL, 'admin');
INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (3, 'Marcus Rivera (Gold Glove)', 'marcus@example.com', 0, '2026-10-20 01:53:32', 'Starting shortstop, 10 years playing Sunday pickup. Bringing extra bats!', NULL, 'player');
INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (4, 'Sarah Chen', 'sarah@example.com', 0, '2026-10-20 01:53:32', 'Utility infielder, always down for extra batting practice.', NULL, 'player');
INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (5, 'Dave K.', 'dave@example.com', 0, '2026-10-20 01:53:32', 'Catcher / first base. Heavy hitter with slow feet.', NULL, 'player');
INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (6, 'Alex Johnson', 'alex@example.com', 0, '2026-10-20 01:53:32', 'Outfield & pitching relief. Happy to umpire whenever needed.', NULL, 'player');
INSERT OR IGNORE INTO "users" ("id", "name", "email", "is_admin", "created_at", "bio", "avatar_url", "role") VALUES (7, 'Elena Rostova', 'elena@example.com', 0, '2026-10-20 01:53:32', 'New to baseball, having a blast learning to track fly balls.', NULL, 'player');

CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('7adcce31946567db950aa2aa799bb976af921ee3ec5d7bb6f5a8f72d593ed043', 1, '2027-01-17T22:14:19.977Z', '2026-10-19 22:14:19');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('b78232a955f8436ddd5ab37c0aaeed319e2ab4b92acb9c5d089bfdf983dcd5f7', 1, '2027-01-17T22:14:47.383Z', '2026-10-19 22:14:47');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('b037b3a0dca7859e7312031b8dcb93d8477e1a16e98498149c642828ac34b007', 1, '2027-01-17T23:31:45.226Z', '2026-10-19 23:31:45');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('c60e0e889ce82537223b31c3c8d0a517c05b00598b53d26621fc45d05bed6c06', 2, '2027-01-18T00:09:46.580Z', '2026-10-20 00:09:46');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('5655a9274e102b03bbc35e2efae9d897433711e609de9ba105f3dbc3ed85eff5', 3, '2027-01-18T01:53:52.873Z', '2026-10-20 01:53:52');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('4066459a9dddaa59c4dd659de4ea8b24e696130dd5e6524b0241ae169d400b90', 3, '2027-01-18T01:54:24.594Z', '2026-10-20 01:54:24');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('affea62971fc03731ca09a6138643c5a7c47bc4c78c8f1548137159c2ad3d2cc', 3, '2027-01-18T01:54:39.526Z', '2026-10-20 01:54:39');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('ea3a5b3c1dc9bdfb351033f24a85c46e111f089a62537ae250783273cb3f84f5', 3, '2027-01-18T01:55:04.501Z', '2026-10-20 01:55:04');
INSERT OR IGNORE INTO "sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('e93b658fe2f235783c8270c9f2b5e083b27b3a2097f93bb80e2ada5ddb0ba90f', 3, '2027-01-18T01:55:43.712Z', '2026-10-20 01:55:43');

CREATE TABLE auth_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE,
      name TEXT,
      code TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

INSERT OR IGNORE INTO "auth_codes" ("id", "email", "name", "code", "token", "expires_at", "used_at", "created_at") VALUES (1, 'admin@baseballcharity.org', 'League Organizer', '105694', '4af28f412ce88d242f981924b90baba4daf937b7221bef41f959fd8d14cf3e39', '2026-10-19T22:34:08.738Z', '2026-10-19 22:14:19', '2026-10-19 22:14:08');
INSERT OR IGNORE INTO "auth_codes" ("id", "email", "name", "code", "token", "expires_at", "used_at", "created_at") VALUES (2, 'admin@baseballcharity.org', 'League Organizer', '342361', 'fffcbeb5b0f421e218275f30f12a434013ff51aab89ce635b3c113d2bcb84c7b', '2026-10-19T22:34:38.592Z', NULL, '2026-10-19 22:14:38');
INSERT OR IGNORE INTO "auth_codes" ("id", "email", "name", "code", "token", "expires_at", "used_at", "created_at") VALUES (3, 'pickupbaseballfoundation@gmail.com', 'david rowland', '836435', '3f8f4ddd5a7433575d2ec64ef212cc45cb79c58e36709850485e597709707812', '2026-10-19T22:44:28.108Z', NULL, '2026-10-19 22:24:28');
INSERT OR IGNORE INTO "auth_codes" ("id", "email", "name", "code", "token", "expires_at", "used_at", "created_at") VALUES (4, 'pickupbaseballfoundation@gmail.com', 'david rowland', '113683', '22e5714082ffebdac788c419cb5179a22199697b7718d7bad847bc973dadbda5', '2026-10-20T00:29:38.276Z', '2026-10-20 00:09:46', '2026-10-20 00:09:38');

CREATE TABLE events (
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

INSERT OR IGNORE INTO "events" ("id", "title", "description", "location", "location_url", "event_date", "max_players", "status", "created_by", "reminder_sent", "created_at") VALUES (8, 'Sunday Pickup Baseball (Sunday, Oct 25)', 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or duties you can take.', 'bushrod field 1', '', '2026-10-25T12:00:00.000Z', NULL, 'active', 2, 0, '2026-10-20 00:31:08');
INSERT OR IGNORE INTO "events" ("id", "title", "description", "location", "location_url", "event_date", "max_players", "status", "created_by", "reminder_sent", "created_at") VALUES (9, 'Sunday Pickup Baseball (Sunday, Oct 25)', 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and turf/molded cleats. Let the team know below if you can take an open duty or bring extra gear.', 'Riverside Park - Diamond #1 (96th St)', 'https://maps.google.com/?q=Riverside+Park+96th+St+Baseball+Field', '2026-10-25T19:00:00.000Z', NULL, 'active', NULL, 0, '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "events" ("id", "title", "description", "location", "location_url", "event_date", "max_players", "status", "created_by", "reminder_sent", "created_at") VALUES (10, 'Sunday Pickup Baseball (Sunday, Oct 25)', 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or duties you can take.', 'Central Park - North Meadow Field #4', '', '2026-10-25T12:00:00.000Z', NULL, 'active', 2, 0, '2026-10-20 02:05:09');

CREATE TABLE event_duties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      slots_needed INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (52, 8, 'Bases & Home Plate', 'Bring 3 throw-down/stake bases and home plate', 1, 0);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (53, 8, 'Game Baseballs & Scorebook', 'Bring game balls bucket and pickup roster/scorebook', 1, 1);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (54, 8, 'Catcher''s Gear', 'Bring shin guards, chest protector, and catcher''s helmet', 1, 2);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (55, 8, 'Team Bats & Helmets', 'Bring community wood/BBCOR bats & batting helmets', 1, 3);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (56, 8, 'Field Setup & Cones', 'Arrive 20 mins early to lay out foul lines and inspect turf/dirt', 2, 4);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (57, 8, 'Cold Water & First Aid', 'Bring community ice water jug and basic sports first aid kit', 1, 5);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (58, 8, 'Umpire / Inning Coordinator', 'Volunteer to umpire or coordinate team inning rotations', 2, 6);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (59, 8, 'Post-Game Dugout Cleanup', 'Ensure dugouts and bleachers are completely clean after the game', 2, 7);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (60, 9, 'Bases & Home Plate', 'Bring 3 throw-down/stake bases and home plate', 1, 0);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (61, 9, 'Game Baseballs & Scorebook', 'Bring game balls bucket and pickup roster/scorebook', 1, 1);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (62, 9, 'Catcher''s Gear', 'Bring shin guards, chest protector, and catcher''s helmet', 1, 2);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (63, 9, 'Team Bats & Helmets', 'Bring community wood/BBCOR bats & batting helmets', 1, 3);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (64, 9, 'Field Setup & Cones', 'Arrive 20 mins early to lay out foul lines and inspect turf/dirt', 2, 4);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (65, 9, 'Cold Water & First Aid', 'Bring community ice water jug and basic sports first aid kit', 1, 5);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (66, 9, 'Umpire / Inning Coordinator', 'Volunteer to umpire or coordinate team inning rotations', 2, 6);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (67, 9, 'Post-Game Dugout Cleanup', 'Ensure dugouts and bleachers are completely clean after the game', 2, 7);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (68, 10, 'Bases & Home Plate', 'Bring 3 throw-down/stake bases and home plate', 1, 0);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (69, 10, 'Game Baseballs & Scorebook', 'Bring game balls bucket and pickup roster/scorebook', 1, 1);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (70, 10, 'Catcher''s Gear', 'Bring shin guards, chest protector, and catcher''s helmet', 1, 2);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (71, 10, 'Team Bats & Helmets', 'Bring community wood/BBCOR bats & batting helmets', 1, 3);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (72, 10, 'Field Setup & Cones', 'Arrive 20 mins early to lay out foul lines and inspect turf/dirt', 2, 4);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (73, 10, 'Cold Water & First Aid', 'Bring community ice water jug and basic sports first aid kit', 1, 5);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (74, 10, 'Umpire / Inning Coordinator', 'Volunteer to umpire or coordinate team inning rotations', 2, 6);
INSERT OR IGNORE INTO "event_duties" ("id", "event_id", "title", "description", "slots_needed", "sort_order") VALUES (75, 10, 'Post-Game Dugout Cleanup', 'Ensure dugouts and bleachers are completely clean after the game', 2, 7);

CREATE TABLE attendees (
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

INSERT OR IGNORE INTO "attendees" ("id", "event_id", "user_id", "name", "email", "is_guest", "status", "gear_bringing", "notes", "management_token", "created_at") VALUES (22, 9, 3, 'Marcus Rivera', 'marcus@example.com', 0, 'attending', 'Bucket of 24 balls, 2 BBCOR bats', NULL, 'fd45e09f77a367d06602445914ee3ffb', '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "attendees" ("id", "event_id", "user_id", "name", "email", "is_guest", "status", "gear_bringing", "notes", "management_token", "created_at") VALUES (23, 9, 4, 'Sarah Chen', 'sarah@example.com', 0, 'attending', '3 throw-down bases and home plate', NULL, '4089e059c86fea4fdc094c42e1b5215c', '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "attendees" ("id", "event_id", "user_id", "name", "email", "is_guest", "status", "gear_bringing", "notes", "management_token", "created_at") VALUES (24, 9, 5, 'Dave K.', 'dave@example.com', 0, 'attending', 'Full adult catcher gear set', NULL, '48167fdc44e2c3b3e3d1597ab2abc2e5', '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "attendees" ("id", "event_id", "user_id", "name", "email", "is_guest", "status", "gear_bringing", "notes", "management_token", "created_at") VALUES (25, 9, 6, 'Alex Johnson', 'alex@example.com', 0, 'attending', 'Ice water cooler and cups', NULL, 'da7674d783676a9dd4942262dea593b8', '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "attendees" ("id", "event_id", "user_id", "name", "email", "is_guest", "status", "gear_bringing", "notes", "management_token", "created_at") VALUES (26, 9, 7, 'Elena Rostova', 'elena@example.com', 0, 'attending', 'Extra fielding gloves (R and L handed)', NULL, '4c93b639452d745a68607b141a93909b', '2026-10-20 01:53:32');

CREATE TABLE duty_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duty_id INTEGER NOT NULL REFERENCES event_duties(id) ON DELETE CASCADE,
      attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(duty_id, attendee_id)
    );

INSERT OR IGNORE INTO "duty_assignments" ("id", "duty_id", "attendee_id", "created_at") VALUES (18, 61, 22, '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "duty_assignments" ("id", "duty_id", "attendee_id", "created_at") VALUES (19, 60, 23, '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "duty_assignments" ("id", "duty_id", "attendee_id", "created_at") VALUES (20, 62, 24, '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "duty_assignments" ("id", "duty_id", "attendee_id", "created_at") VALUES (21, 65, 25, '2026-10-20 01:53:32');

CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

INSERT OR IGNORE INTO "comments" ("id", "event_id", "user_id", "author_name", "author_email", "content", "created_at") VALUES (10, 9, NULL, 'Marcus Rivera', 'marcus@example.com', 'Hey everyone! Weather forecast looks sunny and 68°. I have plenty of game balls ready.', '2026-10-20 01:53:32');
INSERT OR IGNORE INTO "comments" ("id", "event_id", "user_id", "author_name", "author_email", "content", "created_at") VALUES (11, 9, NULL, 'Elena Rostova', 'elena@example.com', 'Excited for Sunday! Does anyone need an extra glove? I am bringing two spare gloves in my bag.', '2026-10-20 01:53:32');

CREATE TABLE default_duties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      slots_needed INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (1, 'Bases & Home Plate', 'Bring 3 throw-down/stake bases and home plate', 1, 0);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (2, 'Game Baseballs & Scorebook', 'Bring game balls bucket and pickup roster/scorebook', 1, 1);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (3, 'Catcher''s Gear', 'Bring shin guards, chest protector, and catcher''s helmet', 1, 2);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (4, 'Team Bats & Helmets', 'Bring community wood/BBCOR bats & batting helmets', 1, 3);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (5, 'Field Setup & Cones', 'Arrive 20 mins early to lay out foul lines and inspect turf/dirt', 2, 4);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (6, 'Cold Water & First Aid', 'Bring community ice water jug and basic sports first aid kit', 1, 5);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (7, 'Umpire / Inning Coordinator', 'Volunteer to umpire or coordinate team inning rotations', 2, 6);
INSERT OR IGNORE INTO "default_duties" ("id", "title", "description", "slots_needed", "sort_order") VALUES (8, 'Post-Game Dugout Cleanup', 'Ensure dugouts and bleachers are completely clean after the game', 2, 7);

CREATE INDEX idx_events_date ON events(event_date);
CREATE INDEX idx_attendees_event ON attendees(event_id);
CREATE INDEX idx_comments_event ON comments(event_id);
