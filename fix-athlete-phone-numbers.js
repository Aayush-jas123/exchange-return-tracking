#!/usr/bin/env node
/**
 * fix-athlete-phone-numbers.js
 * 
 * Fixes phone numbers in the influencers table that are stored as raw 10-digit
 * numbers (e.g., "9876543210") by normalizing them to the 91XXXXXXXXXX format
 * (e.g., "919876543210") that the OTP login flow expects.
 * 
 * Also fixes phone numbers in the applications table for consistency.
 * 
 * Usage:
 *   node fix-athlete-phone-numbers.js
 * 
 * Environment:
 *   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or in .env)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Normalize Indian phone number to 91XXXXXXXXXX format
 */
function normalizeIndianPhone(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/[^\d]/g, '');
  let digits = null;
  if (cleaned.length === 10) {
    digits = '91' + cleaned;
  } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
    digits = '91' + cleaned.substring(1);
  } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
    digits = cleaned;
  }
  if (!digits) return null;
  // Indian mobiles start with 6-9 after the country code
  if (!/^[6-9]/.test(digits.substring(2))) return null;
  return digits;
}

async function fixInfluencerPhones() {
  console.log('\n=== Fixing influencer phone numbers ===\n');

  // Fetch all influencers
  const { data: influencers, error } = await supabase
    .from('influencers')
    .select('id, name, phone');

  if (error) {
    console.error('Error fetching influencers:', error.message);
    return 0;
  }

  if (!influencers || influencers.length === 0) {
    console.log('No influencers found');
    return 0;
  }

  let fixed = 0;
  let alreadyCorrect = 0;
  let skipped = 0;

  for (const inf of influencers) {
    const phone = inf.phone;

    // Skip null/empty phones
    if (!phone || phone === '0000000000') {
      console.log(`  SKIP ${inf.id} (${inf.name}): no phone or placeholder`);
      skipped++;
      continue;
    }

    // Check if already in correct format (91XXXXXXXXXX)
    if (/^91[6-9]\d{10}$/.test(phone)) {
      console.log(`  OK   ${inf.id} (${inf.name}): ${phone}`);
      alreadyCorrect++;
      continue;
    }

    // Try to normalize
    const normalized = normalizeIndianPhone(phone);
    if (!normalized) {
      console.log(`  SKIP ${inf.id} (${inf.name}): cannot normalize "${phone}"`);
      skipped++;
      continue;
    }

    // Update the record
    const { error: updateErr } = await supabase
      .from('influencers')
      .update({ phone: normalized })
      .eq('id', inf.id);

    if (updateErr) {
      console.error(`  ERR  ${inf.id}: ${updateErr.message}`);
    } else {
      console.log(`  FIX  ${inf.id} (${inf.name}): "${phone}" → "${normalized}"`);
      fixed++;
    }
  }

  console.log(`\nInfluencers: ${fixed} fixed, ${alreadyCorrect} already correct, ${skipped} skipped\n`);
  return fixed;
}

async function fixApplicationPhones() {
  console.log('\n=== Fixing application phone numbers ===\n');

  const { data: applications, error } = await supabase
    .from('applications')
    .select('id, email, phone');

  if (error) {
    console.error('Error fetching applications:', error.message);
    return 0;
  }

  if (!applications || applications.length === 0) {
    console.log('No applications found');
    return 0;
  }

  let fixed = 0;
  let alreadyCorrect = 0;
  let skipped = 0;

  for (const app of applications) {
    const phone = app.phone;

    if (!phone || phone === '0000000000') {
      console.log(`  SKIP ${app.id} (${app.email}): no phone or placeholder`);
      skipped++;
      continue;
    }

    if (/^91[6-9]\d{10}$/.test(phone)) {
      console.log(`  OK   ${app.id} (${app.email}): ${phone}`);
      alreadyCorrect++;
      continue;
    }

    const normalized = normalizeIndianPhone(phone);
    if (!normalized) {
      console.log(`  SKIP ${app.id} (${app.email}): cannot normalize "${phone}"`);
      skipped++;
      continue;
    }

    const { error: updateErr } = await supabase
      .from('applications')
      .update({ phone: normalized })
      .eq('id', app.id);

    if (updateErr) {
      console.error(`  ERR  ${app.id}: ${updateErr.message}`);
    } else {
      console.log(`  FIX  ${app.id} (${app.email}): "${phone}" → "${normalized}"`);
      fixed++;
    }
  }

  console.log(`\nApplications: ${fixed} fixed, ${alreadyCorrect} already correct, ${skipped} skipped\n`);
  return fixed;
}

async function main() {
  console.log('Phone Number Normalization Script');
  console.log('================================');
  console.log(`Supabase: ${supabaseUrl}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const infFixed = await fixInfluencerPhones();
  const appFixed = await fixApplicationPhones();

  console.log('\n================================');
  console.log(`SUMMARY: ${infFixed} influencer records + ${appFixed} application records fixed`);
  console.log('================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
