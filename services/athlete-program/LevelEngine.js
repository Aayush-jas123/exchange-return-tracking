// ============================================================================
// LevelEngine — Derives level from XP + standing, never assigns directly
// ----------------------------------------------------------------------------
// Rules (spec §06):
//   4. Level is derived, never assigned. Only this engine writes level_id.
//   5. Promote ONE level per evaluation, then re-enqueue.
//      An athlete crossing two thresholds earns two promotions, two history rows.
//
// The ladder counts UP by ordinal: ordinal 1 (CL5) -> ordinal 6 (Zero Comfort).
// display_number counts DOWN: 5 -> 1 -> NULL. NEVER compare display_number.
// ============================================================================

const supabase = require('../../config/supabase');
const LedgerService = require('./LedgerService');
const GamificationService = require('./GamificationService');

const LevelEngine = {

  /**
   * Evaluate whether an athlete should be promoted or demoted.
   * Promotes ONE level at a time. Returns result and whether to re-enqueue.
   *
   * @param {number} influencerId
   * @returns {Promise<{result: 'Promoted'|'Candidate'|'Unchanged'|'Demoted', fromLevel: object, toLevel: object|null, reEnqueue: boolean}>}
   */
  async evaluate(influencerId) {
    // Fetch athlete with current level
    const { data: athlete, error: athErr } = await supabase
      .from('influencers')
      .select('id, xp_total, standing_score, level_id, level_since, joined_at, athlete_status')
      .eq('id', influencerId)
      .single();

    if (athErr) throw athErr;
    if (!athlete) throw new Error(`Athlete ${influencerId} not found`);

    // Only evaluate ACTIVE and ON_TRIAL athletes
    if (!['ACTIVE', 'ON_TRIAL'].includes(athlete.athlete_status)) {
      return { result: 'Unchanged', fromLevel: null, toLevel: null, reEnqueue: false };
    }

    // Fetch current level
    let currentLevel = null;
    if (athlete.level_id) {
      const { data: lvl } = await supabase
        .from('comfort_levels')
        .select('*')
        .eq('id', athlete.level_id)
        .single();
      currentLevel = lvl;
    }

    // If no level set, assign to CL5 (ordinal 1) — the starting level
    if (!currentLevel) {
      const { data: cl5 } = await supabase
        .from('comfort_levels')
        .select('*')
        .eq('ordinal', 1)
        .single();

      if (cl5) {
        await this.promote(influencerId, cl5.id, 'INITIAL_PLACEMENT', null);
        return { result: 'Promoted', fromLevel: null, toLevel: cl5, reEnqueue: false };
      }
    }

    // Find next level (higher ordinal = more senior)
    const { data: nextLevel } = await supabase
      .from('comfort_levels')
      .select('*')
      .eq('ordinal', currentLevel.ordinal + 1)
      .maybeSingle();

    if (!nextLevel) {
      return { result: 'Unchanged', fromLevel: currentLevel, toLevel: null, reEnqueue: false };
    }

    // Check promotion requirements
    const meetsXp = athlete.xp_total >= nextLevel.min_xp;
    const meetsStanding = !nextLevel.min_standing || athlete.standing_score >= nextLevel.min_standing;

    // Check min_days_in_previous — this is what paces the climb (CL5 -> Zero
    // takes ~3.5 months minimum no matter how fast XP comes in).
    let meetsTimeReq = true;
    const levelSince = athlete.level_since || athlete.joined_at;
    if (nextLevel.min_days_in_previous && levelSince) {
      const daysInLevel = Math.floor((Date.now() - new Date(levelSince).getTime()) / (1000 * 60 * 60 * 24));
      meetsTimeReq = daysInLevel >= nextLevel.min_days_in_previous;
    }

    // Check seat cap
    if (nextLevel.seat_cap) {
      const { count } = await supabase
        .from('influencers')
        .select('*', { count: 'exact', head: true })
        .eq('level_id', nextLevel.id);

      if (count >= nextLevel.seat_cap) {
        return { result: 'Candidate', fromLevel: currentLevel, toLevel: nextLevel, reEnqueue: false };
      }
    }

    // Check required task codes
    // (Future: verify athlete has completed required tasks)

    if (meetsXp && meetsStanding && meetsTimeReq) {
      // Requires manual approval?
      if (nextLevel.requires_manual_approval) {
        return { result: 'Candidate', fromLevel: currentLevel, toLevel: nextLevel, reEnqueue: false };
      }

      // Auto-promote (ONE level only, then re-enqueue)
      await this.promote(influencerId, nextLevel.id, 'AUTO_PROMOTION', null);
      return { result: 'Promoted', fromLevel: currentLevel, toLevel: nextLevel, reEnqueue: true };
    }

    return { result: 'Unchanged', fromLevel: currentLevel, toLevel: null, reEnqueue: false };
  },

  /**
   * Promote an athlete to a specific level.
   * Updates level_id, creates level_history row, updates level_since.
   *
   * @param {number} influencerId
   * @param {number} toLevelId
   * @param {string} reasonCode
   * @param {string|null} actorId — null = engine, admin email for manual
   */
  async promote(influencerId, toLevelId, reasonCode = 'PROMOTION', actorId = null) {
    // Fetch current level for history
    const { data: athlete } = await supabase
      .from('influencers')
      .select('level_id')
      .eq('id', influencerId)
      .single();

    const fromLevelId = athlete?.level_id || null;

    // Fetch both levels to determine direction
    let direction = 'PROMOTE';
    if (fromLevelId) {
      const { data: fromLvl } = await supabase
        .from('comfort_levels')
        .select('ordinal')
        .eq('id', fromLevelId)
        .single();

      const { data: toLvl } = await supabase
        .from('comfort_levels')
        .select('ordinal')
        .eq('id', toLevelId)
        .single();

      if (toLvl && fromLvl) {
        if (toLvl.ordinal > fromLvl.ordinal) direction = 'PROMOTE';
        else if (toLvl.ordinal < fromLvl.ordinal) direction = 'DEMOTE';
        else direction = 'OVERRIDE';
      }
    }

    // Update influencer
    const { error: updateErr } = await supabase
      .from('influencers')
      .update({
        level_id: toLevelId,
        level_since: new Date().toISOString()
      })
      .eq('id', influencerId);

    if (updateErr) throw updateErr;

    // Create level_history row
    const { error: histErr } = await supabase
      .from('level_history')
      .insert([{
        influencer_id: influencerId,
        from_level_id: fromLevelId,
        to_level_id: toLevelId,
        direction,
        reason_code: reasonCode,
        actor_id: actorId
      }]);

    if (histErr) throw histErr;

    console.log(`[LevelEngine] ${direction}: Athlete ${influencerId} from level ${fromLevelId} -> ${toLevelId} (${reasonCode})`);

    // Level-up coin bonus — paid once per level ever (idempotent key), so a
    // demotion followed by a re-promotion can't farm it. Coins never feed XP.
    if (direction === 'PROMOTE' && reasonCode !== 'INITIAL_PLACEMENT') {
      try {
        const { data: lvl } = await supabase
          .from('comfort_levels')
          .select('code')
          .eq('id', toLevelId)
          .single();
        const bonus = await GamificationService.levelUpCoinBonus(lvl?.code);
        if (bonus > 0) {
          await LedgerService.award(
            influencerId, 'COIN', bonus, 'MANUAL', toLevelId,
            `level_bonus:${influencerId}:${toLevelId}`, 'LEVEL_UP_BONUS', actorId
          );
        }
      } catch (err) {
        console.error(`[LevelEngine] Level-up coin bonus failed for athlete ${influencerId}:`, err.message);
      }
    }
  },

  /**
   * Manual override of an athlete's level by admin.
   * Uses the same path as promotion but with direction=OVERRIDE.
   *
   * @param {number} influencerId
   * @param {number} toLevelId
   * @param {string} reasonCode — mandatory for overrides
   * @param {string} actorId — admin email/ID (mandatory)
   */
  async override(influencerId, toLevelId, reasonCode, actorId) {
    if (!reasonCode) throw new Error('reason_code is mandatory for level overrides');
    if (!actorId) throw new Error('actor_id is mandatory for level overrides');

    await this.promote(influencerId, toLevelId, reasonCode, actorId);

    // Override always uses direction=OVERRIDE — fix the history row
    const { error } = await supabase
      .from('level_history')
      .update({ direction: 'OVERRIDE' })
      .eq('influencer_id', influencerId)
      .order('occurred_at', { ascending: false })
      .limit(1);

    if (error) console.error('[LevelEngine] Failed to set OVERRIDE direction:', error);
  },

  /**
   * Get the full level ladder with athlete's current position.
   *
   * @param {number} influencerId
   * @returns {Promise<{levels: object[], currentOrdinal: number}>}
   */
  async getLadder(influencerId) {
    const { data: levels, error } = await supabase
      .from('comfort_levels')
      .select('*')
      .order('ordinal', { ascending: true });

    if (error) throw error;

    const { data: athlete } = await supabase
      .from('influencers')
      .select('level_id, xp_total, standing_score')
      .eq('id', influencerId)
      .single();

    let currentOrdinal = 0;
    if (athlete?.level_id) {
      const { data: currentLevel } = await supabase
        .from('comfort_levels')
        .select('ordinal')
        .eq('id', athlete.level_id)
        .single();
      currentOrdinal = currentLevel?.ordinal || 0;
    }

    return { levels, currentOrdinal, xpTotal: athlete?.xp_total || 0, standing: athlete?.standing_score || 0 };
  },

  /**
   * Get level history for an athlete.
   *
   * @param {number} influencerId
   * @returns {Promise<object[]>}
   */
  async history(influencerId) {
    const { data, error } = await supabase
      .from('level_history')
      .select('*, from_level:comfort_levels!level_history_from_level_id_fkey(display_name, ordinal), to_level:comfort_levels!level_history_to_level_id_fkey(display_name, ordinal)')
      .eq('influencer_id', influencerId)
      .order('occurred_at', { ascending: false });

    if (error) {
      // Fallback without joins if FK names don't match
      const { data: fallback, error: fbErr } = await supabase
        .from('level_history')
        .select('*')
        .eq('influencer_id', influencerId)
        .order('occurred_at', { ascending: false });

      if (fbErr) throw fbErr;
      return fallback || [];
    }

    return data || [];
  }
};

module.exports = LevelEngine;
