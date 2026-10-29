// ============================================================================
// CommissionService — the single source of truth for the commission ladder
// ----------------------------------------------------------------------------
// Commission belongs to the comfort level, not to the athlete row: every
// promotion raises the rate paid on every attributed order. Resolution order
// for a level's rate:
//   1. comfort_levels.commission_pct          (admin-editable, canonical)
//   2. comfort_levels.perks.commission_pct    (where the ladder was first seeded)
//   3. program_settings 'commission.default_pct'
//   4. 7 — the flat rate the programme launched with
//
// The rate an order was placed at is frozen on attributed_orders.commission_rate
// and is never recalculated (domain spec §06: commission is frozen at order
// time), so raising a level's rate only ever affects future orders.
// ============================================================================

const supabase = require('../../config/supabase');

const FALLBACK_RATE = 7;
const LADDER_TTL_MS = 15000;
const MAX_RATE = 60;

const ladderCache = { at: 0, rows: null };

function toPct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

const CommissionService = {
  FALLBACK_RATE,

  /** Resolve one level row's commission %, column first, then the perks object. */
  pctOf(level) {
    if (!level) return null;
    const column = toPct(level.commission_pct);
    return column !== null ? column : toPct(level.perks?.commission_pct);
  },

  /** Drop the cached ladder — call after an admin edit so athletes see it immediately. */
  invalidate() {
    ladderCache.at = 0;
    ladderCache.rows = null;
  },

  /**
   * All levels ordered by seniority with commission_pct resolved on each row.
   * Six rows, cached briefly because every commission read needs the ladder.
   */
  async getLadder({ fresh = false } = {}) {
    if (!fresh && ladderCache.rows && Date.now() - ladderCache.at < LADDER_TTL_MS) {
      return ladderCache.rows;
    }
    const { data, error } = await supabase.from('comfort_levels').select('*').order('ordinal');
    if (error) throw error;
    const rows = (data || []).map(level => ({ ...level, commission_pct: this.pctOf(level) }));
    ladderCache.rows = rows;
    ladderCache.at = Date.now();
    return rows;
  },

  async getDefaultRate() {
    const { data } = await supabase
      .from('program_settings')
      .select('value')
      .eq('key', 'commission.default_pct')
      .maybeSingle();
    return toPct(data?.value) ?? FALLBACK_RATE;
  },

  /**
   * Rate for one athlete: their level's rate plus the next and top rungs, so a
   * caller can render "you are at 5%, 7% at the next level" without extra reads.
   *
   * Rates hold across rungs (a level keeps the rate of the anchor below it),
   * so next_rate is the rung right above while next_change_rate is the next rung
   * that actually pays differently — the one a raise is worth waiting for.
   *
   * @param {number} influencerId
   * @param {{fallback?: number|null}} options — rate to use when the athlete has no level
   */
  async getForAthlete(influencerId, { fallback = null } = {}) {
    const { data: athlete, error } = await supabase
      .from('influencers')
      .select('level_id')
      .eq('id', influencerId)
      .maybeSingle();
    if (error) throw error;

    const ladder = await this.getLadder();
    const current = athlete?.level_id ? ladder.find(l => l.id === athlete.level_id) || null : null;
    const next = current ? ladder.find(l => l.ordinal === current.ordinal + 1) || null : null;
    const top = ladder.length ? ladder[ladder.length - 1] : null;

    const rate = this.pctOf(current) ?? fallback ?? await this.getDefaultRate();
    const raise = current
      ? ladder.find(l => l.ordinal > current.ordinal && this.pctOf(l) != null && this.pctOf(l) !== rate) || null
      : null;

    return {
      rate,
      level_id: current?.id ?? null,
      level_name: current?.display_name ?? null,
      level_display_number: current?.display_number ?? null,
      next_rate: this.pctOf(next),
      next_level_name: next?.display_name ?? null,
      next_change_rate: this.pctOf(raise),
      next_change_level_name: raise?.display_name ?? null,
      top_rate: this.pctOf(top),
      top_level_name: top?.display_name ?? null
    };
  },

  /**
   * Admin write: set the commission % of one or more levels.
   * Validates the whole batch before touching the table, so a typo can never
   * leave half the ladder updated.
   *
   * @param {Array<{id:number|string, commission_pct:number|string}>} updates
   */
  async setLevelRates(updates) {
    if (!Array.isArray(updates) || updates.length === 0) throw new Error('levels array is required');

    const clean = updates.map(item => {
      const id = parseInt(item.id);
      const pct = toPct(item.commission_pct);
      if (!id) throw new Error('Every level needs an id');
      if (pct === null) throw new Error(`Every level needs a commission percentage (level ${id})`);
      if (pct < 0 || pct > MAX_RATE) throw new Error(`Commission must be between 0 and ${MAX_RATE}% (level ${id})`);
      return { id, commission_pct: Math.round(pct * 100) / 100 };
    });

    const written = [];
    for (const item of clean) {
      const { data: level, error: readError } = await supabase
        .from('comfort_levels')
        .select('id, perks')
        .eq('id', item.id)
        .single();
      if (readError) throw readError;

      // Keep perks in step with the column: older readers still look there.
      const perks = { ...(level.perks || {}), commission_pct: item.commission_pct };
      const { data, error } = await supabase
        .from('comfort_levels')
        .update({ commission_pct: item.commission_pct, perks, updated_at: new Date().toISOString() })
        .eq('id', item.id)
        .select()
        .single();

      if (error) {
        if (error.code === '42703' || /commission_pct/.test(error.message || '')) {
          throw new Error('comfort_levels.commission_pct is missing — run supabase_migration_level_commission.sql in the Supabase SQL Editor first');
        }
        throw error;
      }
      written.push(data);
    }

    this.invalidate();
    return written;
  }
};

module.exports = CommissionService;
