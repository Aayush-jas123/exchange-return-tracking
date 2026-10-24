-- ============================================================================
-- Athlete progression — CL5 -> Zero Comfort paced over ~3.5-4 months
-- ----------------------------------------------------------------------------
-- Levels move on XP only (missions + arcade + coupon orders), no manual
-- approval / standing / seat cap. Each step also needs a minimum number of
-- days at the previous level, so the fastest possible climb is
-- 14 + 18 + 21 + 24 + 28 = 105 days (~3.5 months). A consistently active
-- athlete (~1 mission/day, arcade, some coupon orders ≈ 170 XP/day) reaches
-- 20,000 XP in ~4 months.
--
--   Level          min_xp   days at previous level   earliest day
--   CL5                 0   —                         0
--   CL4             1,500   14                        14
--   CL3             4,000   18                        32
--   CL2             8,000   21                        53
--   CL1            13,000   24                        77
--   Zero Comfort   20,000   28                        105
--
-- XP sources:
--   missions   task xp_value (+20% on time) on approval
--   orders     20 XP per coupon order + 10 XP per Rs1,000 (reversed on refund)
--   arcade     score-based, max 15 XP/run, 40 XP/day, 30s cooldown
-- Idempotent — safe to re-run.
-- ============================================================================

UPDATE comfort_levels SET min_xp = 0,     min_days_in_previous = NULL, min_standing = NULL, requires_manual_approval = false, seat_cap = NULL, updated_at = NOW() WHERE code = 'CL5';
UPDATE comfort_levels SET min_xp = 1500,  min_days_in_previous = 14,   min_standing = NULL, requires_manual_approval = false, seat_cap = NULL, updated_at = NOW() WHERE code = 'CL4';
UPDATE comfort_levels SET min_xp = 4000,  min_days_in_previous = 18,   min_standing = NULL, requires_manual_approval = false, seat_cap = NULL, updated_at = NOW() WHERE code = 'CL3';
UPDATE comfort_levels SET min_xp = 8000,  min_days_in_previous = 21,   min_standing = NULL, requires_manual_approval = false, seat_cap = NULL, updated_at = NOW() WHERE code = 'CL2';
UPDATE comfort_levels SET min_xp = 13000, min_days_in_previous = 24,   min_standing = NULL, requires_manual_approval = false, seat_cap = NULL, updated_at = NOW() WHERE code = 'CL1';
UPDATE comfort_levels SET min_xp = 20000, min_days_in_previous = 28,   min_standing = NULL, requires_manual_approval = false, seat_cap = NULL, updated_at = NOW() WHERE code = 'ZERO';

INSERT INTO program_settings (key, value, description) VALUES
  ('level.CL5.min_xp',                 '0'::jsonb,     'CL5 promotion threshold'),
  ('level.CL4.min_xp',                 '1500'::jsonb,  'CL4 promotion threshold'),
  ('level.CL3.min_xp',                 '4000'::jsonb,  'CL3 promotion threshold'),
  ('level.CL2.min_xp',                 '8000'::jsonb,  'CL2 promotion threshold'),
  ('level.CL1.min_xp',                 '13000'::jsonb, 'CL1 promotion threshold'),
  ('level.ZERO.min_xp',                '20000'::jsonb, 'Zero Comfort promotion threshold'),
  ('xp.per_order',                     '20'::jsonb,    'XP per coupon order attributed to the athlete'),
  ('xp.per_1000_revenue',              '10'::jsonb,    'XP per Rs1000 net coupon-order revenue'),
  ('game.xp_per_run_max',              '15'::jsonb,    'Max XP a single arcade run can earn'),
  ('game.daily_xp_cap',                '40'::jsonb,    'Max arcade XP per athlete per IST day'),
  ('game.min_seconds_between_runs',    '30'::jsonb,    'Cooldown between XP-earning arcade runs')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = NOW();
