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
    let q = supabase
      .from('influencers')
      .select('id, name, athlete_no, xp_total, coin_balance, level_id, leaderboard_opt_out')
      .eq('leaderboard_opt_out', false)
      .in('athlete_status', ['ACTIVE', 'ON_TRIAL']);

    // For weekly/monthly, we'd need to filter by ledger_entries created_at
    // For now, use total XP (all_time) — weekly/monthly can be enhanced later
    q = q.order('xp_total', { ascending: false }).limit(limit);

    const { data, error } = await q;
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
  // CLIMB, RANKS, AND ACTIVITY
  // ══════════════════════════════════════════════════════════════════════════

  async getClimb(influencerId) {
    const [{ data: athlete, error: athleteError }, { data: levels, error: levelsError }, { data: history, error: historyError }] = await Promise.all([
      supabase.from('influencers').select('id, xp_total, standing_score, level_id, level_since, joined_at').eq('id', influencerId).single(),
      supabase.from('comfort_levels').select('id, ordinal, code, display_name, display_number, min_xp, min_standing, min_days_in_previous, requires_manual_approval, dial_segments_lit, perks').order('ordinal'),
      supabase.from('level_history').select('id, direction, reason_code, occurred_at, from_level_id, to_level_id').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(12)
    ]);
    if (athleteError) throw athleteError;
    if (levelsError) throw levelsError;
    if (historyError) throw historyError;

    const ladder = levels || [];
    const current = ladder.find(level => level.id === athlete.level_id) || ladder[0] || null;
    const next = current ? ladder.find(level => level.ordinal === current.ordinal + 1) || null : null;
    const levelSince = athlete.level_since || athlete.joined_at;
    const daysInCurrentLevel = levelSince ? Math.max(0, Math.floor((Date.now() - new Date(levelSince).getTime()) / 86400000)) : 0;
    const requirements = next ? {
      xp: { required: next.min_xp, current: athlete.xp_total || 0, complete: (athlete.xp_total || 0) >= next.min_xp },
      standing: { required: next.min_standing, current: athlete.standing_score || 0, complete: next.min_standing == null || (athlete.standing_score || 0) >= next.min_standing },
      days: { required: next.min_days_in_previous, current: daysInCurrentLevel, complete: next.min_days_in_previous == null || daysInCurrentLevel >= next.min_days_in_previous },
      manual_approval: next.requires_manual_approval
    } : null;
    const levelsById = Object.fromEntries(ladder.map(level => [level.id, level]));
    return { current_level: current, next_level: next, ladder, days_in_current_level: daysInCurrentLevel, requirements, history: (history || []).map(item => ({ ...item, from_level: levelsById[item.from_level_id] || null, to_level: levelsById[item.to_level_id] || null })) };
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
    const { data: athletes, error } = await supabase.from('influencers').select('id, name, athlete_no, xp_total, standing_score, level_id').eq('leaderboard_opt_out', false).in('athlete_status', ['ACTIVE', 'ON_TRIAL']).order('xp_total', { ascending: false });
    if (error) throw error;
    const rank = (athletes || []).findIndex(athlete => athlete.id === influencerId) + 1;
    const nearby = (athletes || []).slice(Math.max(0, rank - 3), rank + 2).map((athlete, index) => ({ ...athlete, global_rank: Math.max(1, rank - 2) + index, is_self: athlete.id === influencerId }));
    const { data: snapshots, error: snapshotError } = await supabase.from('athlete_rank_snapshots').select('captured_on, global_rank, xp_total, standing_score').eq('influencer_id', influencerId).order('captured_on', { ascending: false }).limit(90);
    // The ranks endpoint remains usable before the additive snapshot migration runs.
    if (snapshotError && !['42P01', 'PGRST205'].includes(snapshotError.code)) throw snapshotError;
    const { data: history, error: historyError } = await supabase.from('level_history').select('direction, reason_code, occurred_at, to_level_id').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(12);
    if (historyError) throw historyError;
    const previous = snapshots?.[1] || null;
    return { current_rank: rank || null, rank_delta: previous && rank ? previous.global_rank - rank : 0, snapshots: (snapshots || []).reverse(), nearby, level_history: history || [] };
  },

  async getActivityLog(influencerId) {
    const [assignments, entries, movements] = await Promise.all([
      supabase.from('assignments').select('id, status, submitted_at, reviewed_at, xp_awarded, coin_awarded, task_templates(title)').eq('influencer_id', influencerId).order('updated_at', { ascending: false }).limit(25),
      supabase.from('ledger_entries').select('id, currency, amount, reason_code, created_at').eq('influencer_id', influencerId).order('created_at', { ascending: false }).limit(25),
      supabase.from('level_history').select('id, direction, reason_code, occurred_at').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(25)
    ]);
    if (assignments.error) throw assignments.error;
    if (entries.error) throw entries.error;
    if (movements.error) throw movements.error;
    const events = [
      ...(assignments.data || []).map(item => ({ type: 'MISSION', title: item.task_templates?.title || 'Mission updated', detail: item.status, occurred_at: item.reviewed_at || item.submitted_at })),
      ...(entries.data || []).map(item => ({ type: item.currency, title: `${item.amount > 0 ? '+' : ''}${item.amount} ${item.currency}`, detail: item.reason_code, occurred_at: item.created_at })),
      ...(movements.data || []).map(item => ({ type: 'CLIMB', title: item.direction, detail: item.reason_code, occurred_at: item.occurred_at }))
    ].filter(event => event.occurred_at).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at)).slice(0, 50);
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
      .or('key.like.daily_task.%,key.like.weekly_challenge.%,key.like.streak.%,key.like.gamification.%,key.like.leaderboard.%')
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
