// ============================================================================
// GamificationService — Daily Tasks, Weekly Challenges, Streaks, Badges
// ----------------------------------------------------------------------------
// Handles all game mechanics on top of the athlete program:
//   - Daily task pools & picks
//   - Weekly challenges & leaderboard
//   - Streak tracking & milestone rewards
//   - Badge eligibility & awards
// ============================================================================

const supabase = require('../../config/supabase');
const LedgerService = require('./LedgerService');

// Arcade scoring: how many score units equal 1 XP / 1 coin for each mini-game.
const GAME_RULES = {
  // `verified` games are only paid from a server-side replay (RaceHub), never from a client-reported score.
  'rooftop-racing': { label: 'Rooftop Racing', unitsPerXp: 150, unitsPerCoin: 250, verified: true }, // metres
  'fruit-ninja': { label: 'Fruit Ninja', unitsPerXp: 8, unitsPerCoin: 12 },            // fruits sliced
  'ping-pong': { label: 'Ping Pong', unitsPerXp: 2, unitsPerCoin: 3 },                  // points scored
  'pac-man': { label: 'Pac-Man', unitsPerXp: 50, unitsPerCoin: 80 },                      // score points
  'crossy-road': { label: 'Crossy Road', unitsPerXp: 5, unitsPerCoin: 8 }                  // lanes crossed
};

// Arcade ledger rows carry the game and the run inside their idempotency key:
//   game:<athlete>:<game>:<runId>[:coins]   ·   race:<raceId>:<athlete>
// so per-game totals can be rebuilt from the ledger without an extra table.
function arcadeGameOf(key) {
  const k = String(key || '');
  if (k.startsWith('race:')) return 'rooftop-racing';
  if (!k.startsWith('game:')) return null;
  const slug = k.split(':')[2];
  return GAME_RULES[slug] ? slug : null;
}

// One run = one XP row and one coins row, so the run reference strips the suffix.
function arcadeRunOf(key) {
  const k = String(key || '');
  return k.startsWith('race:') ? k : k.replace(/:coins$/, '');
}

// Which ledger reason codes feed which coin source in the shop.
const COIN_SOURCE_BY_REASON = {
  GAME_COINS: 'games',
  LEVEL_UP_BONUS: 'levels',
  TASK_COINS: 'tasks',
  WEEKLY_CHALLENGE_WIN: 'challenges'
};

// Coins paid once per level reached — overridable via program_settings coin.level_up_bonus.<CODE>.
const LEVEL_UP_COIN_BONUS = { CL4: 100, CL3: 200, CL2: 300, CL1: 500, ZERO: 1000 };

// Which ledger reason codes feed which XP source on the portal.
const XP_SOURCE_BY_REASON = {
  TASK_APPROVED: 'tasks',
  ORDER_XP: 'orders', ORDER_REVENUE_XP: 'orders', MIGRATION_SEED: 'orders', ORDER_REFUND: 'orders',
  GAME_XP: 'games'
};

// Midnight IST as an ISO timestamp — the arcade daily cap resets here.
function istDayStartIso() {
  const offsetMs = 5.5 * 3600 * 1000;
  const ist = new Date(Date.now() + offsetMs);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - offsetMs).toISOString();
}

