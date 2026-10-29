// ============================================================================
// DiscountCodeService — the athlete's live promo code
// ----------------------------------------------------------------------------
// discount_codes is the canonical table (one row per athlete) but it is only
// ever populated by the one-shot athlete-program migration (see
// migrate-to-athlete-program.js). Athletes added or given a code afterwards
// keep it on the legacy influencers columns (referral_code, discount_value,
// shopify_price_rule_id, shopify_discount_code_id) only, so every reader must
// fall back to those and heal the canonical row on the way through. Without
// the fallback the portal reports "No code" for an athlete that clearly has
// one, and code-based order attribution silently misses.
// ============================================================================

const supabase = require('../../config/supabase');

const FALLBACK_PERCENT = 7;
const CODE_FIELDS = 'code, percent, is_active, shopify_price_rule_id, shopify_discount_code_id';

function pct(value) {
  if (value === null || value === undefined || value === '') return FALLBACK_PERCENT;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : FALLBACK_PERCENT;
}

function shape(row) {
  if (!row || !row.code) return null;
  return {
    code: row.code,
    percent: pct(row.percent),
    is_active: row.is_active !== false,
    shopify_price_rule_id: row.shopify_price_rule_id || null,
    shopify_discount_code_id: row.shopify_discount_code_id || null
  };
}

/** Legacy columns on influencers — the only place a post-migration code lives. */
async function legacyCode(influencerId) {
  const { data, error } = await supabase
    .from('influencers')
    .select('id, referral_code, discount_value, athlete_status, shopify_price_rule_id, shopify_discount_code_id')
    .eq('id', influencerId)
    .maybeSingle();
  if (error) {
    console.error('[DiscountCode] legacy lookup failed for athlete', influencerId, '-', error.message);
    return null;
  }
  return data || null;
}

/**
 * Write the canonical row from the legacy columns, mirroring the migration so
 * later readers (attribution, admin exports) find the code without another
 * fallback. Never throws: the caller still gets the legacy code on failure.
 */
async function heal(influencerId, legacy) {
  const row = {
    influencer_id: influencerId,
    code: legacy.referral_code,
    shopify_price_rule_id: legacy.shopify_price_rule_id || null,
    shopify_discount_code_id: legacy.shopify_discount_code_id || null,
    percent: pct(legacy.discount_value),
    is_active: legacy.athlete_status ? legacy.athlete_status === 'ACTIVE' : true
  };

  const { data, error } = await supabase
    .from('discount_codes')
    .upsert([row], { onConflict: 'code' })
    .select(CODE_FIELDS);
  if (error) {
    console.error(`[DiscountCode] could not heal discount_codes for athlete ${influencerId} (code ${row.code}):`, error.message);
    return shape(row);
  }
  return shape((data && data[0]) || row);
}

const DiscountCodeService = {

  /**
   * Resolve the athlete's code, healing discount_codes from the legacy
   * influencers columns when the canonical row is missing.
   * @returns {Promise<{code:string, percent:number, is_active:boolean,
   *   shopify_price_rule_id:string|null, shopify_discount_code_id:string|null}|null>}
   */
  async getForAthlete(influencerId) {
    if (!influencerId) return null;

    // limit(1) rather than maybeSingle(): an athlete can hold more than one
    // historic row and maybeSingle() throws PGRST116 on multiple matches,
    // which used to surface as "No code".
    const { data, error } = await supabase
      .from('discount_codes')
      .select(CODE_FIELDS)
      .eq('influencer_id', influencerId)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      console.error('[DiscountCode] discount_codes lookup failed for athlete', influencerId, '-', error.message);
    } else if (data && data.length) {
      const found = shape(data[0]);
      if (found) return found;
    }

    const legacy = await legacyCode(influencerId);
    if (!legacy || !legacy.referral_code) return null;
    return heal(influencerId, legacy);
  },

  /**
   * Reverse lookup used by order attribution: code -> athlete.
   * Also falls back to influencers.referral_code for post-migration athletes.
   * @returns {Promise<{influencer_id:number, code:string, percent:number, is_active:boolean}|null>}
   */
  async resolveByCode(code) {
    const wanted = String(code || '').trim();
    if (!wanted) return null;

    const { data, error } = await supabase
      .from('discount_codes')
      .select('influencer_id, code, percent, is_active')
      .ilike('code', wanted)
      .limit(1);
    if (error) {
      console.error('[DiscountCode] code lookup failed for', wanted, '-', error.message);
    } else if (data && data.length) {
      return {
        influencer_id: data[0].influencer_id,
        code: data[0].code,
        percent: pct(data[0].percent),
        is_active: data[0].is_active !== false
      };
    }

    const { data: inf, error: infErr } = await supabase
      .from('influencers')
      .select('id, referral_code, discount_value, athlete_status, shopify_price_rule_id, shopify_discount_code_id')
      .ilike('referral_code', wanted)
      .limit(1);
    if (infErr || !inf || !inf.length || !inf[0].referral_code) return null;

    const healed = await heal(inf[0].id, inf[0]);
    if (!healed) return null;
    return {
      influencer_id: inf[0].id,
      code: healed.code,
      percent: healed.percent,
      is_active: healed.is_active
    };
  }
};

module.exports = DiscountCodeService;
