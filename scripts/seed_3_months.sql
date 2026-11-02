-- Seed next three months of Sunday pickup baseball games (Dec 2026 - Feb 2027)

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2026-12-06T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2026-12-06T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2026-12-13T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2026-12-13T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2026-12-20T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2026-12-20T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2026-12-27T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2026-12-27T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-01-03T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-01-03T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-01-10T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-01-10T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-01-17T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-01-17T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-01-24T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-01-24T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-01-31T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-01-31T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-02-07T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-02-07T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-02-14T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-02-14T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-02-21T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-02-21T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');

INSERT INTO events (title, description, location, location_url, event_date, max_players, status, created_by)
SELECT 'Sunday Pickup Baseball', '', 'Bushrod Park Field 1', '', '2027-02-28T20:00:00.000Z', NULL, 'active', 2
WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Bases', 'Bring 3 throw-down bases.', 1, 0 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Bases');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Pitching machine and power', 'Bring a pitching machine and a way to run it on the field.', 1, 1 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Pitching machine and power');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Baseballs', 'Bring game balls bucket.', 1, 2 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Baseballs');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Field Dragging', 'Arrive 20 mins early to drag the infield with the pull rake.', 2, 3 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Field Dragging');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, 4 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Game Facilitator');

INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
SELECT id, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, 5 FROM events WHERE event_date = '2027-02-28T20:00:00.000Z' AND NOT EXISTS (SELECT 1 FROM event_duties ed WHERE ed.event_id = events.id AND ed.title = 'Water / Food');