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
const CommissionService = require('./CommissionService');

// Arcade scoring: how many score units equal 1 XP / 1 coin for each mini-game.
const GAME_RULES = {
  // `verified` games are only paid from a server-side replay (RaceHub), never from a client-reported score.
  // `unit` labels what a run is measured in, so each cabinet ladder can name its own score column.
  'rooftop-racing': { label: 'Rooftop Racing', unit: 'metres', unitsPerXp: 150, unitsPerCoin: 250, verified: true }, // metres
  'fruit-ninja': { label: 'Fruit Ninja', unit: 'fruits', unitsPerXp: 8, unitsPerCoin: 12 },            // fruits sliced
  'ping-pong': { label: 'Ping Pong', unit: 'points', unitsPerXp: 2, unitsPerCoin: 3 },                  // points scored
  'pac-man': { label: 'Pac-Man', unit: 'score', unitsPerXp: 50, unitsPerCoin: 80 },                      // score points
  'crossy-road': { label: 'Crossy Road', unit: 'lanes', unitsPerXp: 5, unitsPerCoin: 8 },              // lanes crossed
  'tower-blocks': { label: 'Tower Blocks', unit: 'blocks', unitsPerXp: 2, unitsPerCoin: 4 }               // blocks stacked
};

// Cabinet order for the Games tab: every playable tile gets its own ladder, even
// before anyone has run it, so the sideways track never shifts between periods.
const ARCADE_CABINETS = ['rooftop-racing', 'fruit-ninja', 'ping-pong', 'pac-man', 'crossy-road', 'tower-blocks'];

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

// Per-cabinet totals and the time of the newest award, rebuilt from today's rows.
function arcadeTotalsByGame(rows) {
  const out = new Map();
  for (const r of (rows || [])) {
    const game = arcadeGameOf(r.idempotency_key);
    if (!game) continue;
    const at = new Date(r.created_at).getTime();
    const prev = out.get(game) || { total: 0, at: 0 };
    prev.total += r.amount;
    if (at > prev.at) prev.at = at;
    out.set(game, prev);
  }
  return out;
}

// Which ledger reason codes feed which coin source in the shop.
const COIN_SOURCE_BY_REASON = {
  GAME_COINS: 'games',
  LEVEL_UP_BONUS: 'levels',
  TASK_COINS: 'tasks',
  WEEKLY_CHALLENGE_WIN: 'challenges'
};

