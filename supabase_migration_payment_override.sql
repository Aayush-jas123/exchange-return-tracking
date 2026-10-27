-- Migration: Manual Payment Override for Waiting-Payment Requests
-- Records an admin-confirmed "override" payment for requests stuck in
-- 'waiting_payment' (customer paid out of band — UPI, cash, gateway down, etc.)
-- Each entry is fully attributed: amount, method, reference, reason, actor, time.
--
-- Run in Supabase SQL Editor, or: node apply-payment-override-migration.js

-- ── Override audit columns ──
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_overridden_at TIMESTAMP;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_override_method VARCHAR(30);      -- upi / bank_transfer / cash / razorpay_manual / other
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_override_reference VARCHAR(120);  -- UPI ref / RRID / txn id / manual marker
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_override_reason VARCHAR(40);      -- gateway_down / paid_elsewhere / partial_payment / fee_waived_manual / other
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_override_notes TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_override_by VARCHAR(80);          -- username of the admin/operator who confirmed

-- Verify columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'requests'
  AND column_name LIKE 'payment_override%'
ORDER BY column_name;
