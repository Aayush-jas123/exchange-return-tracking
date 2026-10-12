// ============================================================================
// Athlete Program — Scheduled Jobs
// ----------------------------------------------------------------------------
// Nightly standing recompute, level evaluation, inactivity checks,
// liveness verification, trial nudges, and trial expiry.
// ============================================================================

const { StandingService, LevelEngine, TransitionService, GamificationService } = require('./index');
const supabase = require('../../config/supabase');

const AthleteJobs = {

  /**
   * Run all nightly jobs in sequence.
   * Call this from a cron scheduler (e.g., node-cron) at midnight IST.
   */
  async runNightly() {
    console.log('[AthleteJobs] Starting nightly run...');
    const start = Date.now();

    try {
      // 1. Recompute standing for all active athletes
      const standingResult = await StandingService.recomputeAll();
      console.log(`[AthleteJobs] Standing recompute: ${standingResult.processed} processed, ${standingResult.errors} errors`);

      // 2. Evaluate levels for all active athletes
      const levelResult = await this.evaluateAllLevels();
      console.log(`[AthleteJobs] Level evaluation: ${levelResult.promoted} promoted, ${levelResult.errors} errors`);

      // 3. Check inactivity
      const inactivityResult = await this.checkInactivity();
      console.log(`[AthleteJobs] Inactivity check: ${inactivityResult.atRisk} at-risk, ${inactivityResult.toReserve} -> reserve, ${inactivityResult.toDischarge} -> discharged`);

      // 4. Check trial expiry
      const trialResult = await this.checkTrialExpiry();
      console.log(`[AthleteJobs] Trial check: ${trialResult.expired} expired, ${trialResult.nudged} nudged`);

      // 5. Update streaks (check who was active today)
      const streakResult = await this.updateDailyStreaks();
      console.log(`[AthleteJobs] Streak update: ${streakResult.updated} updated, ${streakResult.broken} broken`);

      // 6. Capture one idempotent rank snapshot per active athlete for Ranks.
      const rankResult = await GamificationService.captureRankSnapshots();
      console.log(`[AthleteJobs] Rank snapshots: ${rankResult.captured} captured`);

    } catch (err) {
      console.error('[AthleteJobs] Nightly run failed:', err);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[AthleteJobs] Nightly run complete in ${elapsed}s`);
  },

  /**
   * Evaluate levels for all ACTIVE and ON_TRIAL athletes.
   * Promotes one level at a time, re-enqueues after each promotion.
   */
  async evaluateAllLevels() {
    const { data: athletes, error } = await supabase
      .from('influencers')
      .select('id')
      .in('athlete_status', ['ACTIVE', 'ON_TRIAL']);

    if (error) throw error;

    let promoted = 0;
    let errors = 0;

    for (const athlete of (athletes || [])) {
      try {
        let reEnqueue = true;
        let maxIterations = 3; // Safety: max 3 promotions per nightly run

        while (reEnqueue && maxIterations > 0) {
          const result = await LevelEngine.evaluate(athlete.id);
          if (result.result === 'Promoted') promoted++;
          reEnqueue = result.reEnqueue;
          maxIterations--;
        }
      } catch (err) {
        console.error(`[AthleteJobs] Level eval failed for athlete ${athlete.id}:`, err);
        errors++;
      }
    }

    return { promoted, errors };
  },

  /**
   * Check inactivity and transition athletes through the lifecycle:
   * ACTIVE -> at_risk (flag only) -> RESERVE -> DISCHARGED
   */
  async checkInactivity() {
    // Read settings
    const atRiskDays = await this._getSetting('inactivity.at_risk_days', 45);
    const reserveDays = await this._getSetting('inactivity.reserve_days', 90);
    const dischargeDays = await this._getSetting('inactivity.discharge_days', 180);

    let atRisk = 0, toReserve = 0, toDischarge = 0;

    // Check ACTIVE athletes for inactivity
    const { data: activeAthletes } = await supabase
      .from('influencers')
      .select('id, athlete_status')
      .eq('athlete_status', 'ACTIVE');

    for (const athlete of (activeAthletes || [])) {
      const daysSince = await this._daysSinceLastActivity(athlete.id);

      if (daysSince >= reserveDays) {
        try {
          await TransitionService.move('influencer', athlete.id, 'RESERVE', 'system', 'INACTIVITY');
          toReserve++;
        } catch (err) {
          if (err.status !== 422) console.error(`[AthleteJobs] Failed to move ${athlete.id} to RESERVE:`, err);
        }
      } else if (daysSince >= atRiskDays) {
        atRisk++;
        // Future: send warning message
      }
    }

    // Check RESERVE athletes for discharge
    const { data: reserveAthletes } = await supabase
      .from('influencers')
      .select('id')
      .eq('athlete_status', 'RESERVE');

    for (const athlete of (reserveAthletes || [])) {
      const daysSince = await this._daysSinceLastActivity(athlete.id);

      if (daysSince >= dischargeDays) {
        try {
          await TransitionService.move('influencer', athlete.id, 'DISCHARGED', 'system', 'RESERVE_EXPIRED');
          toDischarge++;
        } catch (err) {
          if (err.status !== 422) console.error(`[AthleteJobs] Failed to discharge ${athlete.id}:`, err);
        }
      }
    }

    return { atRisk, toReserve, toDischarge };
  },

  /**
   * Check trial expiry and send nudges.
   */
  async checkTrialExpiry() {
    const windowDays = await this._getSetting('trial.window_days', 30);
    const nudgeDays = await this._getSetting('trial.nudge_days', [7, 14, 21, 27]);

    let expired = 0, nudged = 0;

    const { data: trialAthletes } = await supabase
      .from('influencers')
      .select('id, level_since')
      .eq('athlete_status', 'ON_TRIAL');

    for (const athlete of (trialAthletes || [])) {
      if (!athlete.level_since) continue;

      const daysInTrial = Math.floor(
        (Date.now() - new Date(athlete.level_since).getTime()) / (1000 * 60 * 60 * 24)
      );

      // Check if trial expired
      if (daysInTrial >= windowDays) {
        try {
          await TransitionService.move('influencer', athlete.id, 'TRIAL_LAPSED', 'system', 'TRIAL_EXPIRED');
          expired++;
        } catch (err) {
          if (err.status !== 422) console.error(`[AthleteJobs] Failed to expire trial for ${athlete.id}:`, err);
        }
      } else {
        // Check if today is a nudge day
        if (nudgeDays.includes(daysInTrial)) {
          nudged++;
          // Future: send WhatsApp nudge message
          console.log(`[AthleteJobs] Nudge day ${daysInTrial} for athlete ${athlete.id}`);
        }
      }
    }

    return { expired, nudged };
  },

  /**
   * Check liveness of APPROVED assignments past the horizon.
   * If post is removed -> CLAWED_BACK.
   * Call this hourly.
   */
  async checkLiveness() {
    const horizonDays = await this._getSetting('liveness.horizon_days', 30);
    const horizonAgo = new Date(Date.now() - horizonDays * 24 * 60 * 60 * 1000).toISOString();

    const { data: assignments, error } = await supabase
      .from('assignments')
      .select('id, influencer_id, liveness_check_at')
      .eq('status', 'APPROVED')
      .lte('reviewed_at', horizonAgo);

    if (error) throw error;

    let verified = 0, clawed = 0;

    for (const assignment of (assignments || [])) {
      // Future: actually check if the post is still live via platform API
      // For now, mark as verified
      try {
        await supabase
          .from('assignments')
          .update({ status: 'VERIFIED_LIVE', liveness_check_at: new Date().toISOString() })
          .eq('id', assignment.id);

        verified++;
      } catch (err) {
        console.error(`[AthleteJobs] Liveness check failed for assignment ${assignment.id}:`, err);
      }
    }

    console.log(`[AthleteJobs] Liveness: ${verified} verified, ${clawed} clawed back`);
    return { verified, clawed };
  },

  /**
   * Publish five rotating athlete-only missions for today and prebuild tomorrow.
   * Existing admin-curated pools are never overwritten.
   */
  async runDaily() {
    console.log('[AthleteJobs] Starting daily mission rotation...');
    const start = Date.now();
    const indiaDate = (offsetDays = 0) => {
      const date = new Date(Date.now() + offsetDays * 86400000);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      const values = Object.fromEntries(parts
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    };

    try {
      const today = indiaDate();
      const tomorrow = indiaDate(1);

      for (const poolDate of [today, tomorrow]) {
        const { data: existingPool, error } = await supabase
          .from('daily_task_pools')
          .select('id')
          .eq('pool_date', poolDate)
          .maybeSingle();
        if (error) throw error;

        if (!existingPool) {
          const result = await this.autoGeneratePool(poolDate);
          console.log(`[AthleteJobs] Published ${result.taskCount} athlete missions for ${poolDate}`);
        }
      }

      const yesterday = indiaDate(-1);
      await this.expireUnpickedTasks(yesterday);
      console.log(`[AthleteJobs] Expired unpicked tasks for ${yesterday}`);
    } catch (err) {
      console.error('[AthleteJobs] Daily mission rotation failed:', err);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[AthleteJobs] Daily mission rotation complete in ${elapsed}s`);
  },

  /**
   * Run weekly jobs — call on Monday 00:00 IST.
   * Closes previous week's challenge, ranks entries, awards winners.
   */
  async runWeekly() {
    console.log('[AthleteJobs] Starting weekly run...');
    const start = Date.now();

    try {
      // Find last week's challenge
      const today = new Date();
      const lastWeekEnd = new Date(today);
      lastWeekEnd.setDate(today.getDate() - today.getDay()); // Last Sunday
      const lastWeekStart = new Date(lastWeekEnd);
      lastWeekStart.setDate(lastWeekEnd.getDate() - 6); // Last Monday

      const startDate = lastWeekStart.toISOString().slice(0, 10);
      const endDate = lastWeekEnd.toISOString().slice(0, 10);

      const { data: challenge } = await supabase
        .from('weekly_challenges')
        .select('*')
        .eq('is_active', true)
        .eq('week_start', startDate)
        .maybeSingle();

      if (challenge) {
        // Rank entries by score (or admin-reviewed rank)
        const { data: entries } = await supabase
          .from('weekly_challenge_entries')
          .select('*')
          .eq('weekly_challenge_id', challenge.id)
          .eq('status', 'APPROVED')
          .order('score', { ascending: false });

        // Assign ranks if not already ranked
        if (entries && entries.length > 0) {
          for (let i = 0; i < entries.length; i++) {
            if (!entries[i].rank) {
              await supabase
                .from('weekly_challenge_entries')
                .update({ rank: i + 1 })
                .eq('id', entries[i].id);
            }
          }
        }

        // Award winners
        const result = await GamificationService.awardWeeklyWinners(challenge.id);
        console.log(`[AthleteJobs] Awarded ${result.awarded} weekly winners for challenge "${challenge.title}"`);

        // Deactivate the challenge
        await supabase
          .from('weekly_challenges')
          .update({ is_active: false })
          .eq('id', challenge.id);
      }

    } catch (err) {
      console.error('[AthleteJobs] Weekly run failed:', err);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[AthleteJobs] Weekly run complete in ${elapsed}s`);
  },

  /**
   * Auto-generate an athlete portal pool from the dedicated mission catalog.
   * Five mission types are preferred and the prior pool is avoided when possible.
   */
  async autoGeneratePool(date) {
    const maxPicks = await this._getSetting('daily_task.max_picks', 5);
    const { data: templates, error } = await supabase
      .from('task_templates')
      .select('id, title, type, xp_value, coin_value')
      .eq('is_active', true)
      .eq('is_trial_task', false)
      .eq('is_athlete_portal_task', true);

    if (error) throw error;
    if (!templates || templates.length === 0) return { taskCount: 0 };

    const previousDate = new Date(`${date}T12:00:00Z`);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);
    const { data: previousPool } = await supabase
      .from('daily_task_pools')
      .select('task_template_ids')
      .eq('pool_date', previousDate.toISOString().slice(0, 10))
      .maybeSingle();
    const previousIds = new Set(previousPool?.task_template_ids || []);
    const freshTemplates = templates.filter(t => !previousIds.has(t.id));
    const candidates = freshTemplates.length >= maxPicks ? freshTemplates : templates;

    // Shuffle before selecting, so each daily pool is a real rotation.
    const shuffled = [...candidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const selected = [];
    const usedTypes = new Set();
    for (const task of shuffled) {
      if (selected.length >= maxPicks) break;
      if (!usedTypes.has(task.type)) {
        selected.push(task.id);
        usedTypes.add(task.type);
      }
    }
    for (const task of shuffled) {
      if (selected.length >= maxPicks) break;
      if (!selected.includes(task.id)) selected.push(task.id);
    }

    await GamificationService.createDailyPool(date, selected, 'athlete-portal-rotation');
    return { taskCount: selected.length };
  },

  /**
   * Expire picks that were PICKED but never submitted.
   */
  async expireUnpickedTasks(date) {
    const { data: picks } = await supabase
      .from('daily_task_picks')
      .select('id, assignment_id')
      .eq('pool_date', date)
      .eq('status', 'PICKED');

    if (!picks || picks.length === 0) return;

    const pickIds = picks.map(p => p.id);
    const assignmentIds = picks.map(p => p.assignment_id).filter(Boolean);

    // Update pick status
    if (pickIds.length > 0) {
      await supabase
        .from('daily_task_picks')
        .update({ status: 'EXPIRED' })
        .in('id', pickIds);
    }

    // Expire associated assignments
    if (assignmentIds.length > 0) {
      await supabase
        .from('assignments')
        .update({ status: 'EXPIRED' })
        .in('id', assignmentIds)
        .eq('status', 'ASSIGNED');
    }
  },

  /**
   * Update streaks nightly — check which athletes had activity today.
   */
  async updateDailyStreaks() {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Find athletes who had an approved submission today
    const { data: todayApprovals } = await supabase
      .from('assignments')
      .select('influencer_id')
      .eq('reviewed_at', today)
      .in('status', ['APPROVED', 'VERIFIED_LIVE']);

    // Also check daily_task_picks completed today
    const { data: todayPicks } = await supabase
      .from('daily_task_picks')
      .select('influencer_id')
      .eq('pool_date', today)
      .in('status', ['APPROVED', 'SUBMITTED']);

    const activeToday = new Set();
    (todayApprovals || []).forEach(a => activeToday.add(a.influencer_id));
    (todayPicks || []).forEach(p => activeToday.add(p.influencer_id));

    let updated = 0, broken = 0;

    // Get all athletes with active streaks
    const { data: streaks } = await supabase
      .from('athlete_streaks')
      .select('*')
      .gt('current_streak', 0);

    for (const streak of (streaks || [])) {
      if (streak.last_active_date === today) continue; // Already updated

      if (streak.last_active_date === yesterday && activeToday.has(streak.influencer_id)) {
        // Consecutive — will be handled by GamificationService.updateStreak when task approved
        continue;
      }

      if (streak.last_active_date !== today && streak.last_active_date !== yesterday) {
        // Streak broken (missed a day)
        await supabase
          .from('athlete_streaks')
          .update({ current_streak: 0, updated_at: new Date().toISOString() })
          .eq('influencer_id', streak.influencer_id);
        broken++;
      }
    }

    updated = activeToday.size;
    return { updated, broken };
  },

  /**
   * Get days since last approved submission or order.
   * @private
   */
  async _daysSinceLastActivity(influencerId) {
    // Check last approved assignment
    const { data: lastAssignment } = await supabase
      .from('assignments')
      .select('reviewed_at')
      .eq('influencer_id', influencerId)
      .in('status', ['APPROVED', 'VERIFIED_LIVE'])
      .order('reviewed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Check last attributed order
    const { data: lastOrder } = await supabase
      .from('attributed_orders')
      .select('placed_at')
      .eq('influencer_id', influencerId)
      .order('placed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let lastActivity = null;
    if (lastAssignment?.reviewed_at) lastActivity = new Date(lastAssignment.reviewed_at);
    if (lastOrder?.placed_at) {
      const orderDate = new Date(lastOrder.placed_at);
      if (!lastActivity || orderDate > lastActivity) lastActivity = orderDate;
    }

    if (!lastActivity) return 999; // No activity ever
    return Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));
  },

  /**
   * Read a program setting value.
   * @private
   */
  async _getSetting(key, defaultValue) {
    const { data } = await supabase
      .from('program_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    return data?.value ?? defaultValue;
  }
};

module.exports = AthleteJobs;