// Master switch for the portal's Shop screen (seeded false by the shop migration).
const SHOP_UNLOCK_KEY = 'shop.unlocked';

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
      if (!g) { g = { xp: 0, coins: 0, runs: new Set(), best: 0, last: 0 }; a.games.set(game, g); }
      g.runs.add(runRef);
      if (ts > g.last) g.last = ts;
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
    const games = this._arcadeGameBoards(roster, all, influencerId);

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
      games,
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

  /**
   * @private — one ladder per cabinet. Same ledger rows as the combined board,
   * re-ranked inside a single game, so a specialist can top Pac-Man without
   * ever touching the overall standings. Roster filters already applied upstream.
   */
  _arcadeGameBoards(roster, ranked, influencerId) {
    const byId = new Map(ranked.map(r => [r.id, r]));
    return ARCADE_CABINETS.map(slug => {
      const rule = GAME_RULES[slug];
      const entries = [];
      for (const a of roster) {
        const g = a.games.get(slug);
        const row = byId.get(a.id);
        if (!g || !g.runs.size || !row) continue;
        entries.push({
          id: a.id,
          name: row.name,
          athlete_no: row.athlete_no,
          level_name: row.level_name,
          avatar_base: row.avatar_base, avatar_head: row.avatar_head, avatar_mark: row.avatar_mark,
          avatar_ground: row.avatar_ground, avatar_frame: row.avatar_frame,
          xp: g.xp, coins: g.coins, runs: g.runs.size, best_run: g.best,
          last_played: g.last ? new Date(g.last).toISOString() : null
        });
      }
      entries.sort((x, y) => y.xp - x.xp || y.best_run - x.best_run || y.runs - x.runs);
      const top = entries.slice(0, 5).map((e, i) => ({ ...e, rank: i + 1 }));
      const mineIndex = entries.findIndex(e => e.id === influencerId);
      const mineRow = mineIndex >= 0 ? entries[mineIndex] : null;
      return {
        slug,
        label: rule.label,
        unit: rule.unit || 'points',
        top,
        leader: top[0] ? { name: top[0].name, xp: top[0].xp, runs: top[0].runs } : null,
        totals: {
          athletes: entries.length,
          runs: entries.reduce((s, e) => s + e.runs, 0),
          xp: entries.reduce((s, e) => s + e.xp, 0),
          coins: entries.reduce((s, e) => s + e.coins, 0),
          best_run: entries.reduce((s, e) => Math.max(s, e.best_run), 0)
        },
        me: {
          rank: mineRow ? mineIndex + 1 : null,
          xp: mineRow ? mineRow.xp : 0,
          coins: mineRow ? mineRow.coins : 0,
          runs: mineRow ? mineRow.runs : 0,
          best_run: mineRow ? mineRow.best_run : 0,
          total_athletes: entries.length
        }
      };
    });
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
      supabase.from('comfort_levels').select('*').order('ordinal'),
      supabase.from('level_history').select('id, direction, reason_code, occurred_at, from_level_id, to_level_id').eq('influencer_id', influencerId).order('occurred_at', { ascending: false }).limit(20)
    ]);
    if (athleteError) throw athleteError;
    if (levelsError) throw levelsError;
    if (historyError) throw historyError;

    // Commission is a property of the level, resolved once per row here so the
    // portal can show every rung of the pay ladder without extra calls.
    const ladder = (levels || []).map(level => ({ ...level, commission_pct: CommissionService.pctOf(level) }));
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

    // ── Commission ladder: what every rung pays, so the climb has a price ──
    // A level keeps the rate of the anchor below it, so the next *raise* can sit
    // two or three rungs up; next_change_pct names the rung that pays more.
    const topLevel = ladder.length ? ladder[ladder.length - 1] : null;
    const currentPct = CommissionService.pctOf(current);
    const raise = current
      ? ladder.find(l => l.ordinal > current.ordinal && l.commission_pct != null && l.commission_pct !== currentPct) || null
      : null;
    const commission = {
      current_pct: currentPct,
      current_level_name: current?.display_name || null,
      next_pct: CommissionService.pctOf(next),
      next_level_name: next?.display_name || null,
      next_change_pct: raise ? raise.commission_pct : null,
      next_change_level_name: raise?.display_name || null,
      top_pct: CommissionService.pctOf(topLevel),
      top_level_name: topLevel?.display_name || null,
      ladder: ladder.map(level => ({
        code: level.code,
        ordinal: level.ordinal,
        display_name: level.display_name,
        display_number: level.display_number,
        commission_pct: level.commission_pct
      }))
    };
    if (commission.current_pct === null) commission.current_pct = await CommissionService.getDefaultRate();

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
      current_perks: current?.perks || null,
      commission
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

    // The cooldown is per cabinet: it exists to stop re-farming the same game in a
    // loop, and must never swallow the XP of the next game the athlete opens.
    const lastAt = Math.max(
      today.byGame.get(game)?.at || 0,
      coinsToday.byGame.get(game)?.at || 0
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

  /** @private — arcade XP earned since IST midnight + time of the last award, split per cabinet */
  async _gameXpToday(influencerId) {
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('amount, created_at, idempotency_key')
      .eq('influencer_id', influencerId)
      .eq('currency', 'XP')
      .eq('reason_code', 'GAME_XP')
      .gte('created_at', istDayStartIso())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return {
      total: (data || []).reduce((sum, e) => sum + e.amount, 0),
      lastAt: data?.[0]?.created_at || null,
      byGame: arcadeTotalsByGame(data)
    };
  },

  /** @private — arcade coins earned since IST midnight + time of the last award, split per cabinet */
  async _gameCoinsToday(influencerId) {
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('amount, created_at, idempotency_key')
      .eq('influencer_id', influencerId)
      .eq('currency', 'COIN')
      .eq('reason_code', 'GAME_COINS')
      .gte('created_at', istDayStartIso())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return {
      total: (data || []).reduce((sum, e) => sum + e.amount, 0),
      lastAt: data?.[0]?.created_at || null,
      byGame: arcadeTotalsByGame(data)
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

    // Catalog + this athlete's requests. Both tables ship with the shop
    // migration; if it has not been run yet the screen still renders, empty.
    let products = [];
    let redemptions = [];
    let unlocked = false;
    try {
      unlocked = await this.isShopUnlocked();
      if (unlocked) products = await this.getShopProductsForAthlete();
      redemptions = await this.getShopRedemptions(influencerId);
    } catch (shopErr) {
      console.warn('[shop] catalog unavailable:', shopErr.message);
    }

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
      products,
      redemptions,
      unlocked
    };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COIN SHOP — admin-curated drops, athlete requests, admin approval
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Master switch. Only an explicit true opens the shop, so a missing setting
   * (migration not run) leaves the portal's "Coming soon" veil in place.
   */
  async isShopUnlocked() {
    const { data, error } = await supabase
      .from('program_settings')
      .select('value')
      .eq('key', SHOP_UNLOCK_KEY)
      .maybeSingle();
    if (error) throw error;
    return String(data?.value).toLowerCase() === 'true';
  },

  async setShopUnlocked(unlocked, actorId = null) {
    const { error } = await supabase
      .from('program_settings')
      .upsert({
        key: SHOP_UNLOCK_KEY,
        value: String(!!unlocked),
        description: 'Whether the athlete coin shop is open to athletes (true/false)',
        updated_at: new Date().toISOString(),
        updated_by: actorId
      }, { onConflict: 'key' });
    if (error) throw error;
    return { unlocked: !!unlocked };
  },

  /** Admin view of the catalog — inactive and sold-out drops included. */
  async getShopProducts({ includeInactive = true } = {}) {
    let query = supabase
      .from('shop_products')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (!includeInactive) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async createShopProduct(body = {}) {
    const row = this._shopProductRow(body);
    if (!row.name) throw this._shopError('Product name is required');
    if (!(row.coin_price > 0)) throw this._shopError('Coin price must be at least 1');

    const { data, error } = await supabase.from('shop_products').insert([row]).select().single();
    if (error) throw error;
    return data;
  },

  async updateShopProduct(id, body = {}) {
    const row = this._shopProductRow(body, true);
    if (row.name !== undefined && !row.name) throw this._shopError('Product name cannot be empty');
    if (row.coin_price !== undefined && !(row.coin_price > 0)) throw this._shopError('Coin price must be at least 1');
    row.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('shop_products')
      .update(row)
      .eq('id', parseInt(id, 10))
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /** Hard delete: redemptions keep their own product_name/price snapshot. */
  async deleteShopProduct(id) {
    const { error } = await supabase.from('shop_products').delete().eq('id', parseInt(id, 10));
    if (error) throw error;
    return { deleted: parseInt(id, 10) };
  },

  /** What the athlete sees on the Shop screen — live drops only, cheapest last. */
  async getShopProductsForAthlete() {
    const { data, error } = await supabase
      .from('shop_products')
      .select('id, name, description, image_url, coin_price, category, stock, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('coin_price', { ascending: true });
    if (error) throw error;

    return (data || [])
      .filter(p => p.stock === null || p.stock === undefined || p.stock > 0)
      .map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        image_url: p.image_url,
        coin_price: p.coin_price,
        category: p.category,
        stock: p.stock,
        in_stock: true
      }));
  },

  /** This athlete's own requests, newest first. */
  async getShopRedemptions(influencerId, { limit = 20 } = {}) {
    const { data, error } = await supabase
      .from('shop_redemptions')
      .select('id, product_id, product_name, image_url, coin_price, size, status, admin_notes, created_at, decided_at')
      .eq('influencer_id', influencerId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  /**
   * Athlete taps "Get" on a drop.
   * The price is held straight away (one negative COIN ledger row) so the same
   * balance cannot be promised to two different drops while an admin reviews;
   * a rejection reverses that row, an approval consumes it.
   */
  async redeemShopProduct(influencerId, productId, { size = null, note = null } = {}) {
    if (!(await this.isShopUnlocked())) throw this._shopError('The coin shop is not open yet', 403);

    const id = parseInt(productId, 10);
    if (!id) throw this._shopError('product_id is required');

    const { data: product, error: productErr } = await supabase
      .from('shop_products')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (productErr) throw productErr;
    if (!product || !product.is_active) throw this._shopError('That drop is no longer available');
    if (product.stock !== null && product.stock !== undefined && product.stock <= 0) {
      throw this._shopError('That drop is out of stock', 409);
    }

    // One open request per drop, otherwise an athlete can queue the same item twice.
    const { data: open, error: openErr } = await supabase
      .from('shop_redemptions')
      .select('id')
      .eq('influencer_id', influencerId)
      .eq('product_id', id)
      .in('status', ['REQUESTED', 'APPROVED'])
      .limit(1);
    if (openErr) throw openErr;
    if (open && open.length) throw this._shopError('You already have a request open for this drop', 409);

    const { data: athlete, error: athleteErr } = await supabase
      .from('influencers')
      .select('id, coin_balance, shipping_address, shipping_city, shipping_state, shipping_pin, shipping_landmark')
      .eq('id', influencerId)
      .single();
    if (athleteErr) throw athleteErr;
    if (Number(athlete.coin_balance || 0) < product.coin_price) {
      throw this._shopError(`Not enough coins — ${product.coin_price} needed`, 400);
    }

    const shipping = [athlete.shipping_address, athlete.shipping_landmark, athlete.shipping_city, athlete.shipping_state, athlete.shipping_pin]
      .filter(Boolean).join(', ') || null;

    const { data: redemption, error: insertErr } = await supabase
      .from('shop_redemptions')
      .insert([{
        influencer_id: influencerId,
        product_id: product.id,
        product_name: product.name,
        image_url: product.image_url,
        coin_price: product.coin_price,
        size: size ? String(size).trim().slice(0, 20) : null,
        shipping_address: shipping,
        note: note ? String(note).trim().slice(0, 500) : null,
        status: 'REQUESTED'
      }])
      .select()
      .single();
    if (insertErr) throw insertErr;

    try {
      const { entry, balance } = await LedgerService.spend(
        influencerId, 'COIN', product.coin_price, 'REDEMPTION', redemption.id,
        `shop:${redemption.id}`, 'SHOP_REDEMPTION'
      );
      const { data: saved } = await supabase
        .from('shop_redemptions')
        .update({ ledger_entry_id: entry?.id ?? null })
        .eq('id', redemption.id)
        .select()
        .single();
      return { redemption: saved || redemption, balance };
    } catch (spendErr) {
      // Nothing was held — drop the half-made request so it never reaches the admin.
      await supabase.from('shop_redemptions').delete().eq('id', redemption.id);
      throw spendErr;
    }
  },

  /** Admin queue: every request with the athlete attached. */
  async getAllShopRedemptions({ status = null, athleteId = null, limit = 200 } = {}) {
    let query = supabase
      .from('shop_redemptions')
      .select('*, influencers(name, athlete_no, instagram_handle, phone, coin_balance)')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (status) query = query.eq('status', String(status).toUpperCase());
    if (athleteId) query = query.eq('influencer_id', parseInt(athleteId, 10));

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /** Approve: the held coins stay spent and one unit leaves the shelf. */
  async approveShopRedemption(id, { notes = null, actor = 'admin' } = {}) {
    const redemption = await this._openRedemption(id);

    const { data, error } = await supabase
      .from('shop_redemptions')
      .update({
        status: 'APPROVED',
        decided_at: new Date().toISOString(),
        decided_by: actor,
        admin_notes: notes || null
      })
      .eq('id', redemption.id)
      .select()
      .single();
    if (error) throw error;

    if (redemption.product_id) await this._decrementShopStock(redemption.product_id, 1);
    return data;
  },

  /** Reject: the held coins come back as a reversal row (the ledger is append-only). */
  async rejectShopRedemption(id, { reason = null, actor = 'admin' } = {}) {
    const redemption = await this._openRedemption(id);

    const { data, error } = await supabase
      .from('shop_redemptions')
      .update({
        status: 'REJECTED',
        decided_at: new Date().toISOString(),
        decided_by: actor,
        admin_notes: reason || null
      })
      .eq('id', redemption.id)
      .select()
      .single();
    if (error) throw error;

    try {
      let entryId = redemption.ledger_entry_id;
      if (!entryId) {
        const { data: hold } = await supabase
          .from('ledger_entries')
          .select('id')
          .eq('idempotency_key', `shop:${redemption.id}`)
          .maybeSingle();
        entryId = hold?.id || null;
      }
      if (entryId) await LedgerService.reverse(entryId, 'SHOP_REFUND', actor);
    } catch (refundErr) {
      console.error(`[shop] refund failed for redemption ${redemption.id}:`, refundErr.message);
    }

    return data;
  },

  /** @private — fetch a redemption that is still waiting for a decision */
  async _openRedemption(id) {
    const { data, error } = await supabase
      .from('shop_redemptions')
      .select('*')
      .eq('id', parseInt(id, 10))
      .maybeSingle();
    if (error) throw error;
    if (!data) throw this._shopError('Request not found', 404);
    if (data.status !== 'REQUESTED') throw this._shopError(`Request already ${String(data.status).toLowerCase()}`, 409);
    return data;
  },

  /** @private — stock NULL means unlimited, so only a real number is decremented */
  async _decrementShopStock(productId, qty = 1) {
    const { data: product, error } = await supabase
      .from('shop_products')
      .select('id, stock')
      .eq('id', productId)
      .maybeSingle();
    if (error || !product) return;
    if (product.stock === null || product.stock === undefined) return;

    await supabase
      .from('shop_products')
      .update({ stock: Math.max(0, Number(product.stock) - qty), updated_at: new Date().toISOString() })
      .eq('id', productId);
  },

  /** @private — normalise an admin product form body into a shop_products row */
  _shopProductRow(body = {}, partial = false) {
    const has = key => body[key] !== undefined;
    const row = {};
    const text = v => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

    if (!partial || has('name')) row.name = String(body.name || '').trim();
    if (!partial || has('description')) row.description = text(body.description);
    if (!partial || has('image_url')) row.image_url = text(body.image_url);
    if (!partial || has('category')) row.category = text(body.category);
    if (!partial || has('coin_price')) row.coin_price = Math.max(0, Math.floor(Number(body.coin_price) || 0));
    if (!partial || has('stock')) {
      row.stock = body.stock === null || body.stock === undefined || body.stock === ''
        ? null
        : Math.max(0, Math.floor(Number(body.stock) || 0));
    }
    if (!partial || has('is_active')) {
      row.is_active = body.is_active === undefined
        ? true
        : (body.is_active === true || body.is_active === 'true' || body.is_active === 1);
    }
    if (!partial || has('sort_order')) row.sort_order = Math.floor(Number(body.sort_order) || 0);
    return row;
  },

  /** @private — error carrying an HTTP status so routes can pass it straight through */
  _shopError(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
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
