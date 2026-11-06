-- ============================================================================
-- ATHLETE PROGRAM DOMAIN MIGRATION
-- ----------------------------------------------------------------------------
-- Transforms the flat influencer system into the full Athlete Program domain.
-- 14 objects, 3 state machines, ledger-based XP/coins, 6-level comfort ladder.
-- Companion document: FM-OFC-03 (Domain Build Spec)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0. PREREQUISITES — ensure base influencers table exists, then add columns
-- ────────────────────────────────────────────────────────────────────────────

-- Create base influencers table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS influencers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  referral_code TEXT,
  link_token TEXT,
  commission_rate NUMERIC(5,2) DEFAULT 5,
  status TEXT DEFAULT 'active',
  instagram_handle TEXT,
  youtube_handle TEXT,
  follower_count INTEGER,
  niche TEXT,
  city TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns to existing influencers table (idempotent)
ALTER TABLE influencers
  ADD COLUMN IF NOT EXISTS athlete_no TEXT,
  ADD COLUMN IF NOT EXISTS level_id INTEGER,
  ADD COLUMN IF NOT EXISTS xp_total INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coin_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standing_score NUMERIC(5,2) NOT NULL DEFAULT 70.00,
  ADD COLUMN IF NOT EXISTS manager_id BIGINT REFERENCES influencers(id),
  ADD COLUMN IF NOT EXISTS referred_by_id BIGINT REFERENCES influencers(id),
  ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS level_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS benefit_value_fy NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS leaderboard_opt_out BOOLEAN NOT NULL DEFAULT false;

