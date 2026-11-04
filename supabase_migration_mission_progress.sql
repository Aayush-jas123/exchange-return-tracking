-- ═══════════════════════════════════════════════════════════
-- Mission Progress Table for BLACKOUT Campaign
-- Stores athlete mission completion, best times, and scores
-- ═══════════════════════════════════════════════════════════

-- Create mission_progress table
CREATE TABLE IF NOT EXISTS mission_progress (
  id BIGSERIAL PRIMARY KEY,
  athlete_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  progress JSONB NOT NULL DEFAULT '{"completed":[],"bestTimes":{},"scores":{}}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(athlete_id)
);

-- Index for fast athlete lookups
CREATE INDEX IF NOT EXISTS idx_mission_progress_athlete ON mission_progress(athlete_id);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_mission_progress_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_mission_progress_updated_at ON mission_progress;
CREATE TRIGGER trigger_mission_progress_updated_at
  BEFORE UPDATE ON mission_progress
  FOR EACH ROW
  EXECUTE FUNCTION update_mission_progress_updated_at();

-- Enable Row Level Security
ALTER TABLE mission_progress ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role full access (API layer handles athlete auth)
DROP POLICY IF EXISTS "Service role has full access" ON mission_progress;
CREATE POLICY "Service role has full access"
  ON mission_progress FOR ALL
  USING (true)
  WITH CHECK (true);

-- Comments
COMMENT ON TABLE mission_progress IS 'Stores athlete progress for the BLACKOUT campaign missions';
COMMENT ON COLUMN mission_progress.athlete_id IS 'References the athlete (influencer) ID';
COMMENT ON COLUMN mission_progress.progress IS 'JSONB object with completed missions, best times, and scores';
