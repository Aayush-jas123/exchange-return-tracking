// ============================================================================
// Generate/Retrieve Athlete Portal Tokens for Migrated Influencers
// ----------------------------------------------------------------------------
// Run this to get portal access tokens for existing athletes.
// 
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node get-athlete-tokens.js
// ============================================================================

require('dotenv').config();
const supabase = require('./config/supabase');
const crypto = require('crypto');

async function generateTokens() {
  console.log('=== Generate Athlete Portal Tokens ===\n');

  // 1. Get all active athletes
  const { data: athletes, error } = await supabase
    .from('influencers')
    .select('id, name, email, phone, athlete_no, athlete_status')
    .in('athlete_status', ['ACTIVE', 'ON_TRIAL']);

  if (error) {
    console.error('Error fetching athletes:', error.message);
    return;
  }

  console.log(`Found ${athletes.length} active athletes\n`);

  const results = [];

  for (const athlete of athletes) {
    // Check if they already have a PROGRESS token
    const { data: existingTokens } = await supabase
      .from('access_tokens')
      .select('id, scope, created_at')
      .eq('influencer_id', athlete.id)
      .eq('scope', 'PROGRESS')
      .is('revoked_at', null);

    if (existingTokens && existingTokens.length > 0) {
      console.log(`✓ ${athlete.name} (${athlete.athlete_no}) - Already has token`);
      results.push({
        ...athlete,
        status: 'EXISTS',
        message: 'Token already exists (cannot retrieve raw value)'
      });
    } else {
      // Generate new token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const { error: insertErr } = await supabase
        .from('access_tokens')
        .insert([{
          influencer_id: athlete.id,
          scope: 'PROGRESS',
          token_hash: tokenHash,
          expires_at: null,
          single_use: false,
          consumed_at: null,
          revoked_at: null
        }]);

      if (insertErr) {
        console.error(`✗ ${athlete.name} - Error:`, insertErr.message);
        results.push({
          ...athlete,
          status: 'ERROR',
          message: insertErr.message
        });
      } else {
        console.log(`✓ ${athlete.name} (${athlete.athlete_no}) - NEW TOKEN GENERATED`);
        results.push({
          ...athlete,
          status: 'NEW',
          portal_url: process.env.ATHLETE_PORTAL_URL || 'https://offcomfrt.in/pages/athlete-portal',
          access_token: rawToken
        });
      }
    }
  }

  // 2. Output results
  console.log('\n\n=== RESULTS ===\n');

  const newTokens = results.filter(r => r.status === 'NEW');
  const existing = results.filter(r => r.status === 'EXISTS');
  const errors = results.filter(r => r.status === 'ERROR');

  if (newTokens.length > 0) {
    console.log(`\n📋 NEW TOKENS (${newTokens.length}):`);
    console.log('─'.repeat(80));
    newTokens.forEach(r => {
      console.log(`\nAthlete: ${r.name} (${r.athlete_no})`);
      console.log(`Email: ${r.email || 'N/A'}`);
      console.log(`Phone: ${r.phone || 'N/A'}`);
      console.log(`Portal URL: ${r.portal_url}`);
      console.log(`Access Token: ${r.access_token}`);
      console.log('─'.repeat(80));
    });
  }

  if (existing.length > 0) {
    console.log(`\n⚠️  EXISTING TOKENS (${existing.length}):`);
    console.log('These athletes already have tokens. Raw tokens cannot be retrieved.');
    console.log('If they lost their token, use the admin portal to rotate it.');
    existing.forEach(r => {
      console.log(`  - ${r.name} (${r.athlete_no})`);
    });
  }

  if (errors.length > 0) {
    console.log(`\n❌ ERRORS (${errors.length}):`);
    errors.forEach(r => {
      console.log(`  - ${r.name}: ${r.message}`);
    });
  }

  // 3. Save to JSON file
  const fs = require('fs');
  const filename = `athlete-tokens-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(filename, JSON.stringify(results, null, 2));
  console.log(`\n✓ Results saved to: ${filename}`);

  console.log('\n=== DONE ===');
}

generateTokens().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
