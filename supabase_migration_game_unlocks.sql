-- Migration: Add game unlock settings for athlete portal games
-- Date: 2026-10-24
-- Description: Seeds program_settings entries to control game unlock status.
-- NOTE: program_settings.value is JSONB (booleans must be true/false literals,
-- not quoted strings) and the table has no `category` or `created_at` columns.
-- Run this in the Supabase SQL Editor. Re-running is safe (ON CONFLICT DO NOTHING).
-- The athlete portal reads these flags and shows a lock overlay on any tile whose
-- flag is false; the athlete admin "Game Management" section toggles them.

-- Rooftop Racing — default unlocked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.rooftop-racing.unlocked',
  'true'::jsonb,
  'Whether Rooftop Racing game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Fruit Ninja — default locked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.fruit-ninja.unlocked',
  'false'::jsonb,
  'Whether Fruit Ninja game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Ping Pong — default unlocked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.ping-pong.unlocked',
  'true'::jsonb,
  'Whether Ping Pong game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Pac-Man — default unlocked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.pac-man.unlocked',
  'true'::jsonb,
  'Whether Pac-Man game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Crossy Road — default unlocked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.crossy-road.unlocked',
  'true'::jsonb,
  'Whether Crossy Road game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