const GamificationService = {

  // ══════════════════════════════════════════════════════════════════════════
  // DAILY TASK POOLS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get today's (or a specific date's) task pool with full task details.
   */
  async getDailyPool(date = null) {
    const poolDate = date || new Date().toISOString().slice(0, 10);

    const { data: pool, error } = await supabase
      .from('daily_task_pools')
      .select('*')
      .eq('pool_date', poolDate)
      .eq('is_published', true)
      .maybeSingle();

    if (error) throw error;
    if (!pool) return { pool: null, tasks: [] };

    // Fetch task template details
    const templateIds = pool.task_template_ids || [];
    if (templateIds.length === 0) return { pool, tasks: [] };

    const { data: tasks, error: taskErr } = await supabase
      .from('task_templates')
      .select('id, code, title, brief_md, type, platform, xp_value, coin_value, due_days, requires_disclosure')
      .in('id', templateIds);

    if (taskErr) throw taskErr;

    return { pool, tasks: tasks || [] };
  },

  /**
   * Get today's pool + the athlete's picks and their statuses.
   */
  async getDailyTasksForAthlete(influencerId, date = null) {
    const poolDate = date || new Date().toISOString().slice(0, 10);
    const { pool, tasks } = await this.getDailyPool(poolDate);

    if (!pool) return { pool: null, tasks: [], picks: [], maxPicks: await this._getSetting('daily_task.max_picks', 5) };

    // Fetch athlete's picks for this date
    const { data: picks } = await supabase
      .from('daily_task_picks')
      .select('*')
      .eq('influencer_id', influencerId)
      .eq('pool_date', poolDate);

    // Enrich tasks with pick status
    const picksMap = {};
    (picks || []).forEach(p => { picksMap[p.task_template_id] = p; });

    const enrichedTasks = tasks.map(t => ({
      ...t,
      picked: !!picksMap[t.id],
      pick_status: picksMap[t.id]?.status || null,
      assignment_id: picksMap[t.id]?.assignment_id || null
    }));

    const maxPicks = await this._getSetting('daily_task.max_picks', 5);

    return { pool, tasks: enrichedTasks, picks: picks || [], maxPicks };
  },

  /**
   * Athlete picks a task from today's pool.
   * Creates an assignment and a daily_task_picks record.
   */
  async pickTask(influencerId, taskTemplateId, date = null) {
    const poolDate = date || new Date().toISOString().slice(0, 10);
    const maxPicks = await this._getSetting('daily_task.max_picks', 5);

    // Check pool exists and contains this task
    const { pool, tasks } = await this.getDailyPool(poolDate);
    if (!pool) throw Object.assign(new Error('No task pool published for today'), { status: 404 });

    const taskExists = tasks.some(t => t.id === taskTemplateId);
    if (!taskExists) throw Object.assign(new Error('Task not in today\'s pool'), { status: 400 });

    // Check pick limit
    const { count } = await supabase
      .from('daily_task_picks')
      .select('*', { count: 'exact', head: true })
      .eq('influencer_id', influencerId)
      .eq('pool_date', poolDate);

    if (count >= maxPicks) throw Object.assign(new Error(`Daily pick limit reached (${maxPicks})`), { status: 400 });

    // Check not already picked
    const { data: existing } = await supabase
      .from('daily_task_picks')
      .select('id')
      .eq('influencer_id', influencerId)
      .eq('pool_date', poolDate)
      .eq('task_template_id', taskTemplateId)
      .maybeSingle();

    if (existing) throw Object.assign(new Error('Task already picked today'), { status: 409 });

    // Get task details for due date
    const { data: task } = await supabase
      .from('task_templates')
      .select('*')
      .eq('id', taskTemplateId)
      .single();

    if (!task) throw Object.assign(new Error('Task template not found'), { status: 404 });

    // Create assignment
    const dueAt = new Date(Date.now() + (task.due_days || 7) * 86400000).toISOString();
    const { data: assignment, error: assignErr } = await supabase
      .from('assignments')
      .insert([{
        influencer_id: influencerId,
        task_template_id: taskTemplateId,
        due_at: dueAt,
        status: 'ASSIGNED'
      }])
      .select()
      .single();

    if (assignErr) throw assignErr;

    // Create pick record
    const { data: pick, error: pickErr } = await supabase
      .from('daily_task_picks')
      .insert([{
        influencer_id: influencerId,
        pool_date: poolDate,
        task_template_id: taskTemplateId,
        assignment_id: assignment.id,
        status: 'PICKED'
      }])
      .select()
      .single();

    if (pickErr) throw pickErr;

    return { pick, assignment };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DAILY TASK POOL ADMIN
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create or update a daily task pool for a specific date.
   */
  async createDailyPool(poolDate, taskTemplateIds, createdBy = null) {
    // Validate all task template IDs exist
    const { data: tasks } = await supabase
      .from('task_templates')
      .select('id, title')
      .in('id', taskTemplateIds);

    if (!tasks || tasks.length !== taskTemplateIds.length) {
      throw new Error('One or more task template IDs are invalid');
    }

    const { data: pool, error } = await supabase
      .from('daily_task_pools')
      .upsert([{
        pool_date: poolDate,
        task_template_ids: taskTemplateIds,
        is_published: true,
        published_at: new Date().toISOString(),
        created_by: createdBy
      }], { onConflict: 'pool_date' })
      .select()
      .single();

    if (error) throw error;
    return pool;
  },

  /**
   * List daily task pools in a date range.
   */
  async listDailyPools(startDate = null, endDate = null) {
    const start = startDate || new Date().toISOString().slice(0, 10);
    const end = endDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('daily_task_pools')
      .select('*')
      .gte('pool_date', start)
      .lte('pool_date', end)
      .order('pool_date', { ascending: true });

    if (error) throw error;

    // Enrich with task titles
    const allTaskIds = [...new Set((data || []).flatMap(p => p.task_template_ids || []))];
    let tasksMap = {};
    if (allTaskIds.length > 0) {
      const { data: tasks } = await supabase
        .from('task_templates')
        .select('id, title, xp_value, coin_value, type')
        .in('id', allTaskIds);
      (tasks || []).forEach(t => { tasksMap[t.id] = t; });
    }

    return (data || []).map(p => ({
      ...p,
      tasks: (p.task_template_ids || []).map(id => tasksMap[id] || { id, title: 'Unknown' })
    }));
  },

  // ══════════════════════════════════════════════════════════════════════════
  // WEEKLY CHALLENGES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current active weekly challenge.
   */
  async getCurrentWeeklyChallenge() {
    const today = new Date().toISOString().slice(0, 10);

    const { data: challenge, error } = await supabase
      .from('weekly_challenges')
      .select('*')
      .eq('is_active', true)
      .lte('week_start', today)
      .gte('week_end', today)
      .order('week_start', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return challenge;
  },

  /**
   * Get weekly challenge + athlete's entry status.
   */
  async getWeeklyChallengeForAthlete(influencerId) {
    const challenge = await this.getCurrentWeeklyChallenge();
    if (!challenge) return { challenge: null, entry: null };

    const { data: entry } = await supabase
      .from('weekly_challenge_entries')
      .select('*')
      .eq('weekly_challenge_id', challenge.id)
      .eq('influencer_id', influencerId)
      .maybeSingle();

    return { challenge, entry };
  },

  /**
   * Submit an entry for the current weekly challenge.
   */
  async submitWeeklyEntry(influencerId, challengeId, submissionUrl, caption, disclosureFound = false) {
    // Verify challenge exists and is active
    const { data: challenge } = await supabase
      .from('weekly_challenges')
      .select('*')
      .eq('id', challengeId)
      .eq('is_active', true)
      .single();

    if (!challenge) throw Object.assign(new Error('Challenge not found or inactive'), { status: 404 });

    // Check within date range
    const today = new Date().toISOString().slice(0, 10);
    if (today < challenge.week_start || today > challenge.week_end) {
      throw Object.assign(new Error('Challenge is not currently active'), { status: 400 });
    }

    // Check if already submitted
    const { data: existing } = await supabase
      .from('weekly_challenge_entries')
      .select('id')
      .eq('weekly_challenge_id', challengeId)
      .eq('influencer_id', influencerId)
      .maybeSingle();

    if (existing) throw Object.assign(new Error('You have already submitted an entry for this challenge'), { status: 409 });

    const { data: entry, error } = await supabase
      .from('weekly_challenge_entries')
      .insert([{
        weekly_challenge_id: challengeId,
        influencer_id: influencerId,
        submission_url: submissionUrl,
        caption,
        disclosure_found: disclosureFound,
        status: 'PENDING'
      }])
      .select()
      .single();

    if (error) throw error;
    return entry;
  },

  /**
   * Get weekly challenge leaderboard (ranked entries).
   */
  async getWeeklyLeaderboard(challengeId = null) {
    let challenge;
    if (challengeId) {
      const { data } = await supabase.from('weekly_challenges').select('*').eq('id', challengeId).single();
      challenge = data;
    } else {
      challenge = await this.getCurrentWeeklyChallenge();
    }

    if (!challenge) return { challenge: null, entries: [] };

    const { data: entries, error } = await supabase
      .from('weekly_challenge_entries')
      .select('id, influencer_id, submission_url, caption, score, rank, status, submitted_at')
      .eq('weekly_challenge_id', challenge.id)
      .eq('status', 'APPROVED')
      .order('rank', { ascending: true, nullsLast: true });

    if (error) throw error;

    // Enrich with athlete names
    const athleteIds = [...new Set((entries || []).map(e => e.influencer_id))];
    let athletesMap = {};
    if (athleteIds.length > 0) {
      const { data: athletes } = await supabase
        .from('influencers')
        .select('id, name, athlete_no, level_id')
        .in('id', athleteIds);

      const levelIds = [...new Set((athletes || []).map(a => a.level_id).filter(Boolean))];
      let levelsMap = {};
      if (levelIds.length > 0) {
        const { data: levels } = await supabase.from('comfort_levels').select('id, display_name').in('id', levelIds);
        (levels || []).forEach(l => { levelsMap[l.id] = l; });
      }

      (athletes || []).forEach(a => {
        athletesMap[a.id] = { ...a, level_name: levelsMap[a.level_id]?.display_name || '—' };
      });
    }

    const enriched = (entries || []).map((e, i) => ({
      ...e,
      athlete: athletesMap[e.influencer_id] || { name: 'Unknown', athlete_no: '—' },
      display_rank: e.rank || (i + 1)
    }));

    return { challenge, entries: enriched };
  },

  /**
   * Review and rank a weekly challenge entry (admin).
   */
  async reviewWeeklyEntry(entryId, status, score, rank, reviewerId = null) {
    const updateData = {
      status,
      score: score || 0,
      reviewed_at: new Date().toISOString(),
      reviewer_id: reviewerId
    };
    if (rank !== undefined && rank !== null) updateData.rank = rank;

    const { data, error } = await supabase
      .from('weekly_challenge_entries')
      .update(updateData)
      .eq('id', entryId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * Award weekly challenge winners — distribute XP, coins, badges.
   */
  async awardWeeklyWinners(challengeId) {
    const { data: challenge } = await supabase
      .from('weekly_challenges')
      .select('*')
      .eq('id', challengeId)
      .single();

    if (!challenge) throw new Error('Challenge not found');

    // Get top entries by rank
    const { data: entries } = await supabase
      .from('weekly_challenge_entries')
      .select('*')
      .eq('weekly_challenge_id', challengeId)
      .eq('status', 'APPROVED')
      .order('rank', { ascending: true })
      .limit(challenge.max_winners || 3);

    if (!entries || entries.length === 0) return { awarded: 0 };

    // Reward settings
    const xpRewards = [
      await this._getSetting('weekly_challenge.xp_reward_1st', 500),
      await this._getSetting('weekly_challenge.xp_reward_2nd', 300),
      await this._getSetting('weekly_challenge.xp_reward_3rd', 150)
    ];
    const coinRewards = [
      await this._getSetting('weekly_challenge.coin_reward_1st', 200),
      await this._getSetting('weekly_challenge.coin_reward_2nd', 100),
      await this._getSetting('weekly_challenge.coin_reward_3rd', 50)
    ];

    let awarded = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const xpReward = xpRewards[i] || challenge.reward_xp || 0;
      const coinReward = coinRewards[i] || challenge.reward_coins || 0;

      // Award XP
      if (xpReward > 0) {
        await LedgerService.award(
          entry.influencer_id, 'XP', xpReward, 'ASSIGNMENT', null,
          `weekly:${challengeId}:rank${i + 1}:xp`, 'WEEKLY_CHALLENGE_WIN'
        );
      }

      // Award coins
      if (coinReward > 0) {
        await LedgerService.award(
          entry.influencer_id, 'COIN', coinReward, 'ASSIGNMENT', null,
          `weekly:${challengeId}:rank${i + 1}:coins`, 'WEEKLY_CHALLENGE_WIN'
        );
      }

      // Award badge if configured
      const badgeCode = challenge.reward_badge || 'weekly_champion';
      await this.awardBadge(entry.influencer_id, badgeCode);

      // Mark entry as WINNER
      await supabase
        .from('weekly_challenge_entries')
        .update({ status: 'WINNER', rank: i + 1 })
        .eq('id', entry.id);

      awarded++;
    }

    return { awarded };
  },

  /**
   * List all weekly challenges (admin).
   */
  async listWeeklyChallenges(includePast = false) {
    let q = supabase.from('weekly_challenges').select('*').order('week_start', { ascending: false });
    if (!includePast) {
      const today = new Date().toISOString().slice(0, 10);
      q = q.gte('week_end', today);
    }
    const { data, error } = await q;
    if (error) throw error;

    // Add entry counts
    const challengeIds = (data || []).map(c => c.id);
    let countsMap = {};
    if (challengeIds.length > 0) {
      const { data: counts } = await supabase
        .from('weekly_challenge_entries')
        .select('weekly_challenge_id, status')
        .in('weekly_challenge_id', challengeIds);
      (counts || []).forEach(e => {
        if (!countsMap[e.weekly_challenge_id]) countsMap[e.weekly_challenge_id] = { total: 0, pending: 0, approved: 0 };
        countsMap[e.weekly_challenge_id].total++;
        if (e.status === 'PENDING') countsMap[e.weekly_challenge_id].pending++;
        if (e.status === 'APPROVED' || e.status === 'WINNER') countsMap[e.weekly_challenge_id].approved++;
      });
    }

    return (data || []).map(c => ({
      ...c,
      entry_total: countsMap[c.id]?.total || 0,
      entry_pending: countsMap[c.id]?.pending || 0,
      entry_approved: countsMap[c.id]?.approved || 0
    }));
  },

  // ══════════════════════════════════════════════════════════════════════════
  // STREAKS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get streak info for an athlete.
   */
  async getStreak(influencerId) {
    const { data, error } = await supabase
      .from('athlete_streaks')
      .select('*')
      .eq('influencer_id', influencerId)
      .maybeSingle();

    if (error) throw error;
    return data || { influencer_id: influencerId, current_streak: 0, longest_streak: 0, total_active_days: 0, last_active_date: null };
  },

  /**
   * Update streak after a task completion.
   * Call this when an assignment is APPROVED.
   */
  async updateStreak(influencerId) {
    const today = new Date().toISOString().slice(0, 10);

    const { data: existing } = await supabase
      .from('athlete_streaks')
      .select('*')
      .eq('influencer_id', influencerId)
      .maybeSingle();

    if (!existing) {
      // First streak
      const { data } = await supabase
        .from('athlete_streaks')
        .insert([{
          influencer_id: influencerId,
          current_streak: 1,
          longest_streak: 1,
          last_active_date: today,
          total_active_days: 1
        }])
        .select()
        .single();

      // Check 1-task badge
      await this.checkBadgeEligibility(influencerId, 'AUTO_TASKS_COUNT', 1);
      return data;
    }

    const lastDate = existing.last_active_date;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    let newStreak = existing.current_streak;
    let totalDays = existing.total_active_days;

    if (lastDate === today) {
      // Already active today, no change
      return existing;
    } else if (lastDate === yesterday) {
      // Consecutive day — increment
      newStreak = existing.current_streak + 1;
    } else {
      // Streak broken — reset to 1
      newStreak = 1;
    }

    totalDays++;
    const longestStreak = Math.max(existing.longest_streak, newStreak);

    const { data, error } = await supabase
      .from('athlete_streaks')
      .update({
        current_streak: newStreak,
        longest_streak: longestStreak,
        last_active_date: today,
        total_active_days: totalDays
      })
      .eq('influencer_id', influencerId)
      .select()
      .single();

    if (error) throw error;

    // Check streak milestone badges & bonus XP
    if (newStreak === 7) {
      await this.awardBadge(influencerId, 'streak_7');
      const bonusXp = await this._getSetting('streak.milestone_7_xp', 100);
      if (bonusXp > 0) await LedgerService.award(influencerId, 'XP', bonusXp, 'MANUAL', null, `streak:7:${today}`, 'STREAK_MILESTONE');
    } else if (newStreak === 30) {
      await this.awardBadge(influencerId, 'streak_30');
      const bonusXp = await this._getSetting('streak.milestone_30_xp', 500);
      if (bonusXp > 0) await LedgerService.award(influencerId, 'XP', bonusXp, 'MANUAL', null, `streak:30:${today}`, 'STREAK_MILESTONE');
    } else if (newStreak === 100) {
      await this.awardBadge(influencerId, 'streak_100');
      const bonusXp = await this._getSetting('streak.milestone_100_xp', 2000);
      if (bonusXp > 0) await LedgerService.award(influencerId, 'XP', bonusXp, 'MANUAL', null, `streak:100:${today}`, 'STREAK_MILESTONE');
    } else if (newStreak === 365) {
      await this.awardBadge(influencerId, 'streak_365');
    }

    // Daily streak bonus XP
    const dailyBonus = await this._getSetting('streak.bonus_xp_per_day', 10);
    if (dailyBonus > 0 && newStreak > 1) {
      await LedgerService.award(influencerId, 'XP', dailyBonus, 'MANUAL', null, `streak:daily:${today}`, 'STREAK_DAILY_BONUS');
    }

    return data;
  },

  /**
   * Get all streaks for admin view.
   */
  async getAllStreaks() {
    const { data, error } = await supabase
      .from('athlete_streaks')
      .select('*, influencers(name, athlete_no)')
      .order('current_streak', { ascending: false });

    if (error) {
      // Fallback without join
      const { data: streaks } = await supabase
        .from('athlete_streaks')
        .select('*')
        .order('current_streak', { ascending: false });
      return streaks || [];
    }

    return data || [];
  },

  // ══════════════════════════════════════════════════════════════════════════
  // BADGES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Award a badge to an athlete (idempotent via UNIQUE constraint).
   */
  async awardBadge(influencerId, badgeCode) {
    // Get badge definition
    const { data: badge } = await supabase
      .from('badge_definitions')
      .select('*')
      .eq('code', badgeCode)
      .eq('is_active', true)
      .maybeSingle();

    if (!badge) return null; // Badge doesn't exist, skip silently

    const { data, error } = await supabase
      .from('athlete_badges')
      .insert([{
        influencer_id: influencerId,
        badge_code: badgeCode,
        badge_name: badge.name,
        badge_icon: badge.icon
      }])
      .select()
      .single();

    if (error) {
      // UNIQUE constraint violation = already earned, not an error
      if (error.code === '23505') return null;
      throw error;
    }

    return data;
  },

  /**
   * Check if an athlete is eligible for a badge based on criteria.
   */
  async checkBadgeEligibility(influencerId, criteriaType, criteriaValue) {
    const { data: badges } = await supabase
      .from('badge_definitions')
      .select('*')
      .eq('criteria_type', criteriaType)
      .eq('is_active', true);

    if (!badges) return [];

    const awarded = [];
    for (const badge of badges) {
      if (badge.criteria_value && criteriaValue >= badge.criteria_value) {
        const result = await this.awardBadge(influencerId, badge.code);
        if (result) awarded.push(result);
      }
    }

    return awarded;
  },

  /**
   * Get all badges earned by an athlete.
   */
  async getAthleteBadges(influencerId) {
    const { data, error } = await supabase
      .from('athlete_badges')
      .select('*')
      .eq('influencer_id', influencerId)
      .order('earned_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  /**
   * Get all badge definitions (admin).
   */
  async getAllBadgeDefinitions() {
    const { data, error } = await supabase
      .from('badge_definitions')
      .select('*')
      .order('category', { ascending: true })
      .order('code', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  /**
   * Manually award a badge to an athlete (admin).
   */
  async manualAwardBadge(influencerId, badgeCode) {
    return this.awardBadge(influencerId, badgeCode);
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LEADERBOARD
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get overall leaderboard with period support.
   */
  async getLeaderboard(period = 'all_time', limit = 20) {
    const baseFields = 'id, name, athlete_no, xp_total, coin_balance, level_id, leaderboard_opt_out';
    const avatarFields = ', avatar_base, avatar_head, avatar_mark, avatar_ground, avatar_frame';
    
    let q = supabase
      .from('influencers')
      .select(baseFields + avatarFields)
      .eq('leaderboard_opt_out', false)
      .in('athlete_status', ['ACTIVE', 'ON_TRIAL']);

    // For weekly/monthly, we'd need to filter by ledger_entries created_at
    // For now, use total XP (all_time) — weekly/monthly can be enhanced later
    q = q.order('xp_total', { ascending: false }).limit(limit);

    let { data, error } = await q;
    
    // If avatar columns don't exist yet (migration not run), retry without them
    // Supabase returns error code 42703 (undefined_column) or message containing column name
    if (error && (error.code === '42703' || (error.message && error.message.includes('avatar_base')))) {
      q = supabase
        .from('influencers')
        .select(baseFields)
        .eq('leaderboard_opt_out', false)
        .in('athlete_status', ['ACTIVE', 'ON_TRIAL'])
        .order('xp_total', { ascending: false })
        .limit(limit);
      ({ data, error } = await q);
    }
    
    if (error) throw error;

    // Enrich with level names
    const levelIds = [...new Set((data || []).map(a => a.level_id).filter(Boolean))];
    let levelsMap = {};
    if (levelIds.length > 0) {
      const { data: levels } = await supabase.from('comfort_levels').select('id, display_name').in('id', levelIds);
      (levels || []).forEach(l => { levelsMap[l.id] = l; });
    }

    return (data || []).map(a => ({
      ...a,
      level_name: levelsMap[a.level_id]?.display_name || '—'
    }));
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ARCADE LEADERBOARD
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Arcade-only ladder: athletes ranked by what they earn inside the mini-games,
   * never by overall comfort XP. Built from the GAME_XP / GAME_COINS ledger rows
   * (one XP row + one coins row per run), so no schema change is needed.
   *
   * @param {number} influencerId — viewer, used for the `me` block
   * @param {{period?:'today'|'week'|'all', limit?:number}} opts
   */
  async getArcadeLeaderboard(influencerId, opts = {}) {
    const period = ['today', 'week', 'all'].includes(opts.period) ? opts.period : 'today';
    const limit = Math.min(100, Math.max(5, Math.floor(Number(opts.limit) || 50)));
    const since = period === 'today' ? istDayStartIso()
      : period === 'week' ? new Date(Date.now() - 7 * 864e5).toISOString()
      : null;

    const [rows, todayXp, dailyCap] = await Promise.all([
      this._arcadeLedger(since),
      this._gameXpToday(influencerId),
      this._getSetting('game.daily_xp_cap', 40).then(Number)
    ]);

    // ── Aggregate per athlete, per game ──
    const acc = new Map();
    for (const r of rows) {
      const key = String(r.idempotency_key || '');
      const runRef = arcadeRunOf(key);
      const game = arcadeGameOf(key);
      let a = acc.get(r.influencer_id);
      if (!a) {
        a = { id: r.influencer_id, xp: 0, coins: 0, runs: new Set(), days: new Set(), last: 0, best: 0, games: new Map() };
        acc.set(r.influencer_id, a);
      }
      a.runs.add(runRef);
      const ts = new Date(r.created_at).getTime();
      a.days.add(new Date(ts + 5.5 * 3600 * 1000).toISOString().slice(0, 10)); // IST day, same clock as the cap
      if (ts > a.last) a.last = ts;
      if (r.currency === 'XP') a.xp += r.amount;
      else a.coins += r.amount;
      if (!game) continue;
      let g = a.games.get(game);
      if (!g) { g = { xp: 0, coins: 0, runs: new Set(), best: 0 }; a.games.set(game, g); }
      g.runs.add(runRef);
      if (r.currency === 'XP') {
        g.xp += r.amount;
        if (r.amount > g.best) g.best = r.amount;
        if (r.amount > a.best) a.best = r.amount;
      } else {
        g.coins += r.amount;
      }
    }

    // ── Order, then keep only athletes who are still on the roster ──
    const ordered = [...acc.values()]
      .filter(a => a.runs.size > 0)
      .sort((x, y) => y.xp - x.xp || y.runs.size - x.runs.size || y.last - x.last);
    const profiles = await this._arcadeProfiles(ordered.map(a => a.id));
    const roster = ordered.filter(a => {
      const p = profiles.get(a.id);
      if (!p || p.leaderboard_opt_out) return false;
      return !p.athlete_status || ['ACTIVE', 'ON_TRIAL'].includes(p.athlete_status);
    });

    const levelIds = [...new Set(roster.map(a => profiles.get(a.id)?.level_id).filter(Boolean))];
    let levelsMap = {};
    if (levelIds.length) {
      const { data: levels } = await supabase
        .from('comfort_levels').select('id, display_name, display_number').in('id', levelIds);
      (levels || []).forEach(l => { levelsMap[l.id] = l; });
    }

    const shape = (a, rank) => {
      const p = profiles.get(a.id) || {};
      // Favourite cabinet = most runs, XP breaks the tie.
      let favourite = null, favouriteRuns = -1, favouriteXp = -1;
      for (const [slug, g] of a.games) {
        if (g.runs.size > favouriteRuns || (g.runs.size === favouriteRuns && g.xp > favouriteXp)) {
          favourite = slug; favouriteRuns = g.runs.size; favouriteXp = g.xp;
        }
      }
      const level = levelsMap[p.level_id];
      return {
        rank, id: a.id,
        name: p.name || 'Athlete',
        athlete_no: p.athlete_no || null,
        level_name: level?.display_name || '—',
        level_number: level?.display_number ?? null,
        xp_total: p.xp_total || 0,
        avatar_base: p.avatar_base, avatar_head: p.avatar_head, avatar_mark: p.avatar_mark,
        avatar_ground: p.avatar_ground, avatar_frame: p.avatar_frame,
        arcade_xp: a.xp, coins: a.coins, runs: a.runs.size, active_days: a.days.size,
        best_run: a.best,
        favourite_game: favourite,
        favourite_game_label: favourite ? GAME_RULES[favourite].label : null,
        last_played: a.last ? new Date(a.last).toISOString() : null
      };
    };

    const all = roster.map((a, i) => shape(a, i + 1));
    const mine = all.find(r => r.id === influencerId) || null;
    const above = mine ? all[mine.rank - 2] || null : null;

    return {
      period,
      since,
      generated_at: new Date().toISOString(),
      truncated: rows.length >= 20000,
      totals: {
        athletes: all.length,
        runs: all.reduce((s, r) => s + r.runs, 0),
        xp: all.reduce((s, r) => s + r.arcade_xp, 0),
        coins: all.reduce((s, r) => s + r.coins, 0)
      },
      rows: all.slice(0, limit),
      me: mine ? {
        ...mine,
        total_athletes: all.length,
        percentile: all.length > 1 ? Math.max(1, Math.round(((all.length - mine.rank + 1) / all.length) * 100)) : 100,
        gap_to_above: above ? Math.max(0, above.arcade_xp - mine.arcade_xp) : 0,
        above_name: above ? above.name : null,
        gap_to_top: Math.max(0, (all[0]?.arcade_xp || 0) - mine.arcade_xp),
        today_xp: todayXp.total,
        daily_cap: dailyCap
      } : {
        rank: null, id: influencerId, arcade_xp: 0, coins: 0, runs: 0, best_run: 0,
        active_days: 0, total_athletes: all.length, percentile: 0,
        gap_to_top: all[0]?.arcade_xp || 0, today_xp: todayXp.total, daily_cap: dailyCap
      }
    };
  },

  /** @private — every paid arcade ledger row in the window, paged past the 1000-row cap */
  async _arcadeLedger(sinceIso, maxRows = 20000) {
    const PAGE = 1000;
    const out = [];
    for (let from = 0; from < maxRows; from += PAGE) {
      let q = supabase
        .from('ledger_entries')
        .select('influencer_id, currency, amount, idempotency_key, created_at')
        .in('reason_code', ['GAME_XP', 'GAME_COINS'])
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      if (sinceIso) q = q.gte('created_at', sinceIso);
      const { data, error } = await q;
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  },

  /** @private — athlete rows for the arcade ladder (chunked; avatar columns optional) */
  async _arcadeProfiles(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const core = 'id, name, athlete_no, xp_total, level_id, athlete_status, leaderboard_opt_out';
    const avatar = ', avatar_base, avatar_head, avatar_mark, avatar_ground, avatar_frame';
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      let { data, error } = await supabase.from('influencers').select(core + avatar).in('id', chunk);
      if (error && error.code === '42703') {
        ({ data, error } = await supabase.from('influencers').select(core).in('id', chunk));
      }
      if (error) throw error;
      (data || []).forEach(p => map.set(p.id, p));
    }
    return map;
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CLIMB, RANKS, AND ACTIVITY
  // ══════════════════════════════════════════════════════════════════════════

  async getClimb(influencerId) {
    const [{ data: athlete, error: athleteError }, { data: levels, error: levelsError }, { data: history, error: historyError }] = await Promise.all([
      supabase.from('influencers').select('id, xp_total, standing_score, level_id, level_since, joined_at').eq('id', influencerId).single(),
      supabase.from('comfort_levels').select('id, ordinal, code, display_name, display_number, min_xp, min_standing, min_days_in_previous, requires_manual_approval, dial_segments_lit, perks').order('ordinal'),
      supabase.from('level_history').select('id, direction, reason_code, occurred_at, from_level_id, to_level_id').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(20)
    ]);
    if (athleteError) throw athleteError;
    if (levelsError) throw levelsError;
    if (historyError) throw historyError;

    const ladder = levels || [];
    const current = ladder.find(level => level.id === athlete.level_id) || ladder[0] || null;
    const next = current ? ladder.find(level => level.ordinal === current.ordinal + 1) || null : null;
    const prev = current ? ladder.find(level => level.ordinal === current.ordinal - 1) || null : null;
    const levelSince = athlete.level_since || athlete.joined_at;
    const daysInCurrentLevel = levelSince ? Math.max(0, Math.floor((Date.now() - new Date(levelSince).getTime()) / 86400000)) : 0;
    const requirements = next ? {
      xp: { required: next.min_xp, current: athlete.xp_total || 0, complete: (athlete.xp_total || 0) >= next.min_xp },
      standing: { required: next.min_standing, current: athlete.standing_score || 0, complete: next.min_standing == null || (athlete.standing_score || 0) >= next.min_standing },
      days: { required: next.min_days_in_previous, current: daysInCurrentLevel, complete: next.min_days_in_previous == null || daysInCurrentLevel >= next.min_days_in_previous },
      manual_approval: next.requires_manual_approval
    } : null;
    const levelsById = Object.fromEntries(ladder.map(level => [level.id, level]));
    const xp = await this.getXpSummary(influencerId);

    // ── XP velocity: 7-day and 30-day earning rates ──
    const now = new Date();
    const d7ago = new Date(now.getTime() - 7 * 86400000).toISOString();
    const d30ago = new Date(now.getTime() - 30 * 86400000).toISOString();
    const [{ data: xp7 }, { data: xp30 }, { data: xp14daily }] = await Promise.all([
      supabase.from('ledger_entries').select('amount, created_at').eq('influencer_id', influencerId).eq('currency', 'XP').gte('created_at', d7ago),
      supabase.from('ledger_entries').select('amount, created_at').eq('influencer_id', influencerId).eq('currency', 'XP').gte('created_at', d30ago),
      supabase.from('ledger_entries').select('amount, created_at').eq('influencer_id', influencerId).eq('currency', 'XP').gte('created_at', new Date(now.getTime() - 14 * 86400000).toISOString())
    ]);
    const sumXp = rows => (rows || []).reduce((s, r) => s + (r.amount || 0), 0);
    const xpLast7 = sumXp(xp7);
    const xpLast30 = sumXp(xp30);
    const dailyRate7 = Math.round(xpLast7 / 7);
    const dailyRate30 = Math.round(xpLast30 / 30);

    // ── Projected days to next level ──
    let projectedDays = null;
    if (next && dailyRate7 > 0) {
      const xpNeeded = Math.max(0, (next.min_xp || 0) - (athlete.xp_total || 0));
      const daysForXp = Math.ceil(xpNeeded / dailyRate7);
      const daysNeeded = Math.max(0, (next.min_days_in_previous || 0) - daysInCurrentLevel);
      projectedDays = Math.max(daysForXp, daysNeeded);
    }

    // ── Overall progress to max level ──
    const maxLevel = ladder[ladder.length - 1];
    const maxXp = maxLevel ? (maxLevel.min_xp || 20000) : 20000;
    const overallPct = maxXp > 0 ? Math.min(100, Math.round(((athlete.xp_total || 0) / maxXp) * 100)) : 0;

    // ── 14-day daily XP breakdown for spark chart ──
    const dailyBuckets = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      dailyBuckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const entry of (xp14daily || [])) {
      const day = (entry.created_at || '').slice(0, 10);
      if (day in dailyBuckets) dailyBuckets[day] += (entry.amount || 0);
    }
    const dailyXpSeries = Object.entries(dailyBuckets).map(([date, amount]) => ({ date, amount }));

    // ── Streak data ──
    const streak = await this.getStreak(influencerId);

    // ── Missions completed count ──
    const { count: missionsCompleted } = await supabase
      .from('assignments')
      .select('id', { count: 'exact', head: true })
      .eq('influencer_id', influencerId)
      .in('status', ['APPROVED', 'COMPLETED']);

    // ── XP to next level gap ──
    const xpToNext = next ? Math.max(0, (next.min_xp || 0) - (athlete.xp_total || 0)) : 0;
    const daysToNext = next ? Math.max(0, (next.min_days_in_previous || 0) - daysInCurrentLevel) : 0;

    return {
      current_level: current,
      next_level: next,
      prev_level: prev,
      ladder,
      days_in_current_level: daysInCurrentLevel,
      requirements,
      xp_sources: xp.sources,
      xp_rules: xp.rules,
      game_xp_today: xp.game_xp_today,
      history: (history || []).map(item => ({ ...item, from_level: levelsById[item.from_level_id] || null, to_level: levelsById[item.to_level_id] || null })),
      // New enriched fields
      standing_score: athlete.standing_score || 0,
      xp_to_next: xpToNext,
      days_to_next: daysToNext,
      xp_last_7: xpLast7,
      xp_last_30: xpLast30,
      daily_rate_7: dailyRate7,
      daily_rate_30: dailyRate30,
      projected_days: projectedDays,
      overall_pct: overallPct,
      daily_xp_series: dailyXpSeries,
      streak: streak || { current_streak: 0, longest_streak: 0, total_active_days: 0 },
      missions_completed: missionsCompleted || 0,
      current_perks: current?.perks || null
    };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // XP SOURCES & ARCADE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * XP split by source (tasks / orders / games / bonus) plus today's arcade XP
   * and the earning rules, so the portal can show how the climb is fuelled.
   */
  async getXpSummary(influencerId) {
    const sources = { tasks: 0, orders: 0, games: 0, bonus: 0 };
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('ledger_entries')
        .select('amount, reason_code, source_type')
        .eq('influencer_id', influencerId)
        .eq('currency', 'XP')
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      for (const entry of (data || [])) {
        const bucket = XP_SOURCE_BY_REASON[entry.reason_code]
          || (entry.source_type === 'ASSIGNMENT' ? 'tasks' : entry.source_type === 'ORDER' ? 'orders' : 'bonus');
        sources[bucket] += entry.amount;
      }
      if (!data || data.length < pageSize) break;
    }

    const [gameToday, perOrder, per1000, dailyCap, perRunMax, raceTable] = await Promise.all([
      this._gameXpToday(influencerId),
      this._getSetting('xp.per_order', 20),
      this._getSetting('xp.per_1000_revenue', 10),
      this._getSetting('game.daily_xp_cap', 40),
      this._getSetting('game.xp_per_run_max', 15),
      this._raceXpTable()
    ]);

    return {
      sources,
      game_xp_today: gameToday.total,
      rules: {
        xp_per_order: Number(perOrder),
        xp_per_1000_revenue: Number(per1000),
        game_daily_xp_cap: Number(dailyCap),
        game_xp_per_run_max: Number(perRunMax),
        race_xp_by_rank: raceTable
      }
    };
  },

  /**
   * Award XP and coins for a finished mini-game run. Score is converted with
   * GAME_RULES, capped per run and per IST day (separately for XP and coins),
   * and rate-limited so the arcade tops up the climb without replacing missions
   * and coupon orders. Coins are shop currency only — they never count toward levels.
   * Games flagged `verified` need opts.verified (the server replayed the run).
   */
  async awardGameXp(influencerId, game, score, runId, opts = {}) {
    const rule = GAME_RULES[game];
    if (!rule) throw Object.assign(new Error('Unknown game'), { status: 400 });
    if (rule.verified && !opts.verified) return { awarded: 0, coins_awarded: 0, game: rule.label, reason: 'verified_only' };
    if (!runId || !/^[A-Za-z0-9_-]{6,64}$/.test(String(runId))) {
      throw Object.assign(new Error('Invalid run id'), { status: 400 });
    }

    const points = Math.max(0, Math.floor(Number(score) || 0));
    const [perRunMax, dailyCap, cooldownSec, coinRunMax, coinCap] = (await Promise.all([
      this._getSetting('game.xp_per_run_max', 15),
      this._getSetting('game.daily_xp_cap', 40),
      this._getSetting('game.min_seconds_between_runs', 30),
      this._getSetting('game.coins_per_run_max', 10),
      this._getSetting('game.daily_coin_cap', 50)
    ])).map(Number);

    const [today, coinsToday] = await Promise.all([
      this._gameXpToday(influencerId),
      this._gameCoinsToday(influencerId)
    ]);
    const base = {
      awarded: 0, earned_today: today.total, daily_cap: dailyCap,
      coins_awarded: 0, coins_today: coinsToday.total, coin_daily_cap: coinCap,
      game: rule.label
    };

    const lastAt = Math.max(
      today.lastAt ? new Date(today.lastAt).getTime() : 0,
      coinsToday.lastAt ? new Date(coinsToday.lastAt).getTime() : 0
    );
    if (lastAt && Date.now() - lastAt < cooldownSec * 1000) {
      return { ...base, reason: 'cooldown' };
    }

    const runXp = Math.min(perRunMax, Math.floor(points / rule.unitsPerXp));
    const runCoins = Math.min(coinRunMax, Math.floor(points / rule.unitsPerCoin));
    if (runXp <= 0 && runCoins <= 0) return { ...base, reason: 'score_too_low' };

    const xp = Math.max(0, Math.min(runXp, dailyCap - today.total));
    const coins = Math.max(0, Math.min(runCoins, coinCap - coinsToday.total));
    if (xp <= 0 && coins <= 0) return { ...base, reason: 'daily_cap' };

    let xpNew = false;
    let coinsNew = false;
    if (xp > 0) {
      ({ isNew: xpNew } = await LedgerService.award(
        influencerId, 'XP', xp, 'MANUAL', null,
        `game:${influencerId}:${game}:${runId}`, 'GAME_XP'
      ));
    }
    if (coins > 0) {
      ({ isNew: coinsNew } = await LedgerService.award(
        influencerId, 'COIN', coins, 'MANUAL', null,
        `game:${influencerId}:${game}:${runId}:coins`, 'GAME_COINS'
      ));
    }
    if (!xpNew && !coinsNew) return { ...base, reason: 'duplicate' };

    const awarded = xpNew ? xp : 0;
    const coinsAwarded = coinsNew ? coins : 0;
    return {
      ...base,
      awarded, earned_today: today.total + awarded,
      coins_awarded: coinsAwarded, coins_today: coinsToday.total + coinsAwarded
    };
  },

  /**
   * Award XP for a finishing position in a live multiplayer race. Called by
   * RaceHub only (server-ranked), shares the arcade daily cap with solo runs.
   */
  async awardRaceXp(influencerId, raceId, rank, field) {
    const [table, dailyCap] = await Promise.all([
      this._raceXpTable(),
      this._getSetting('game.daily_xp_cap', 40).then(Number)
    ]);
    const today = await this._gameXpToday(influencerId);
    const base = { awarded: 0, earned_today: today.total, daily_cap: dailyCap, game: 'Rooftop Race' };
    if (field < 2) return { ...base, reason: 'solo' };

    const rankXp = table[Math.min(rank, table.length) - 1] || 0;
    const xp = Math.min(rankXp, dailyCap - today.total);
    if (xp <= 0) return { ...base, reason: 'daily_cap' };

    const { isNew } = await LedgerService.award(
      influencerId, 'XP', xp, 'MANUAL', null,
      `race:${raceId}:${influencerId}`, 'GAME_XP'
    );
    if (!isNew) return { ...base, reason: 'duplicate' };
    return { ...base, awarded: xp, earned_today: today.total + xp };
  },

  /** @private — XP by finishing position; the last entry covers every rank below */
  async _raceXpTable() {
    const raw = await this._getSetting('game.race_xp_by_rank', '20,14,10,7,5');
    const list = (Array.isArray(raw) ? raw : String(raw).split(','))
      .map(v => Math.max(0, Math.floor(Number(v)))).filter(Number.isFinite);
    return list.length ? list : [20, 14, 10, 7, 5];
  },

  /** @private — arcade XP earned since IST midnight + time of the last award */
  async _gameXpToday(influencerId) {
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('amount, created_at')
      .eq('influencer_id', influencerId)
      .eq('currency', 'XP')
      .eq('reason_code', 'GAME_XP')
      .gte('created_at', istDayStartIso())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return {
      total: (data || []).reduce((sum, e) => sum + e.amount, 0),
      lastAt: data?.[0]?.created_at || null
    };
  },

  /** @private — arcade coins earned since IST midnight + time of the last award */
  async _gameCoinsToday(influencerId) {
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('amount, created_at')
      .eq('influencer_id', influencerId)
      .eq('currency', 'COIN')
      .eq('reason_code', 'GAME_COINS')
      .gte('created_at', istDayStartIso())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return {
      total: (data || []).reduce((sum, e) => sum + e.amount, 0),
      lastAt: data?.[0]?.created_at || null
    };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COINS & SHOP
  // ══════════════════════════════════════════════════════════════════════════

  /** Coin bonus paid when an athlete first reaches a level (0 = none). */
  async levelUpCoinBonus(levelCode) {
    if (!levelCode) return 0;
    const raw = await this._getSetting(`coin.level_up_bonus.${levelCode}`, LEVEL_UP_COIN_BONUS[levelCode] || 0);
    return Math.max(0, Math.floor(Number(raw) || 0));
  },

  /**
   * Everything the Shop screen needs: balance, where coins came from, today's
   * arcade coins vs cap, the level-up bonus ladder and recent coin activity.
   * Coins are spend-only currency and never affect level or rank.
   */
  async getCoinSummary(influencerId) {
    const [{ data: athlete, error: athErr }, { data: levels, error: lvlErr }, { data: recent, error: recentErr }] = await Promise.all([
      supabase.from('influencers').select('coin_balance, level_id').eq('id', influencerId).single(),
      supabase.from('comfort_levels').select('id, ordinal, code, display_name, display_number').order('ordinal'),
      supabase.from('ledger_entries').select('id, amount, reason_code, created_at').eq('influencer_id', influencerId).eq('currency', 'COIN').order('created_at', { ascending: false }).limit(20)
    ]);
    if (athErr) throw athErr;
    if (lvlErr) throw lvlErr;
    if (recentErr) throw recentErr;

    const sources = { games: 0, levels: 0, tasks: 0, challenges: 0, other: 0 };
    let spent = 0;
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('ledger_entries')
        .select('amount, reason_code')
        .eq('influencer_id', influencerId)
        .eq('currency', 'COIN')
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      for (const entry of (data || [])) {
        if (entry.amount < 0) { spent += -entry.amount; continue; }
        sources[COIN_SOURCE_BY_REASON[entry.reason_code] || 'other'] += entry.amount;
      }
      if (!data || data.length < pageSize) break;
    }

    const ladder = levels || [];
    const current = ladder.find(level => level.id === athlete.level_id) || null;
    const [coinsToday, coinCap, coinRunMax, bonuses] = await Promise.all([
      this._gameCoinsToday(influencerId),
      this._getSetting('game.daily_coin_cap', 50),
      this._getSetting('game.coins_per_run_max', 10),
      Promise.all(ladder.map(level => this.levelUpCoinBonus(level.code)))
    ]);

    return {
      balance: athlete.coin_balance || 0,
      sources,
      spent,
      game_coins_today: coinsToday.total,
      rules: { game_daily_coin_cap: Number(coinCap), game_coins_per_run_max: Number(coinRunMax) },
      level_bonuses: ladder
        .map((level, i) => ({
          code: level.code,
          display_name: level.display_name,
          display_number: level.display_number,
          ordinal: level.ordinal,
          coins: bonuses[i],
          reached: !!current && level.ordinal <= current.ordinal,
          is_current: !!current && level.id === current.id
        }))
        .filter(level => level.coins > 0),
      recent: recent || [],
      products: []
    };
  },

  async captureRankSnapshots() {
    const { data: athletes, error } = await supabase.from('influencers').select('id, xp_total, level_id, standing_score').eq('leaderboard_opt_out', false).in('athlete_status', ['ACTIVE', 'ON_TRIAL']).order('xp_total', { ascending: false });
    if (error) throw error;
    const capturedOn = new Date().toISOString().slice(0, 10);
    const rows = (athletes || []).map((athlete, index) => ({ influencer_id: athlete.id, captured_on: capturedOn, global_rank: index + 1, xp_total: athlete.xp_total || 0, level_id: athlete.level_id, standing_score: athlete.standing_score || 0 }));
    if (!rows.length) return { captured: 0 };
    const { error: upsertError } = await supabase.from('athlete_rank_snapshots').upsert(rows, { onConflict: 'influencer_id,captured_on' });
    if (upsertError) throw upsertError;
    return { captured: rows.length, captured_on: capturedOn };
  },

  async getRanks(influencerId) {
    const baseFields = 'id, name, athlete_no, instagram_handle, xp_total, standing_score, level_id';
    const avatarFields = ', avatar_base, avatar_head, avatar_mark, avatar_ground, avatar_frame';
    
    let { data: athletes, error } = await supabase
      .from('influencers')
      .select(baseFields + avatarFields)
      .eq('leaderboard_opt_out', false)
      .in('athlete_status', ['ACTIVE', 'ON_TRIAL'])
      .order('xp_total', { ascending: false });
    
    // If avatar columns don't exist yet (migration not run), retry without them
    // Supabase returns error code 42703 (undefined_column) or message containing column name
    if (error && (error.code === '42703' || (error.message && error.message.includes('avatar_base')))) {
      ({ data: athletes, error } = await supabase
        .from('influencers')
        .select(baseFields)
        .eq('leaderboard_opt_out', false)
        .in('athlete_status', ['ACTIVE', 'ON_TRIAL'])
        .order('xp_total', { ascending: false }));
    }
    
    if (error) throw error;
    const totalAthletes = (athletes || []).length;
    const rank = (athletes || []).findIndex(athlete => athlete.id === influencerId) + 1;
    const self = (athletes || []).find(a => a.id === influencerId) || {};
    // Nearby: ±5 positions for richer context
    const nearby = (athletes || []).slice(Math.max(0, rank - 6), rank + 5).map((athlete, index) => ({ ...athlete, global_rank: Math.max(1, rank - 5) + index, is_self: athlete.id === influencerId }));
    const { data: snapshots, error: snapshotError } = await supabase.from('athlete_rank_snapshots').select('captured_on, global_rank, xp_total, standing_score').eq('influencer_id', influencerId).order('captured_on', { ascending: false }).limit(90);
    // The ranks endpoint remains usable before the additive snapshot migration runs.
    if (snapshotError && !['42P01', 'PGRST205'].includes(snapshotError.code)) throw snapshotError;
    const { data: history, error: historyError } = await supabase.from('level_history').select('direction, reason_code, occurred_at, to_level_id, from_level_id').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(20);
    if (historyError) throw historyError;
    // Enrich level history with level names
    const levelIds = [...new Set((history || []).flatMap(h => [h.from_level_id, h.to_level_id].filter(Boolean)))];
    // Also collect level IDs from nearby athletes
    const nearbyLevelIds = [...new Set(nearby.map(a => a.level_id).filter(Boolean))];
    const allLevelIds = [...new Set([...levelIds, ...nearbyLevelIds])];
    let levelsMap = {};
    if (allLevelIds.length > 0) {
      const { data: levels } = await supabase.from('comfort_levels').select('id, display_name, display_number').in('id', allLevelIds);
      (levels || []).forEach(l => { levelsMap[l.id] = l; });
    }
    const enrichedHistory = (history || []).map(h => ({
      ...h,
      from_level: h.from_level_id ? levelsMap[h.from_level_id] || null : null,
      to_level: h.to_level_id ? levelsMap[h.to_level_id] || null : null
    }));
    // Add level names to nearby athletes
    const enrichedNearby = nearby.map(a => ({ ...a, level_name: a.level_id ? levelsMap[a.level_id]?.display_name || '—' : '—' }));
    // ── Top 5 leaderboard with latest post snapshots ──
    const top5Athletes = (athletes || []).slice(0, 5);
    const top5Ids = top5Athletes.map(a => a.id);
    let latestPostsMap = {};
    if (top5Ids.length) {
      // Get the most recent assignment per top-5 athlete
      const { data: topAssignments } = await supabase.from('assignments').select('id, influencer_id, created_at').in('influencer_id', top5Ids).order('created_at', { ascending: false });
      const latestAssignmentByInfluencer = {};
      (topAssignments || []).forEach(a => { if (!latestAssignmentByInfluencer[a.influencer_id]) latestAssignmentByInfluencer[a.influencer_id] = a.id; });
      const latestAssignmentIds = [...new Set(Object.values(latestAssignmentByInfluencer))];
      if (latestAssignmentIds.length) {
        const { data: topSubmissions } = await supabase.from('submissions').select('assignment_id, post_url, caption, posted_at').in('assignment_id', latestAssignmentIds).not('post_url', 'is', null).order('posted_at', { ascending: false });
        const subByAssignment = {};
        (topSubmissions || []).forEach(s => { if (!subByAssignment[s.assignment_id]) subByAssignment[s.assignment_id] = s; });
        for (const [infId, assignmentId] of Object.entries(latestAssignmentByInfluencer)) {
          if (subByAssignment[assignmentId]) latestPostsMap[infId] = subByAssignment[assignmentId];
        }
      }
    }
    const top5 = top5Athletes.map((a, i) => ({
      rank: i + 1,
      id: a.id,
      name: a.name || 'ATHLETE',
      instagram_handle: a.instagram_handle || null,
      level_name: a.level_id ? levelsMap[a.level_id]?.display_name || '—' : '—',
      xp_total: a.xp_total || 0,
      standing_score: a.standing_score || 0,
      latest_post: latestPostsMap[a.id] || null
    }));
    // ── Chase targets: 3 athletes directly above the current user ──
    const chaseTargets = [];
    if (rank > 1) {
      for (let i = 1; i <= 3 && (rank - 1 - i) >= 0; i++) {
        const target = (athletes || [])[rank - 1 - i];
        if (target) {
          chaseTargets.push({
            rank: rank - i,
            id: target.id,
            name: target.name || 'ATHLETE',
            instagram_handle: target.instagram_handle || null,
            level_name: target.level_id ? levelsMap[target.level_id]?.display_name || '—' : '—',
            xp_total: target.xp_total || 0,
            xp_gap: (target.xp_total || 0) - (self.xp_total || 0),
            missions_away: Math.ceil(((target.xp_total || 0) - (self.xp_total || 0)) / 50)
          });
        }
      }
    }
    // ── Biggest climbers: top 5 athletes who improved most in last 7 days ──
    let biggestClimbers = [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: weekOldSnapshots } = await supabase.from('athlete_rank_snapshots').select('influencer_id, global_rank').eq('captured_on', sevenDaysAgo);
    if (weekOldSnapshots && weekOldSnapshots.length) {
      const oldRankMap = {};
      weekOldSnapshots.forEach(s => { oldRankMap[s.influencer_id] = s.global_rank; });
      const climbers = (athletes || []).slice(0, 20).map((a, idx) => {
        const currentRank = idx + 1;
        const oldRank = oldRankMap[a.id];
        if (!oldRank) return null;
        const improvement = oldRank - currentRank;
        return { id: a.id, name: a.name || 'ATHLETE', instagram_handle: a.instagram_handle || null, level_name: a.level_id ? levelsMap[a.level_id]?.display_name || '—' : '—', current_rank: currentRank, previous_rank: oldRank, improvement };
      }).filter(Boolean).filter(c => c.improvement > 0).sort((a, b) => b.improvement - a.improvement).slice(0, 5);
      biggestClimbers = climbers;
    }
    // Compute derived stats from snapshots
    const reversedSnapshots = (snapshots || []).reverse();
    const previous = snapshots?.[1] || null;
    const bestRank = reversedSnapshots.length ? Math.min(...reversedSnapshots.map(s => s.global_rank)) : rank || null;
    const worstRank = reversedSnapshots.length ? Math.max(...reversedSnapshots.map(s => s.global_rank)) : rank || null;
    const avgRank = reversedSnapshots.length ? Math.round(reversedSnapshots.reduce((sum, s) => sum + (s.global_rank || 0), 0) / reversedSnapshots.length) : rank || null;
    // XP gaps to adjacent ranks
    const athleteAbove = rank > 1 ? (athletes || [])[rank - 2] : null;
    const athleteBelow = rank < totalAthletes ? (athletes || [])[rank] : null;
    const xpGapAbove = athleteAbove ? (athleteAbove.xp_total || 0) - (self.xp_total || 0) : 0;
    const xpGapBelow = athleteBelow ? (self.xp_total || 0) - (athleteBelow.xp_total || 0) : 0;
    // Current level name
    const currentLevelName = self.level_id ? levelsMap[self.level_id]?.display_name || '—' : '—';
    // Rank trend: compare first and last snapshot
    const trend = reversedSnapshots.length >= 2 ? reversedSnapshots[0].global_rank - reversedSnapshots[reversedSnapshots.length - 1].global_rank : 0;
    // ── Personal best indicator ──
    const isPersonalBest = bestRank && rank && rank <= bestRank;
    // ── Motivational message based on position ──
    let motivationMsg = '';
    if (rank === 1) motivationMsg = 'You\'re leading the pack. Keep the crown.';
    else if (rank <= 3) motivationMsg = `Just ${xpGapAbove.toLocaleString('en-IN')} XP from the top spot. Push harder.`;
    else if (rank <= 5) motivationMsg = 'You\'re in the Top 5. One mission can change everything.';
    else if (rank <= 10) motivationMsg = 'Top 10 locked in. The podium is within reach.';
    else if (trend > 0) motivationMsg = `Climbing fast — ${trend} ranks gained. Keep the momentum.`;
    else if (rank <= totalAthletes / 2) motivationMsg = 'Halfway to the top. Every mission counts.';
    else motivationMsg = 'The comeback starts now. One mission at a time.';
    return {
      current_rank: rank || null,
      rank_delta: previous && rank ? previous.global_rank - rank : 0,
      snapshots: reversedSnapshots,
      nearby: enrichedNearby,
      level_history: enrichedHistory,
      top5,
      chase_targets: chaseTargets,
      biggest_climbers: biggestClimbers,
      is_personal_best: isPersonalBest,
      motivation_msg: motivationMsg,
      total_athletes: totalAthletes,
      percentile: totalAthletes && rank ? Math.round((1 - rank / totalAthletes) * 100) : 0,
      best_rank: bestRank,
      worst_rank: worstRank,
      avg_rank: avgRank,
      xp_gap_above: xpGapAbove,
      xp_gap_below: xpGapBelow,
      current_level_name: currentLevelName,
      standing_score: self.standing_score || 0,
      xp_total: self.xp_total || 0,
      trend
    };
  },

  async getActivityLog(influencerId, opts = {}) {
    // The portal pages this client side, so it asks for a wider window than the
    // old fixed 50. Each source is capped at the same number and the merged
    // stream is trimmed back to `limit` after sorting.
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 300);
    const [assignments, entries, movements] = await Promise.all([
      supabase.from('assignments').select('id, status, submitted_at, reviewed_at, xp_awarded, coin_awarded, task_templates(title)').eq('influencer_id', influencerId).order('updated_at', { ascending: false }).limit(limit),
      supabase.from('ledger_entries').select('id, currency, amount, reason_code, balance_after, created_at').eq('influencer_id', influencerId).order('created_at', { ascending: false }).limit(limit),
      supabase.from('level_history').select('id, direction, reason_code, occurred_at').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(limit)
    ]);
    if (assignments.error) throw assignments.error;
    if (entries.error) throw entries.error;
    if (movements.error) throw movements.error;
    const events = [
      ...(assignments.data || []).map(item => ({ id: `mission-${item.id}`, type: 'MISSION', title: item.task_templates?.title || 'Mission updated', detail: item.status, status: item.status, xp: item.xp_awarded || 0, coins: item.coin_awarded || 0, occurred_at: item.reviewed_at || item.submitted_at })),
      ...(entries.data || []).map(item => ({ id: `ledger-${item.id}`, type: item.currency, title: `${item.amount > 0 ? '+' : ''}${item.amount} ${item.currency}`, detail: item.reason_code, amount: item.amount, currency: item.currency, balance_after: item.balance_after, occurred_at: item.created_at })),
      ...(movements.data || []).map(item => ({ id: `level-${item.id}`, type: 'CLIMB', title: item.direction, detail: item.reason_code, direction: item.direction, occurred_at: item.occurred_at }))
    ].filter(event => event.occurred_at).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at)).slice(0, limit);
    return events;
  },

  // ══════════════════════════════════════════════════════════════════════════
  // GAME SETTINGS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get all gamification-related settings.
   */
  async getGameSettings() {
    const { data, error } = await supabase
      .from('program_settings')
      .select('*')
      .or('key.like.daily_task.%,key.like.weekly_challenge.%,key.like.streak.%,key.like.gamification.%,key.like.leaderboard.%,key.like.game.%,key.like.coin.%')
      .order('key');

    if (error) throw error;
    return data || [];
  },

  /**
   * Update gamification settings.
   */
  async updateGameSettings(settings, actorId = null) {
    for (const s of settings) {
      await supabase
        .from('program_settings')
        .update({ value: s.value, updated_at: new Date().toISOString(), updated_by: actorId })
        .eq('key', s.key);
    }
    return true;
  },

  /**
   * Get per-game unlock flags as { gameId: boolean }.
   * Flags live in program_settings under keys like 'game.fruit-ninja.unlocked'.
   * Games with no row default to unlocked (the admin UI treats missing as open).
   */
  async getGameUnlocks() {
    const { data, error } = await supabase
      .from('program_settings')
      .select('key, value')
      .like('key', 'game.%.unlocked');

    if (error) throw error;
    const unlocks = {};
    (data || []).forEach(row => {
      const gameId = row.key.replace(/^game\./, '').replace(/\.unlocked$/, '');
      unlocks[gameId] = String(row.value).toLowerCase() === 'true';
    });
    return unlocks;
  },

  /**
   * Upsert a single game's unlock flag. Never touches the shared namespace prefix,
   * so a bogus gameId can't overwrite unrelated settings.
   */
  async updateGameUnlock(gameId, unlocked, actorId = null) {
    if (!gameId || /[^a-z0-9-]/i.test(gameId)) {
      const err = new Error('Invalid game id');
      err.status = 400;
      throw err;
    }
    const { error } = await supabase
      .from('program_settings')
      .upsert({
        key: `game.${gameId}.unlocked`,
        value: String(unlocked),
        updated_at: new Date().toISOString(),
        updated_by: actorId
      }, { onConflict: 'key' });

    if (error) throw error;
    return { gameId, unlocked };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** @private */
  async _getSetting(key, defaultValue) {
    const { data } = await supabase
      .from('program_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    return data?.value ?? defaultValue;
  }
};

module.exports = GamificationService;
