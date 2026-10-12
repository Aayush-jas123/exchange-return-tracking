-- Athlete portal: personal rank-history snapshots
-- Run manually in the Supabase SQL Editor before deploying the Ranks tab.

CREATE TABLE IF NOT EXISTS athlete_rank_snapshots (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  captured_on DATE NOT NULL,
  global_rank INTEGER NOT NULL CHECK (global_rank > 0),
  xp_total INTEGER NOT NULL DEFAULT 0,
  level_id INTEGER REFERENCES comfort_levels(id),
  standing_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (influencer_id, captured_on)
);

CREATE INDEX IF NOT EXISTS idx_rank_snapshots_influencer_date
  ON athlete_rank_snapshots(influencer_id, captured_on DESC);
CREATE INDEX IF NOT EXISTS idx_rank_snapshots_date_rank
  ON athlete_rank_snapshots(captured_on DESC, global_rank ASC);
