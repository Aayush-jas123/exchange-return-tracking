-- ============================================================================
-- LEVEL-BASED ATHLETE COMMISSION
-- ----------------------------------------------------------------------------
-- Commission stops being a flat rate and becomes a property of the comfort
-- level: the entry level earns least, every promotion raises the rate paid on
-- every order the athlete brings in.
--
-- Only the three levels named in the change request carry a new rate. Every
-- other rung keeps the percentage its perks JSONB already publishes:
--   Comfort Level - 5   5%   (set)
--   Comfort Level - 4   7%   (unchanged)
--   Comfort Level - 3  10%   (set)
--   Comfort Level - 2  15%   (unchanged)
--   Comfort Level - 1  18%   (unchanged)
--   Zero Comfort       15%   (set, was 20%)
--
-- Safe to re-run: existing commission_pct values are never overwritten, and
-- the older perks JSONB is kept in agreement with the column.
-- ============================================================================

ALTER TABLE comfort_levels
  ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2);

COMMENT ON COLUMN comfort_levels.commission_pct IS
  'Commission % paid to an athlete at this level, applied to attributed order net value. Editable in athlete admin > Configuration > Comfort Levels. The rate an order was placed at stays frozen on attributed_orders.commission_rate.';

-- Only these three rungs get an explicit rate, and only when empty, so admin
-- edits survive a re-run.
UPDATE comfort_levels
SET commission_pct = CASE code
  WHEN 'CL5'  THEN 5
  WHEN 'CL3'  THEN 10
  WHEN 'ZERO' THEN 15
END,
updated_at = NOW()
WHERE commission_pct IS NULL
  AND code IN ('CL5', 'CL3', 'ZERO');

-- The rungs that were not part of the request inherit the rate already
-- published in perks, so their commission does not move.
UPDATE comfort_levels
SET commission_pct = (perks ->> 'commission_pct')::numeric,
    updated_at = NOW()
WHERE commission_pct IS NULL
  AND COALESCE(perks ->> 'commission_pct', '') ~ '^[0-9]+(\.[0-9]+)?$';

-- Already ran an earlier draft of this file (it seeded CL2 = 12 and CL1 = 14)?
-- Those two rungs are not part of the change; restore the published rates in
-- the admin console (Configuration > Comfort Levels) or uncomment:
--   UPDATE comfort_levels SET commission_pct = 15 WHERE code = 'CL2';
--   UPDATE comfort_levels SET commission_pct = 18 WHERE code = 'CL1';

-- Keep the legacy perks JSONB identical to the column so both readers agree.
-- Compared numerically: NUMERIC(5,2) renders 5 as "5.00", so a text compare
-- would rewrite perks on every run.
UPDATE comfort_levels
SET perks = jsonb_set(COALESCE(perks, '{}'::jsonb), '{commission_pct}', to_jsonb(commission_pct), true)
WHERE commission_pct IS NOT NULL
  AND (
    COALESCE(perks ->> 'commission_pct', '') !~ '^[0-9]+(\.[0-9]+)?$'
    OR (perks ->> 'commission_pct')::numeric IS DISTINCT FROM commission_pct
  );

-- Rates are percentages, not multipliers: block obvious data-entry mistakes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comfort_levels_commission_pct_check'
  ) THEN
    ALTER TABLE comfort_levels
      ADD CONSTRAINT comfort_levels_commission_pct_check
      CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 60));
  END IF;
END $$;

-- Fallback for athletes who carry no level yet (fresh environments).
INSERT INTO program_settings (key, value, description)
VALUES (
  'commission.default_pct',
  '7'::jsonb,
  'Fallback commission % used when an athlete has no comfort level or that level carries no rate'
)
ON CONFLICT (key) DO NOTHING;
