#!/usr/bin/env node
// ============================================================================
// Backfill discount_codes from the legacy influencers columns
// ----------------------------------------------------------------------------
// migrate-to-athlete-program.js seeded discount_codes once, for the athletes
// that existed at the time. Every athlete added or given a referral_code after
// that run has no discount_codes row, so the portal showed "No code" and
// code-based attribution missed them.
//
// The API now heals on read (services/athlete-program/DiscountCodeService.js);
// this script does the same thing in bulk so the data is consistent up front.
//
// Usage: node backfill-discount-codes.js [--dry-run]
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');
const FALLBACK_PERCENT = 7;

function pct(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : FALLBACK_PERCENT;
}

(async () => {
  const { data: influencers, error } = await supabase
    .from('influencers')
    .select('id, name, instagram_handle, referral_code, discount_value, athlete_status, shopify_price_rule_id, shopify_discount_code_id');
  if (error) {
    console.error('Failed to load influencers:', error.message);
    process.exit(1);
  }

  const { data: existing, error: dcErr } = await supabase
    .from('discount_codes')
    .select('influencer_id, code');
  if (dcErr) {
    console.error('Failed to load discount_codes:', dcErr.message);
    process.exit(1);
  }

  const haveRow = new Set((existing || []).map(d => d.influencer_id));
  const takenCode = new Set((existing || []).map(d => String(d.code).toUpperCase()));

  const missing = (influencers || []).filter(i => i.referral_code && !haveRow.has(i.id));
  console.log(`${influencers.length} athletes, ${existing.length} discount_codes rows, ${missing.length} missing.`);

  let created = 0, skipped = 0, failed = 0;

  for (const inf of missing) {
    const code = String(inf.referral_code).trim();
    if (takenCode.has(code.toUpperCase())) {
      console.log(`  skip ${inf.id} ${inf.name}: code ${code} already belongs to another athlete`);
      skipped++;
      continue;
    }

    const row = {
      influencer_id: inf.id,
      code,
      shopify_price_rule_id: inf.shopify_price_rule_id || null,
      shopify_discount_code_id: inf.shopify_discount_code_id || null,
      percent: pct(inf.discount_value),
      is_active: inf.athlete_status ? inf.athlete_status === 'ACTIVE' : true
    };

    if (DRY_RUN) {
      console.log(`  would create ${inf.id} ${inf.name} -> ${row.code} (${row.percent}%, active=${row.is_active})`);
      created++;
      continue;
    }

    const { error: insErr } = await supabase
      .from('discount_codes')
      .upsert([row], { onConflict: 'code' });
    if (insErr) {
      console.error(`  FAILED ${inf.id} ${inf.name} (${code}):`, insErr.message);
      failed++;
      continue;
    }
    console.log(`  created ${inf.id} ${inf.name} -> ${row.code} (${row.percent}%, active=${row.is_active})`);
    takenCode.add(code.toUpperCase());
    created++;
  }

  console.log(`\n${DRY_RUN ? 'Would create' : 'Created'}: ${created} | skipped: ${skipped} | failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
