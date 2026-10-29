-- ============================================================================
-- LEVEL-BASED ATHLETE COMMISSION
-- ----------------------------------------------------------------------------
-- Commission stops being a flat rate and becomes a property of the comfort
-- level, as a step ladder: a rate is set on an anchor level and holds on every
-- rung below it until the next anchor, so a raise is worth waiting for.
--
--   anchor  Comfort Level - 5   5%   ->  CL5, CL4 both earn 5%
--   anchor  Comfort Level - 3  10%   ->  CL3, CL2, CL1 all earn 10%
--   anchor  Zero Comfort       15%   ->  top rung earns 15%
--
-- Safe to re-run: only empty rows and rows still holding a value an earlier
-- draft wrote are re-asserted, so a diverged ladder converges back to the step
-- ladder while clearly edited rungs stay put. The older perks JSONB is kept in
-- agreement with the column.
-- ============================================================================

ALTER TABLE comfort_levels
  ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2);

COMMENT ON COLUMN comfort_levels.commission_pct IS
  'Commission % paid to an athlete at this level, applied to attributed order net value. Editable in athlete admin > Configuration > Comfort Levels. The rate an order was placed at stays frozen on attributed_orders.commission_rate.';

-- Seed the step ladder. A row is only written when it is empty or still holds
-- one of the values an earlier draft of this file (or the old perks JSONB) used.
UPDATE comfort_levels
SET commission_pct = CASE code
  WHEN 'CL5'  THEN 5
  WHEN 'CL4'  THEN 5
  WHEN 'CL3'  THEN 10
  WHEN 'CL2'  THEN 10
  WHEN 'CL1'  THEN 10
  WHEN 'ZERO' THEN 15
END,
updated_at = NOW()
WHERE code IN ('CL5', 'CL4', 'CL3', 'CL2', 'CL1', 'ZERO')
  AND (
    commission_pct IS NULL
    OR (code = 'CL4'  AND commission_pct = 7)
    OR (code = 'CL2'  AND commission_pct IN (12, 15))
    OR (code = 'CL1'  AND commission_pct IN (14, 18))
    OR (code = 'ZERO' AND commission_pct = 20)
  );

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