-- New status column with full enum (keep old status for migration, add athlete_status)
ALTER TABLE influencers
  ADD COLUMN IF NOT EXISTS athlete_status TEXT NOT NULL DEFAULT 'ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'influencers_athlete_status_check'
  ) THEN
    ALTER TABLE influencers
      ADD CONSTRAINT influencers_athlete_status_check
      CHECK (athlete_status IN (
        'APPLIED', 'SCREENING', 'REJECTED', 'ON_TRIAL', 'TRIAL_LAPSED',
        'ACTIVE', 'RESERVE', 'SUSPENDED', 'DISCHARGED', 'BLACKLISTED'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_influencers_athlete_status ON influencers(athlete_status);
CREATE INDEX IF NOT EXISTS idx_influencers_athlete_no ON influencers(athlete_no) WHERE athlete_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_influencers_level_id ON influencers(level_id) WHERE level_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_influencers_standing ON influencers(standing_score DESC);
CREATE INDEX IF NOT EXISTS idx_influencers_xp ON influencers(xp_total DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 1. PEOPLE
-- ────────────────────────────────────────────────────────────────────────────

-- 1a. influencer_socials — one row per platform handle
CREATE TABLE IF NOT EXISTS influencer_socials (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube', 'twitter', 'facebook', 'tiktok', 'other')),
  handle TEXT NOT NULL,
  followers INTEGER DEFAULT 0,
  avg_views INTEGER DEFAULT 0,
  engagement_rate NUMERIC(5,2) DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(influencer_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_socials_influencer ON influencer_socials(influencer_id);
CREATE INDEX IF NOT EXISTS idx_socials_platform_handle ON influencer_socials(platform, LOWER(handle));

-- 1b. applications — requests to join, before influencer record exists
CREATE TABLE IF NOT EXISTS applications (
  id BIGSERIAL PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  primary_handle TEXT,
  auto_score INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'APPLIED'
    CHECK (status IN ('APPLIED', 'SCREENING', 'REJECTED', 'APPROVED')),
  decision_reason TEXT,
  influencer_id BIGINT REFERENCES influencers(id),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_applications_phone ON applications(phone);
CREATE INDEX IF NOT EXISTS idx_applications_auto_score ON applications(auto_score DESC);

-- 1c. access_tokens — scoped, one table for all athlete-facing links
CREATE TABLE IF NOT EXISTS access_tokens (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('PROGRESS', 'SUBMISSION', 'ADDRESS', 'ONBOARDING')),
  subject_id BIGINT,  -- assignment_id for SUBMISSION, shipment_request_id for ADDRESS, null otherwise
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,  -- null = permanent (PROGRESS tokens)
  single_use BOOLEAN NOT NULL DEFAULT false,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_influencer ON access_tokens(influencer_id);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_scope ON access_tokens(influencer_id, scope) WHERE revoked_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. THE LADDER
-- ────────────────────────────────────────────────────────────────────────────

-- 2a. comfort_levels — exactly 6 rows, seeded below
CREATE TABLE IF NOT EXISTS comfort_levels (
  id SERIAL PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,  -- 1..6, THIS is the comparison key
  code TEXT NOT NULL UNIQUE,  -- CL5, CL4, CL3, CL2, CL1, ZERO
  display_name TEXT NOT NULL,
  display_number INTEGER,  -- 5,4,3,2,1,NULL — RENDER ONLY, never compare
  min_xp INTEGER NOT NULL DEFAULT 0,
  min_standing NUMERIC(5,2),  -- null = no standing requirement
  min_days_in_previous INTEGER,  -- null = no time requirement
  required_task_codes TEXT[] DEFAULT '{}',
  requires_manual_approval BOOLEAN NOT NULL DEFAULT false,
  seat_cap INTEGER,  -- null = unlimited
  is_trial_level BOOLEAN NOT NULL DEFAULT false,
  dial_segments_lit INTEGER NOT NULL DEFAULT 0,
  perks JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE MOST IMPORTANT COMMENT IN THIS SYSTEM:
-- display_number runs 5 -> 1 then NULL. ordinal runs 1 -> 6.
-- A senior athlete has a HIGHER ordinal and a LOWER display_number.
-- NEVER compare display_number for seniority. ALWAYS compare ordinal.
COMMENT ON COLUMN comfort_levels.display_number IS
  'RENDER-ONLY. Runs 5→1 then NULL. ordinal runs 1→6. NEVER compare this column for seniority — ALWAYS use ordinal. Higher ordinal = more senior.';
COMMENT ON COLUMN comfort_levels.ordinal IS
  'The SOLE comparison key for seniority. Higher ordinal = more senior athlete.';

-- Seed the 6 levels
INSERT INTO comfort_levels (ordinal, code, display_name, display_number, min_xp, min_standing, min_days_in_previous, requires_manual_approval, seat_cap, is_trial_level, dial_segments_lit, perks)
VALUES
  (1, 'CL5',   'Comfort Level - 5', 5,    0,     NULL, NULL,  false, NULL, true,  5, '{"discount_pct": 15, "commission_pct": 5}'::jsonb),
  (2, 'CL4',   'Comfort Level - 4', 4,    100,   NULL, NULL,  false, NULL, false, 4, '{"discount_pct": 20, "commission_pct": 7}'::jsonb),
  (3, 'CL3',   'Comfort Level - 3', 3,    500,   60,   45,   false, NULL, false, 3, '{"discount_pct": 25, "commission_pct": 10}'::jsonb),
  (4, 'CL2',   'Comfort Level - 2', 2,    1500,  70,   120,  false, NULL, false, 2, '{"discount_pct": 35, "commission_pct": 15}'::jsonb),
  (5, 'CL1',   'Comfort Level - 1', 1,    4000,  75,   180,  true,  NULL, false, 1, '{"discount_pct": 40, "commission_pct": 18}'::jsonb),
  (6, 'ZERO',  'Zero Comfort',      NULL, 10000, 80,   365,  true,  10,   false, 0, '{"discount_pct": 45, "commission_pct": 20}'::jsonb)
ON CONFLICT (ordinal) DO NOTHING;

-- Add FK from influencers to comfort_levels
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'influencers_level_id_fkey'
  ) THEN
    ALTER TABLE influencers
      ADD CONSTRAINT influencers_level_id_fkey
      FOREIGN KEY (level_id) REFERENCES comfort_levels(id);
  END IF;
END $$;

-- 2b. level_history — append-only log of every level movement
CREATE TABLE IF NOT EXISTS level_history (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  from_level_id INTEGER REFERENCES comfort_levels(id),
  to_level_id INTEGER NOT NULL REFERENCES comfort_levels(id),
  direction TEXT NOT NULL CHECK (direction IN ('PROMOTE', 'DEMOTE', 'OVERRIDE')),
  reason_code TEXT NOT NULL,
  actor_id TEXT,  -- null = engine, admin email/ID for manual overrides
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_level_history_influencer ON level_history(influencer_id);
CREATE INDEX IF NOT EXISTS idx_level_history_occurred ON level_history(occurred_at DESC);

-- 2c. ledger_entries — append-only, the ONLY way XP or coins change
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('XP', 'COIN')),
  amount INTEGER NOT NULL,  -- signed: positive = credit, negative = debit
  balance_after INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('ASSIGNMENT', 'ORDER', 'REFERRAL', 'MANUAL', 'REVERSAL', 'EXPIRY', 'REDEMPTION')),
  source_id BIGINT,  -- assignment_id, order_id, etc.
  reason_code TEXT NOT NULL,
  actor_id TEXT,  -- null = system, admin email for manual entries
  reverses_entry_id BIGINT REFERENCES ledger_entries(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_influencer ON ledger_entries(influencer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_currency ON ledger_entries(influencer_id, currency);
CREATE INDEX IF NOT EXISTS idx_ledger_source ON ledger_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_entries(created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. WORK
-- ────────────────────────────────────────────────────────────────────────────

-- 3a. task_templates — reusable definitions of work
CREATE TABLE IF NOT EXISTS task_templates (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  brief_md TEXT,
  type TEXT NOT NULL CHECK (type IN (
    'CONTENT_POST', 'UGC_RAW', 'REVIEW', 'SALES', 'REFERRAL',
    'EVENT', 'SURVEY', 'STREAK', 'CHALLENGE'
  )),
  platform TEXT,  -- instagram, youtube, etc.
  xp_value INTEGER NOT NULL DEFAULT 0,
  coin_value INTEGER NOT NULL DEFAULT 0,
  due_days INTEGER NOT NULL DEFAULT 7,
  proof_type TEXT DEFAULT 'URL',  -- URL, FILE, URL_AND_FILE
  requires_disclosure BOOLEAN NOT NULL DEFAULT true,
  repeatable BOOLEAN NOT NULL DEFAULT true,
  cooldown_days INTEGER DEFAULT 0,
  monthly_cap INTEGER,  -- null = unlimited
  level_gate_id INTEGER REFERENCES comfort_levels(id),
  is_trial_task BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_type ON task_templates(type);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON task_templates(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_tasks_trial ON task_templates(is_trial_task) WHERE is_trial_task = true;
CREATE INDEX IF NOT EXISTS idx_tasks_level_gate ON task_templates(level_gate_id) WHERE level_gate_id IS NOT NULL;

-- 3b. assignments — one athlete's instance of a task
CREATE TABLE IF NOT EXISTS assignments (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  task_template_id BIGINT NOT NULL REFERENCES task_templates(id),
  campaign_id TEXT,
  status TEXT NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN (
      'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED',
      'APPROVED', 'VERIFIED_LIVE', 'REJECTED', 'EXPIRED', 'CLAWED_BACK'
    )),
  due_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewer_id TEXT,
  xp_awarded INTEGER DEFAULT 0,
  coin_awarded INTEGER DEFAULT 0,
  was_on_time BOOLEAN,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  liveness_check_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignments_influencer ON assignments(influencer_id);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);
CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_at) WHERE status NOT IN ('APPROVED', 'VERIFIED_LIVE', 'REJECTED', 'EXPIRED', 'CLAWED_BACK');
CREATE INDEX IF NOT EXISTS idx_assignments_review_queue ON assignments(status, due_at)
  WHERE status IN ('SUBMITTED', 'UNDER_REVIEW');
CREATE INDEX IF NOT EXISTS idx_assignments_campaign ON assignments(campaign_id) WHERE campaign_id IS NOT NULL;

-- 3c. submissions — one attempt at proving an assignment
CREATE TABLE IF NOT EXISTS submissions (
  id BIGSERIAL PRIMARY KEY,
  assignment_id BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  post_url TEXT,
  url_hash TEXT UNIQUE,
  posted_at TIMESTAMPTZ,
  caption TEXT,  -- stored at submission time (snapshot)
  file_ids TEXT[] DEFAULT '{}',
  asset_phash TEXT,  -- perceptual hash for duplicate detection
  disclosure_found BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_url_hash ON submissions(url_hash) WHERE url_hash IS NOT NULL;

-- 3d. submission_metrics — one row per capture, never overwritten
CREATE TABLE IF NOT EXISTS submission_metrics (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  still_live BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_metrics_submission ON submission_metrics(submission_id);
CREATE INDEX IF NOT EXISTS idx_metrics_captured ON submission_metrics(captured_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. GOODS AND MONEY
-- ────────────────────────────────────────────────────────────────────────────

-- 4a. shipment_requests — intent to send product (separate from physical)
CREATE TABLE IF NOT EXISTS shipment_requests (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('SEEDING', 'PROMOTION_PRIZE', 'CAMPAIGN', 'REDEMPTION', 'REPLACEMENT')),
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN (
      'REQUESTED', 'APPROVED', 'ADDRESS_CONFIRMED', 'PACKED', 'DISPATCHED',
      'IN_TRANSIT', 'DELIVERED', 'NDR', 'RTO', 'LOST', 'CANCELLED'
    )),
  address_id BIGINT,  -- future: reference to an addresses table
  address_snapshot JSONB,  -- captured address at time of request
  requested_by TEXT,  -- 'admin' or influencer_id
  approved_by TEXT,
  declared_value NUMERIC(10,2),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{variant_id, qty, title, image_url}]
  admin_notes TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipreq_influencer ON shipment_requests(influencer_id);
CREATE INDEX IF NOT EXISTS idx_shipreq_status ON shipment_requests(status);
CREATE INDEX IF NOT EXISTS idx_shipreq_reason ON shipment_requests(reason);

-- 4b. shipments — physical consignment (enhance existing influencer_product_shipments)
-- We keep the existing table and add new columns
CREATE TABLE IF NOT EXISTS influencer_product_shipments (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT REFERENCES influencers(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE influencer_product_shipments
  ADD COLUMN IF NOT EXISTS shipment_request_id BIGINT REFERENCES shipment_requests(id),
  ADD COLUMN IF NOT EXISTS shopify_order_id BIGINT,
  ADD COLUMN IF NOT EXISTS carrier TEXT DEFAULT 'delhivery',
  ADD COLUMN IF NOT EXISTS awb TEXT,
  ADD COLUMN IF NOT EXISTS shipment_status TEXT DEFAULT 'PENDING'
    CHECK (shipment_status IS NULL OR shipment_status IN (
      'PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'NDR', 'RTO', 'LOST'
    )),
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ndr_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_shipments_request ON influencer_product_shipments(shipment_request_id) WHERE shipment_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_awb ON influencer_product_shipments(awb) WHERE awb IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_status ON influencer_product_shipments(shipment_status) WHERE shipment_status IS NOT NULL;

-- 4c. discount_codes — extracted from influencers table
CREATE TABLE IF NOT EXISTS discount_codes (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  shopify_price_rule_id TEXT,
  shopify_discount_code_id TEXT,
  percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discount_influencer ON discount_codes(influencer_id);
CREATE INDEX IF NOT EXISTS idx_discount_code ON discount_codes(LOWER(code));

-- 4d. attributed_orders — replaces influencer_orders with frozen commission
CREATE TABLE IF NOT EXISTS attributed_orders (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  shopify_order_id BIGINT NOT NULL UNIQUE,
  code_used TEXT,
  attribution_method TEXT NOT NULL DEFAULT 'CODE'
    CHECK (attribution_method IN ('CODE', 'UTM', 'LINK')),
  net_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  placed_at TIMESTAMPTZ NOT NULL,
  is_cancelled BOOLEAN NOT NULL DEFAULT false,
  refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_self_purchase BOOLEAN NOT NULL DEFAULT false,
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,  -- FROZEN at order time
  commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (commission_status IN ('PENDING', 'EARNED', 'REVERSED', 'PAID')),
  currency TEXT DEFAULT 'INR',
  customer_name TEXT,
  financial_status TEXT,
  fulfillment_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attr_orders_influencer ON attributed_orders(influencer_id);
CREATE INDEX IF NOT EXISTS idx_attr_orders_placed ON attributed_orders(placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_attr_orders_code ON attributed_orders(LOWER(code_used));
CREATE INDEX IF NOT EXISTS idx_attr_orders_commission ON attributed_orders(commission_status) WHERE commission_status != 'PAID';

-- 4e. payout_methods — where money goes
CREATE TABLE IF NOT EXISTS payout_methods (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('upi_vpa', 'bank_transfer')),
  upi_vpa TEXT,
  vpa_verified_name TEXT,
  name_match_status TEXT CHECK (name_match_status IS NULL OR name_match_status IN ('MATCH', 'PARTIAL', 'MISMATCH')),
  bank_account_no TEXT,
  bank_ifsc TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_methods_influencer ON payout_methods(influencer_id);
CREATE INDEX IF NOT EXISTS idx_payout_methods_verified ON payout_methods(status) WHERE status = 'VERIFIED';

-- 4f. payouts — replaces influencer_payouts with full lifecycle
CREATE TABLE IF NOT EXISTS payouts (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  payout_method_id BIGINT REFERENCES payout_methods(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross NUMERIC(12,2) NOT NULL DEFAULT 0,
  tds_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  net NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'QUEUED', 'SENT', 'FAILED', 'REVERSED')),
  idempotency_key TEXT NOT NULL UNIQUE,  -- unique on influencer + period
  gateway_payout_id TEXT,
  utr_reference TEXT,
  notes TEXT,
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payouts_influencer ON payouts(influencer_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_period ON payouts(period_end DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. PROGRAM SETTINGS — all configurable values, editable without deploy
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS program_settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

-- Seed all configuration keys from spec section 07
INSERT INTO program_settings (key, value, description) VALUES
  -- Trial
  ('trial.window_days',          '30'::jsonb,                          'Length of CL5 trial from delivery'),
  ('trial.extension_days',       '15'::jsonb,                          'Single permitted extension'),
  ('trial.nudge_days',           '[7,14,21,27]'::jsonb,                'Reminder schedule (days from delivery)'),

  -- XP values
  ('xp.content_post',            '50'::jsonb,                          'Base XP for CONTENT_POST tasks'),
  ('xp.ugc_raw',                 '80'::jsonb,                          'Base XP for UGC_RAW tasks'),
  ('xp.review',                  '30'::jsonb,                          'Base XP for REVIEW tasks'),
  ('xp.sales',                   '100'::jsonb,                         'Base XP for SALES tasks'),
  ('xp.referral',                '40'::jsonb,                          'Base XP for REFERRAL tasks'),
  ('xp.event',                   '60'::jsonb,                          'Base XP for EVENT tasks'),
  ('xp.survey',                  '20'::jsonb,                          'Base XP for SURVEY tasks'),
  ('xp.streak',                  '15'::jsonb,                          'Base XP per day for STREAK tasks'),
  ('xp.challenge',               '120'::jsonb,                         'Base XP for CHALLENGE tasks'),
  ('xp.on_time_bonus_pct',       '20'::jsonb,                          'Bonus % applied to base XP for on-time submission'),
  ('xp.late_penalty_pct',        '25'::jsonb,                          'Penalty % applied to base XP for late submission'),
  ('xp.per_order',               '10'::jsonb,                          'XP per verified attributed order'),
  ('xp.per_1000_revenue',        '20'::jsonb,                          'XP per Rs1000 net attributed revenue'),
  ('xp.manual_approval_threshold', '100'::jsonb,                       'Single awards above this need second admin'),

  -- Level thresholds (mirrors comfort_levels but editable)
  ('level.CL5.min_xp',           '0'::jsonb,                           'CL5 promotion threshold'),
  ('level.CL4.min_xp',           '100'::jsonb,                         'CL4 promotion threshold'),
  ('level.CL3.min_xp',           '500'::jsonb,                         'CL3 promotion threshold'),
  ('level.CL2.min_xp',           '1500'::jsonb,                        'CL2 promotion threshold'),
  ('level.CL1.min_xp',           '4000'::jsonb,                        'CL1 promotion threshold'),
  ('level.ZERO.min_xp',          '10000'::jsonb,                       'Zero Comfort promotion threshold'),

  -- Inactivity
  ('inactivity.at_risk_days',    '45'::jsonb,                          'Days before Comfort Creep flag'),
  ('inactivity.reserve_days',    '90'::jsonb,                          'Days before move to Reserve'),
  ('inactivity.discharge_days',  '180'::jsonb,                         'Days before discharge from Reserve'),

  -- Liveness
  ('liveness.horizon_days',      '30'::jsonb,                          'Days a post must stay live for permanent XP'),

  -- Leaderboard
  ('leaderboard.visible_count',  '10'::jsonb,                          'Public positions shown'),
  ('leaderboard.period',         '"monthly"'::jsonb,                   'Reset cadence (monthly/quarterly/all_time)'),

  -- Payouts
  ('payout.minimum_amount',      '500'::jsonb,                         'Below this, roll over to next period'),
  ('payout.second_approval_above', 'null'::jsonb,                      'Dual-approval threshold (TBD)'),

  -- Messaging
  ('messaging.quiet_hours',      '"21:00-09:00"'::jsonb,               'IST quiet hours for automated sends'),
  ('messaging.daily_cap',        '2'::jsonb,                           'Automated messages per athlete per day')
ON CONFLICT (key) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. TRIGGERS — auto-update updated_at
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION athlete_program_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all new tables
DO $$
DECLARE
  t TEXT;
  tbl_list TEXT[] := ARRAY[
    'influencer_socials', 'applications', 'access_tokens', 'comfort_levels',
    'task_templates', 'assignments', 'submissions',
    'shipment_requests', 'discount_codes', 'attributed_orders',
    'payout_methods', 'payouts'
  ];
BEGIN
  FOREACH t IN ARRAY tbl_list LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I;
       CREATE TRIGGER trg_%s_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION athlete_program_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. VERIFICATION
-- ────────────────────────────────────────────────────────────────────────────

-- Run these to verify:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('influencer_socials','applications','access_tokens','comfort_levels',
--     'level_history','ledger_entries','task_templates','assignments','submissions',
--     'submission_metrics','shipment_requests','discount_codes','attributed_orders',
--     'payout_methods','payouts','program_settings')
--   ORDER BY table_name;
--
-- SELECT * FROM comfort_levels ORDER BY ordinal;
-- SELECT * FROM program_settings ORDER BY key;
