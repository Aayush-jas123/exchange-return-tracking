-- Migration: Add game unlock settings for athlete portal games
-- Date: 2026-10-24
-- Description: Seeds program_settings entries to control game unlock status.
-- NOTE: program_settings.value is JSONB (booleans must be true/false literals,
-- not quoted strings) and the table has no `category` or `created_at` columns.

-- Insert Fruit Ninja unlock setting (default: locked/false)
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.fruit-ninja.unlocked',
  'false'::jsonb,
  'Whether Fruit Ninja game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Insert Rooftop Racing unlock setting (default: unlocked/true)
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.rooftop-racing.unlocked',
  'true'::jsonb,
  'Whether Rooftop Racing game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
