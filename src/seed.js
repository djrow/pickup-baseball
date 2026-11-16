const crypto = require('crypto');
const { initDatabase, db, baseballD1, DEFAULT_BASEBALL_DUTIES } = require('./db');
const { resolveConfig } = require('./app/config.js');

async function seedSampleMediaIfEmpty(d1) {
  const mediaCountRow = await d1.prepare('SELECT COUNT(*) as c FROM media_items').first();
  if (!mediaCountRow || mediaCountRow.c !== 0) return;

  const sampleSvg1 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="800" height="500" fill="#003831"/><circle cx="400" cy="250" r="140" fill="#FD5A1E"/><text x="400" y="260" font-family="sans-serif" font-size="32" font-weight="bold" fill="#ffffff" text-anchor="middle">Bushrod Field Opening Day</text><text x="400" y="300" font-family="sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">Morning Field Drag &amp; Line Marking</text></svg>';
  const sampleB64_1 = Buffer.from(sampleSvg1, 'utf8').toString('base64');

  const sampleSvg2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="800" height="500" fill="#1c2b27"/><rect x="100" y="80" width="600" height="340" rx="12" fill="#0c1f1a" stroke="#FD5A1E" stroke-width="4"/><text x="400" y="240" font-family="sans-serif" font-size="30" font-weight="bold" fill="#FD5A1E" text-anchor="middle">9th Inning Walk-Off Rally</text><text x="400" y="280" font-family="sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">Dugout High-Fives &amp; Game Ball Presentation</text></svg>';
  const sampleB64_2 = Buffer.from(sampleSvg2, 'utf8').toString('base64');

  const sampleSvg3 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="800" height="500" fill="#002823"/><polygon points="400,80 700,420 100,420" fill="#FD5A1E" opacity="0.85"/><text x="400" y="320" font-family="sans-serif" font-size="28" font-weight="bold" fill="#ffffff" text-anchor="middle">Summer Classic Showcase</text><text x="400" y="360" font-family="sans-serif" font-size="16" fill="#ffffff" text-anchor="middle">Mosswood Park Diamond 1</text></svg>';
  const sampleB64_3 = Buffer.from(sampleSvg3, 'utf8').toString('base64');

  const insertMediaSql = `
    INSERT INTO media_items (title, caption, media_type, original_url, file_url, file_data, mime_type, file_size, album, date_taken, contributor_name, is_approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `;
  const seedStatements = [
    d1.prepare(insertMediaSql).bind(
      'Bushrod Opening Infield Drag',
      'Field prep crew dragging the diamond and setting out bases at 11 AM.',
      'photo', null, '/api/media/1/file', sampleB64_1, 'image/svg+xml', sampleSvg1.length,
      'Bushrod Field Opening', '2026-10-12', 'Sarah Chen'
    ),
    d1.prepare(insertMediaSql).bind(
      '2026 Fall Season Walk-Off Thriller',
      'Full 9th-inning game recap and highlights from the Sunday Championship.',
      'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      null, null, 0, 'Fall 2026 Season', '2026-10-26', 'Marcus Rivera'
    ),
    d1.prepare(insertMediaSql).bind(
      'Dugout Rally Celebration',
      'Team celebrating the walk-off double at home plate.',
      'photo', null, '/api/media/3/file', sampleB64_2, 'image/svg+xml', sampleSvg2.length,
      'Fall 2026 Season', '2026-10-26', 'Alex Johnson'
    ),
    d1.prepare(insertMediaSql).bind(
      'Pitching Machine Setup & Batting Practice',
      'Morning batting practice warmup session with the pitching machine.',
      'youtube', 'https://www.youtube.com/watch?v=L_LUpnjgPso', 'https://www.youtube.com/watch?v=L_LUpnjgPso',
      null, null, 0, 'Bushrod Field Opening', '2026-10-12', 'Coach Dave'
    ),
    d1.prepare(insertMediaSql).bind(
      'Summer Classic Outfield Catch',
      'Diving catch on the warning track during the August tournament.',
      'photo', null, '/api/media/5/file', sampleB64_3, 'image/svg+xml', sampleSvg3.length,
      'Summer Classic 2026', '2026-08-16', 'Marcus Rivera'
    )
  ];
  await d1.batch(seedStatements);
}

async function seed() {
  await initDatabase();
  const cfg = resolveConfig(process.env);

  console.log('🌱 Seeding sample community event & gallery items...');

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
    `${cfg.COMMUNITY_NAME} (${formattedDate})`,
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

  samplePlayers.forEach((p) => {
    // Ensure user row exists with bio
    let user = db.prepare('SELECT id FROM users WHERE email = ?').get(p.email);
    if (!user) {
      const uRes = db.prepare('INSERT INTO users (name, email, bio) VALUES (?, ?, ?)').run(p.name, p.email, p.bio);
      user = { id: uRes.lastInsertRowid };
    } else {
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(p.bio, user.id);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = 'sha256:' + crypto.createHash('sha256').update(rawToken).digest('hex');
    const attRes = insertAttendee.run(eventId, user.id, p.name, p.email, p.gear, tokenHash);
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

  await seedSampleMediaIfEmpty(baseballD1);

  console.log(`✅ Sample event #${eventId} created for ${formattedDate} with 5 participants, 2 comments, and sample media!`);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
