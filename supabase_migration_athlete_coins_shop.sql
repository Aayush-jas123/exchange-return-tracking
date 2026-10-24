-- ============================================================================
-- Athlete coins + shop settings
-- ----------------------------------------------------------------------------
-- Coins are a spend-only currency (shop), separate from XP — they never count
-- toward levels or rank. Athletes earn them from arcade mini-games and a
-- one-time bonus each time they reach a new level. Uses the existing
-- ledger_entries (currency = 'COIN') and influencers.coin_balance, so no
-- schema change is needed; this only seeds tunable settings. The code falls
-- back to the same defaults if these rows are missing.
-- ============================================================================

INSERT INTO program_settings (key, value, description) VALUES
  ('game.coins_per_run_max',     '10'::jsonb,   'Max coins a single arcade run can earn'),
  ('game.daily_coin_cap',        '50'::jsonb,   'Max arcade coins per athlete per IST day'),
  ('coin.level_up_bonus.CL4',    '100'::jsonb,  'Coins paid once on first reaching CL4'),
  ('coin.level_up_bonus.CL3',    '200'::jsonb,  'Coins paid once on first reaching CL3'),
  ('coin.level_up_bonus.CL2',    '300'::jsonb,  'Coins paid once on first reaching CL2'),
  ('coin.level_up_bonus.CL1',    '500'::jsonb,  'Coins paid once on first reaching CL1'),
  ('coin.level_up_bonus.ZERO',   '1000'::jsonb, 'Coins paid once on first reaching Zero Comfort')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = NOW();
