-- Migration: Add avatar builder columns to influencers table
-- Date: 2026-10-26
-- Description: Adds 5 text columns for the avatar builder feature. Each column stores
--              the athlete's selected piece for that slot. Slots unlock at different levels.

-- Add avatar columns with defaults
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS avatar_base TEXT DEFAULT 'walk';
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS avatar_head TEXT DEFAULT 'none';
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS avatar_mark TEXT DEFAULT 'none';
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS avatar_ground TEXT DEFAULT 'none';
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS avatar_frame TEXT DEFAULT 'plain';

-- Add check constraints to enforce valid values
ALTER TABLE influencers ADD CONSTRAINT chk_avatar_base 
  CHECK (avatar_base IN ('stand', 'walk', 'reach', 'bow', 'sit'));

ALTER TABLE influencers ADD CONSTRAINT chk_avatar_head 
  CHECK (avatar_head IN ('none', 'cap', 'hood', 'band', 'mask'));

ALTER TABLE influencers ADD CONSTRAINT chk_avatar_mark 
  CHECK (avatar_mark IN ('none', 'rain', 'breath', 'voice', 'eyes'));

ALTER TABLE influencers ADD CONSTRAINT chk_avatar_ground 
  CHECK (avatar_ground IN ('none', 'line', 'mat', 'blocks', 'water'));

ALTER TABLE influencers ADD CONSTRAINT chk_avatar_frame 
  CHECK (avatar_frame IN ('plain', 'ring', 'invert', 'cut', 'halo'));

-- Create index for faster avatar lookups in leaderboards
CREATE INDEX IF NOT EXISTS idx_influencers_avatar ON influencers(avatar_base, avatar_head, avatar_mark, avatar_ground, avatar_frame);

-- Comment for documentation
COMMENT ON COLUMN influencers.avatar_base IS 'Avatar stance piece - unlocks at ordinal 1 (Comfort Level 5)';
COMMENT ON COLUMN influencers.avatar_head IS 'Avatar head piece - unlocks at ordinal 2 (Comfort Level 4)';
COMMENT ON COLUMN influencers.avatar_mark IS 'Avatar air/mark piece - unlocks at ordinal 3 (Comfort Level 3)';
COMMENT ON COLUMN influencers.avatar_ground IS 'Avatar ground piece - unlocks at ordinal 4 (Comfort Level 2)';
COMMENT ON COLUMN influencers.avatar_frame IS 'Avatar frame piece - unlocks at ordinal 5 (Comfort Level 1), halo at ordinal 6 (Zero Comfort)';
