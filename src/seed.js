const crypto = require('crypto');
const { initDatabase, db, DEFAULT_BASEBALL_DUTIES } = require('./db');

function seed() {
  initDatabase();

  console.log('🌱 Seeding sample Sunday pickup game...');

  // Compute this coming Sunday at 12:00 PM
  const now = new Date();
  const day = now.getDay();
  const daysUntilSunday = (7 - day) % 7 || 7;
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSunday, 12, 0, 0);

  const formattedDate = sunday.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });

  // Create event
  const result = db.prepare(`
    INSERT INTO events (title, description, location, location_url, event_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    `Sunday Pickup Baseball (${formattedDate})`,
    'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and turf/molded cleats. Let the team know below if you can take an open duty or bring extra gear.',
    'Riverside Park - Diamond #1 (96th St)',
    'https://maps.google.com/?q=Riverside+Park+96th+St+Baseball+Field',
    sunday.toISOString()
  );

  const eventId = result.lastInsertRowid;

  // Insert duties
  const insertDuty = db.prepare(`
    INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  const dutyIds = [];
  DEFAULT_BASEBALL_DUTIES.forEach((d, idx) => {
    const res = insertDuty.run(eventId, d.title, d.description, d.slots_needed, idx);
    dutyIds.push(res.lastInsertRowid);
  });

  // Seed sample attendees with profiles & bios
  const samplePlayers = [
    { name: 'Marcus Rivera', email: 'marcus@example.com', bio: 'Shortstop & leadoff hitter. Playing pickup since 2018!', gear: 'Bucket of 24 balls, 2 BBCOR bats', dutyIdx: 1 },
    { name: 'Sarah Chen', email: 'sarah@example.com', bio: 'Utility infielder, always down for extra batting practice.', gear: '3 throw-down bases and home plate', dutyIdx: 0 },
    { name: 'Dave K.', email: 'dave@example.com', bio: 'Catcher / first base. Heavy hitter with slow feet.', gear: 'Full adult catcher gear set', dutyIdx: 2 },
    { name: 'Alex Johnson', email: 'alex@example.com', bio: 'Outfield & pitching relief. Happy to umpire whenever needed.', gear: 'Ice water cooler and cups', dutyIdx: 5 },
    { name: 'Elena Rostova', email: 'elena@example.com', bio: 'New to baseball, having a blast learning to track fly balls.', gear: 'Extra fielding gloves (R and L handed)', dutyIdx: null }
  ];

  const insertAttendee = db.prepare(`
    INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, management_token)
    VALUES (?, ?, ?, ?, 0, 'attending', ?, ?)
  `);

  samplePlayers.forEach((p, idx) => {
    // Ensure user row exists with bio
    let user = db.prepare('SELECT id FROM users WHERE email = ?').get(p.email);
    if (!user) {
      const uRes = db.prepare('INSERT INTO users (name, email, bio) VALUES (?, ?, ?)').run(p.name, p.email, p.bio);
      user = { id: uRes.lastInsertRowid };
    } else {
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(p.bio, user.id);
    }

    const token = crypto.randomBytes(16).toString('hex');
    const attRes = insertAttendee.run(eventId, user.id, p.name, p.email, p.gear, token);
    if (p.dutyIdx !== null && dutyIds[p.dutyIdx]) {
      db.prepare('INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').run(
        dutyIds[p.dutyIdx],
        attRes.lastInsertRowid
      );
    }
  });

  // Seed sample discussion
  const insertComment = db.prepare(`
    INSERT INTO comments (event_id, author_name, author_email, content)
    VALUES (?, ?, ?, ?)
  `);

  insertComment.run(
    eventId,
    'Marcus Rivera',
    'marcus@example.com',
    'Hey everyone! Weather forecast looks sunny and 68°. I have plenty of game balls ready.'
  );

  insertComment.run(
    eventId,
    'Elena Rostova',
    'elena@example.com',
    'Excited for Sunday! Does anyone need an extra glove? I am bringing two spare gloves in my bag.'
  );

  console.log(`✅ Sample game #${eventId} created for ${formattedDate} with 5 players and 2 discussion comments!`);
}

seed();
