-- Migration: Add game unlock settings for Tower Blocks and Counter Strike
-- Date: 2026-11-01
-- Description: Seeds program_settings entries to control game unlock status.
-- NOTE: program_settings.value is JSONB (booleans must be true/false literals,
-- not quoted strings) and the table has no `category` or `created_at` columns.
-- Run this in the Supabase SQL Editor. Re-running is safe (ON CONFLICT DO NOTHING).

-- Tower Blocks — default unlocked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.tower-blocks.unlocked',
  'true'::jsonb,
  'Whether Tower Blocks game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Counter Strike — default unlocked
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'game.counter-strike.unlocked',
  'true'::jsonb,
  'Whether Counter Strike game is unlocked for athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
