-- ============================================================================
-- ledger_entries.notes — free-text audit note for manual/admin adjustments
-- ----------------------------------------------------------------------------
-- Admin XP/coin overrides append a ledger row for the delta, but the operator's
-- reason had nowhere to live: reason_code is a machine token (ADMIN_ADJUSTMENT).
-- This optional column carries the human reason. LedgerService.setBalance falls
-- back to the original column set when this has not been applied yet, so the
-- override endpoint keeps working before and after the migration.
-- ============================================================================

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS notes TEXT;

COMMENT ON COLUMN ledger_entries.notes IS 'Free-text audit note (e.g. admin override reason); reason_code stays a machine token';
