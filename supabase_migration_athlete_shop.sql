-- Migration: Athlete coin shop — admin-curated drops + redemption approval
-- Date: 2026-10-29
-- Description:
--   1. shop_products      — the drops an admin lists (image, name, coin price, stock)
--   2. shop_redemptions   — an athlete's "get this" request, approved/rejected by admin
--   3. program_settings   — 'shop.unlocked' master switch for the portal Shop screen
--
-- Coins are held when the athlete requests a drop (one negative COIN ledger row,
-- source_type REDEMPTION) and refunded by a reversal row if the admin rejects it,
-- so the ledger stays append-only and the balance can always be replayed.
--
-- Run this in the Supabase SQL Editor. Re-running is safe (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING).

-- ── 1. Drops ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  coin_price INTEGER NOT NULL CHECK (coin_price > 0),
  category TEXT,
  stock INTEGER,                          -- NULL = unlimited
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_products_active ON shop_products(is_active, sort_order, coin_price);

-- ── 2. Redemption requests ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_redemptions (
  id BIGSERIAL PRIMARY KEY,
  influencer_id BIGINT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES shop_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,             -- snapshot, survives a product edit/delete
  image_url TEXT,
  coin_price INTEGER NOT NULL,            -- snapshot of the price at request time
  size TEXT,
  shipping_address TEXT,                  -- snapshot of the athlete address at request time
  note TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  ledger_entry_id BIGINT,                 -- the COIN debit that held the price
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_redemptions_athlete ON shop_redemptions(influencer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_redemptions_status ON shop_redemptions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_redemptions_product ON shop_redemptions(product_id);

COMMENT ON TABLE shop_products IS 'Coin shop drops listed by admin; price is in coins, never rupees';
COMMENT ON TABLE shop_redemptions IS 'Athlete request to redeem a drop; coins are held on request and refunded on rejection';
COMMENT ON COLUMN shop_redemptions.ledger_entry_id IS 'ledger_entries.id of the COIN hold, reversed when the request is rejected';

-- ── 3. Master switch ────────────────────────────────────────────────────────
-- program_settings.value is JSONB (booleans must be true/false literals, not
-- quoted strings). The portal keeps the Shop screen behind a "Coming soon"
-- veil until this flag is true; the admin Coin Shop section toggles it.
INSERT INTO program_settings (key, value, description, updated_at)
VALUES (
  'shop.unlocked',
  'false'::jsonb,
  'Whether the athlete coin shop is open to athletes (true/false)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
