// ============================================================================
// Athlete Program — API Routes
// ----------------------------------------------------------------------------
// Mount these in server.js: require('./services/athlete-program/routes')(app)
// Admin routes under /api/athlete-admin/
// Athlete routes under /api/athlete/
// ============================================================================

const supabase = require('../../config/supabase');
const {
  LedgerService, LevelEngine, TransitionService,
  TokenService, StandingService, AttributionService, PayoutService,
  GamificationService
} = require('./index');

module.exports = function mountAthleteRoutes(app) {

  // ── Helper: authenticate admin ──
  async function authAdmin(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    // Reuse existing authenticateAdmin logic or check a simple admin token
    // For now, pass through if token exists (integrate with existing auth)
    req.adminToken = token;
    next();
  }

  // ── Helper: resolve athlete from scoped token ──
  // Live-on-portal presence: influencerId -> epoch ms of last authed API call.
  // In-memory by design (resets on restart); every authed request is a beacon,
  // so any athlete with the portal open refreshes via its 30s leaderboard poll.
  const portalPresence = new Map();

  async function authAthlete(req, res, next) {
    const { token } = req.params;
    if (!token) return res.status(401).json({ error: 'No token' });

    const resolved = await TokenService.resolve(token);
    if (!resolved) {
      console.warn(`[athlete-auth] rejected ${req.method} ${req.originalUrl || req.url} token=${String(token).slice(0, 4)}…(len ${token.length})`);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    portalPresence.set(resolved.influencerId, Date.now());
    req.athleteScope = resolved;
    next();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // ── Dashboard Stats ──
  app.get('/api/athlete-admin/dashboard', authAdmin, async (req, res) => {
    try {
      const [athletes, apps, review] = await Promise.all([
        supabase.from('influencers').select('id, athlete_status', { count: 'exact', head: false }),
        supabase.from('applications').select('id, status', { count: 'exact', head: false }).eq('status', 'APPLIED'),
        supabase.from('assignments').select('id', { count: 'exact', head: false }).in('status', ['SUBMITTED', 'UNDER_REVIEW'])
      ]);
      res.json({ success: true, data: {
        total_athletes: athletes.data?.length || 0,
        active: athletes.data?.filter(a => a.athlete_status === 'ACTIVE').length || 0,
        on_trial: athletes.data?.filter(a => a.athlete_status === 'ON_TRIAL').length || 0,
        pending_apps: apps.data?.length || 0,
        review_queue: review.data?.length || 0
      }});
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Athletes List ──
  app.get('/api/athlete-admin/athletes', authAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('influencers')
        .select('id, name, athlete_no, athlete_status, xp_total, coin_balance, standing_score, level_id, joined_at, phone, email')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Enrich with level info
      const levelIds = [...new Set(data.map(a => a.level_id).filter(Boolean))];
      let levelsMap = {};
      if (levelIds.length > 0) {
        const { data: levels } = await supabase
          .from('comfort_levels')
          .select('id, display_name, ordinal, dial_segments_lit')
          .in('id', levelIds);
        levels.forEach(l => levelsMap[l.id] = l);
      }

      const enriched = (data || []).map(a => ({
        ...a,
        level: levelsMap[a.level_id] || null,
        level_name: levelsMap[a.level_id]?.display_name || 'Unranked',
        level_ordinal: levelsMap[a.level_id]?.ordinal || 0,
        level_dial: levelsMap[a.level_id]?.dial_segments_lit || 0
      }));

      res.json({ success: true, data: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Athlete Status Transition ──
  app.patch('/api/athlete-admin/athletes/:id/status', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reason } = req.body;
      const result = await TransitionService.move('influencer', parseInt(id), status, req.adminToken, reason);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── Level Override ──
  app.post('/api/athlete-admin/athletes/:id/override-level', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { level_id, reason } = req.body;
      await LevelEngine.override(parseInt(id), level_id, reason, req.adminToken);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Applications ──
  app.get('/api/athlete-admin/applications', authAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('applications')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/applications/:id/approve', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      // Update application status
      await supabase.from('applications').update({ status: 'APPROVED', reviewed_at: new Date().toISOString(), reviewed_by: req.adminToken }).eq('id', id);
      // Fetch application
      const { data: app } = await supabase.from('applications').select('*').eq('id', id).single();
      if (!app) return res.status(404).json({ error: 'Application not found' });

      // Generate athlete_no
      const { count } = await supabase.from('influencers').select('*', { count: 'exact', head: true });
      const athleteNo = 'OFC-' + String((count || 0) + 1).padStart(4, '0');

      // Get CL5 level
      const { data: cl5 } = await supabase.from('comfort_levels').select('id').eq('ordinal', 1).single();

      // Create influencer
      const { data: influencer, error: infErr } = await supabase
        .from('influencers')
        .insert([{
          name: app.payload?.name || app.email,
          phone: app.phone,
          email: app.email,
          athlete_no: athleteNo,
          athlete_status: 'ON_TRIAL',
          level_id: cl5?.id,
          xp_total: 0,
          coin_balance: 0,
          standing_score: 70,
          joined_at: new Date().toISOString(),
          level_since: new Date().toISOString()
        }])
        .select()
        .single();

      if (infErr) throw infErr;

      // Update application with influencer_id
      await supabase.from('applications').update({ influencer_id: influencer.id }).eq('id', id);

      // Create social record
      if (app.primary_handle) {
        await supabase.from('influencer_socials').insert([{
          influencer_id: influencer.id,
          platform: app.payload?.platform || 'instagram',
          handle: app.primary_handle,
          followers: app.payload?.followers || 0,
          is_primary: true
        }]);
      }

      // Issue PROGRESS token
      const progressToken = await TokenService.issue('PROGRESS', influencer.id);

      // Issue ONBOARDING token
      const onboardingToken = await TokenService.issue('ONBOARDING', influencer.id);

      // Create level history
      await supabase.from('level_history').insert([{
        influencer_id: influencer.id,
        from_level_id: null,
        to_level_id: cl5.id,
        direction: 'OVERRIDE',
        reason_code: 'APPLICATION_APPROVED',
        actor_id: req.adminToken
      }]);

      res.json({ success: true, data: { influencer_id: influencer.id, athlete_no: athleteNo, progress_token: progressToken } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/applications/:id/reject', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      await supabase.from('applications').update({ status: 'REJECTED', decision_reason: reason, reviewed_at: new Date().toISOString() }).eq('id', id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Generate/Retrieve Athlete Portal Token ──
  app.post('/api/athlete-admin/athletes/:id/token', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { rotate } = req.body; // if true, revoke existing and create new

      // Check if they already have a PROGRESS token
      const { data: existingTokens } = await supabase
        .from('access_tokens')
        .select('id, scope')
        .eq('influencer_id', parseInt(id))
        .eq('scope', 'PROGRESS')
        .is('revoked_at', null);

      if (existingTokens && existingTokens.length > 0 && !rotate) {
        return res.json({ 
          success: true, 
          data: { 
            message: 'Token already exists',
            has_token: true,
            token_id: existingTokens[0].id
          } 
        });
      }

      // If rotating, revoke existing tokens
      if (rotate) {
        await supabase
          .from('access_tokens')
          .update({ revoked_at: new Date().toISOString() })
          .eq('influencer_id', parseInt(id))
          .eq('scope', 'PROGRESS')
          .is('revoked_at', null);
      }

      // Generate new token
      const crypto = require('crypto');
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const { data: newToken, error: insertErr } = await supabase
        .from('access_tokens')
        .insert([{
          influencer_id: parseInt(id),
          scope: 'PROGRESS',
          token_hash: tokenHash,
          expires_at: null,
          single_use: false,
          consumed_at: null,
          revoked_at: null
        }])
        .select()
        .single();

      if (insertErr) throw insertErr;

      res.json({ 
        success: true, 
        data: { 
          message: rotate ? 'Token rotated' : 'Token generated',
          has_token: true,
          token_id: newToken.id,
          portal_url: 'https://exchange-return-tracking.onrender.com/pages/athlete-portal',
          access_token: rawToken // Only returned once!
        } 
      });
    } catch (err) { 
      res.status(500).json({ error: err.message }); 
    }
  });

  // ─ Task Templates ──
  app.get('/api/athlete-admin/tasks', authAdmin, async (req, res) => {
    try {
      const { type, is_active, is_trial_task, search } = req.query;
      let q = supabase.from('task_templates').select('*');
      if (type) q = q.eq('type', type);
      if (is_active !== undefined) q = q.eq('is_active', is_active === 'true');
      if (is_trial_task !== undefined) q = q.eq('is_trial_task', is_trial_task === 'true');
      if (search) q = q.or(`title.ilike.%${search}%,code.ilike.%${search}%`);
      const { data, error } = await q.order('created_at', { ascending: false });
      if (error) throw error;

      // Enrich with level gate names and assignment counts
      const levelIds = [...new Set((data || []).map(t => t.level_gate_id).filter(Boolean))];
      let levelsMap = {};
      if (levelIds.length > 0) {
        const { data: lvls } = await supabase.from('comfort_levels').select('id, display_name, ordinal').in('id', levelIds);
        (lvls || []).forEach(l => levelsMap[l.id] = l);
      }

      const templateIds = (data || []).map(t => t.id);
      let countsMap = {};
      if (templateIds.length > 0) {
        const { data: counts } = await supabase
          .from('assignments')
          .select('task_template_id, status')
          .in('task_template_id', templateIds);
        (counts || []).forEach(a => {
          if (!countsMap[a.task_template_id]) countsMap[a.task_template_id] = { total: 0, active: 0, approved: 0 };
          countsMap[a.task_template_id].total++;
          if (['ASSIGNED','IN_PROGRESS','SUBMITTED','UNDER_REVIEW','CHANGES_REQUESTED'].includes(a.status)) countsMap[a.task_template_id].active++;
          if (a.status === 'APPROVED') countsMap[a.task_template_id].approved++;
        });
      }

      const enriched = (data || []).map(t => ({
        ...t,
        level_gate_name: levelsMap[t.level_gate_id]?.display_name || null,
        level_gate_ordinal: levelsMap[t.level_gate_id]?.ordinal || null,
        assignment_total: countsMap[t.id]?.total || 0,
        assignment_active: countsMap[t.id]?.active || 0,
        assignment_approved: countsMap[t.id]?.approved || 0
      }));

      res.json({ success: true, data: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/tasks', authAdmin, async (req, res) => {
    try {
      const body = { ...req.body };
      // Normalize booleans from form strings
      if (body.requires_disclosure === 'true') body.requires_disclosure = true;
      if (body.requires_disclosure === 'false') body.requires_disclosure = false;
      if (body.repeatable === 'true') body.repeatable = true;
      if (body.repeatable === 'false') body.repeatable = false;
      if (body.is_trial_task === 'true') body.is_trial_task = true;
      if (body.is_trial_task === 'false') body.is_trial_task = false;
      if (body.is_active === 'true') body.is_active = true;
      if (body.is_active === 'false') body.is_active = false;
      // Normalize nullable integers
      if (body.monthly_cap === '' || body.monthly_cap === null) body.monthly_cap = null;
      else body.monthly_cap = parseInt(body.monthly_cap);
      if (body.cooldown_days === '' || body.cooldown_days === null) body.cooldown_days = 0;
      else body.cooldown_days = parseInt(body.cooldown_days);
      if (body.level_gate_id === '' || body.level_gate_id === null) body.level_gate_id = null;
      else body.level_gate_id = parseInt(body.level_gate_id);
      body.xp_value = parseInt(body.xp_value) || 0;
      body.coin_value = parseInt(body.coin_value) || 0;
      body.due_days = parseInt(body.due_days) || 7;

      const { data, error } = await supabase.from('task_templates').insert([body]).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/athlete-admin/tasks/:id', authAdmin, async (req, res) => {
    try {
      const body = { ...req.body };
      if (body.requires_disclosure === 'true') body.requires_disclosure = true;
      if (body.requires_disclosure === 'false') body.requires_disclosure = false;
      if (body.repeatable === 'true') body.repeatable = true;
      if (body.repeatable === 'false') body.repeatable = false;
      if (body.is_trial_task === 'true') body.is_trial_task = true;
      if (body.is_trial_task === 'false') body.is_trial_task = false;
      if (body.is_active === 'true') body.is_active = true;
      if (body.is_active === 'false') body.is_active = false;
      if (body.monthly_cap === '' || body.monthly_cap === null) body.monthly_cap = null;
      else body.monthly_cap = parseInt(body.monthly_cap);
      if (body.cooldown_days === '' || body.cooldown_days === null) body.cooldown_days = 0;
      else body.cooldown_days = parseInt(body.cooldown_days);
      if (body.level_gate_id === '' || body.level_gate_id === null) body.level_gate_id = null;
      else body.level_gate_id = parseInt(body.level_gate_id);
      body.xp_value = parseInt(body.xp_value) || 0;
      body.coin_value = parseInt(body.coin_value) || 0;
      body.due_days = parseInt(body.due_days) || 7;

      const { data, error } = await supabase.from('task_templates').update(body).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/athlete-admin/tasks/:id', authAdmin, async (req, res) => {
    try {
      // Check for existing assignments
      const { count } = await supabase.from('assignments').select('*', { count: 'exact', head: true }).eq('task_template_id', req.params.id);
      if (count > 0) return res.status(409).json({ error: `Cannot delete: ${count} assignment(s) reference this template` });
      const { error } = await supabase.from('task_templates').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Assign Task to Athletes ──
  app.post('/api/athlete-admin/tasks/:id/assign', authAdmin, async (req, res) => {
    try {
      const { athlete_ids, due_days_override } = req.body;
      if (!athlete_ids || !Array.isArray(athlete_ids) || athlete_ids.length === 0) {
        return res.status(400).json({ error: 'athlete_ids array is required' });
      }
      const { data: template } = await supabase.from('task_templates').select('*').eq('id', req.params.id).single();
      if (!template) return res.status(404).json({ error: 'Task template not found' });

      const dueDays = parseInt(due_days_override) || template.due_days;
      const assignments = athlete_ids.map(aid => ({
        influencer_id: parseInt(aid),
        task_template_id: parseInt(req.params.id),
        due_at: new Date(Date.now() + dueDays * 86400000).toISOString(),
        status: 'ASSIGNED'
      }));

      const { data, error } = await supabase.from('assignments').insert(assignments).select();
      if (error) throw error;
      res.json({ success: true, data, count: data.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Review Queue ──
  app.get('/api/athlete-admin/review-queue', authAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('assignments')
        .select('*, influencer:influencers(name, athlete_no)')
        .in('status', ['SUBMITTED', 'UNDER_REVIEW'])
        .order('due_at', { ascending: true });

      if (error) {
        // Fallback without join
        const { data: fallback, error: fbErr } = await supabase
          .from('assignments')
          .select('*')
          .in('status', ['SUBMITTED', 'UNDER_REVIEW'])
          .order('due_at', { ascending: true });
        if (fbErr) throw fbErr;
        return res.json({ success: true, data: fallback || [] });
      }

      // Also fetch latest submission for each assignment
      const assignmentIds = (data || []).map(a => a.id);
      let submissionsMap = {};
      if (assignmentIds.length > 0) {
        const { data: submissions } = await supabase
          .from('submissions')
          .select('*')
          .in('assignment_id', assignmentIds)
          .order('created_at', { ascending: false });

        (submissions || []).forEach(s => {
          if (!submissionsMap[s.assignment_id]) submissionsMap[s.assignment_id] = s;
        });
      }

      const enriched = (data || []).map(a => ({
        ...a,
        post_url: submissionsMap[a.id]?.post_url,
        athlete_name: a.influencer?.name || a.influencer_id
      }));

      res.json({ success: true, data: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Review Assignment ──
  app.patch('/api/athlete-admin/assignments/:id/review', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reason } = req.body;

      // Transition assignment
      const result = await TransitionService.move('assignment', parseInt(id), status, req.adminToken, reason);

      // If approved, award XP
      if (status === 'APPROVED') {
        const { data: assignment } = await supabase.from('assignments').select('*').eq('id', id).single();
        const { data: task } = await supabase.from('task_templates').select('*').eq('id', assignment.task_template_id).single();

        if (task) {
          let xpValue = task.xp_value || 0;
          // Apply on-time bonus or late penalty
          const isOnTime = !assignment.due_at || new Date(assignment.submitted_at || Date.now()) <= new Date(assignment.due_at);
          if (isOnTime) {
            const bonusPct = 20; // From settings
            xpValue = Math.round(xpValue * (1 + bonusPct / 100));
          } else {
            const penaltyPct = 25;
            xpValue = Math.round(xpValue * (1 - penaltyPct / 100));
          }

          if (xpValue > 0) {
            await LedgerService.award(assignment.influencer_id, 'XP', xpValue, 'ASSIGNMENT', assignment.id,
              `assignment:${id}:approved`, 'TASK_APPROVED');
          }

          if (task.coin_value > 0) {
            await LedgerService.award(assignment.influencer_id, 'COIN', task.coin_value, 'ASSIGNMENT', assignment.id,
              `assignment:${id}:coins`, 'TASK_COINS');
          }

          // Update assignment with awarded amounts
          await supabase.from('assignments').update({
            xp_awarded: xpValue,
            coin_awarded: task.coin_value,
            was_on_time: isOnTime,
            reviewed_at: new Date().toISOString(),
            reviewer_id: req.adminToken
          }).eq('id', id);

          // Recompute standing
          await StandingService.recompute(assignment.influencer_id);

          // Evaluate level
          await LevelEngine.evaluate(assignment.influencer_id);
        }
      }

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── Levels ──
  app.get('/api/athlete-admin/levels', authAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('comfort_levels').select('*').order('ordinal');
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Ledger ──
  app.get('/api/athlete-admin/ledger/:influencerId', authAdmin, async (req, res) => {
    try {
      const entries = await LedgerService.history(parseInt(req.params.influencerId));
      res.json({ success: true, data: entries });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Settings ──
  app.get('/api/athlete-admin/settings', authAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('program_settings').select('*').order('key');
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/settings', authAdmin, async (req, res) => {
    try {
      const { settings } = req.body;
      for (const s of settings) {
        await supabase.from('program_settings')
          .update({ value: s.value, updated_at: new Date().toISOString(), updated_by: req.adminToken })
          .eq('key', s.key);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Payouts ──
  app.get('/api/athlete-admin/payouts', authAdmin, async (req, res) => {
    try {
      const list = await PayoutService.list();
      res.json({ success: true, data: list });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/payouts/build-batch', authAdmin, async (req, res) => {
    try {
      const { period_start, period_end } = req.body;
      const { batch, totalGross, totalNet, athleteCount } = await PayoutService.buildBatch(period_start, period_end);
      const { created, skipped } = await PayoutService.saveBatch(batch);
      res.json({ success: true, data: { created, skipped, totalGross, totalNet, athleteCount } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/payouts/:id/queue', authAdmin, async (req, res) => {
    try {
      await supabase.from('payouts').update({ status: 'QUEUED', queued_at: new Date().toISOString() }).eq('id', req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ATHLETE-FACING ROUTES (scoped token auth)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Application ──
  app.post('/api/athlete/apply', async (req, res) => {
    try {
      const { name, phone, email, platform, handle, followers, city, niche, why_join } = req.body;
      if (!name || !phone || !email || !handle) {
        return res.status(400).json({ error: 'Name, phone, email, and handle are required' });
      }

      // Check for existing application
      const { data: existing } = await supabase
        .from('applications')
        .select('id')
        .eq('email', email)
        .in('status', ['APPLIED', 'SCREENING'])
        .maybeSingle();

      if (existing) return res.status(409).json({ error: 'You already have a pending application' });

      // Auto-score based on followers
      let autoScore = 0;
      if (followers >= 500000) autoScore = 90;
      else if (followers >= 100000) autoScore = 70;
      else if (followers >= 50000) autoScore = 50;
      else if (followers >= 10000) autoScore = 30;
      else autoScore = 15;

      const { data, error } = await supabase.from('applications').insert([{
        payload: { name, platform, followers, niche, city, why_join },
        email, phone, primary_handle: handle, auto_score: autoScore, status: 'APPLIED'
      }]).select().single();

      if (error) throw error;
      res.json({ success: true, application_id: data.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Progress (PROGRESS token) ──
  app.get('/api/athlete/:token/progress', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const { data: athlete, error } = await supabase
        .from('influencers')
        .select('id, name, athlete_no, athlete_status, xp_total, coin_balance, standing_score, level_id, joined_at')
        .eq('id', influencerId)
        .single();

      if (error) throw error;

      // Get level info
      let level = null, nextLevel = null;
      if (athlete.level_id) {
        const { data: lvl } = await supabase.from('comfort_levels').select('*').eq('id', athlete.level_id).single();
        level = lvl;
        const { data: next } = await supabase.from('comfort_levels').select('*').eq('ordinal', lvl.ordinal + 1).maybeSingle();
        nextLevel = next;
      }

      // Get discount code
      let discountCode = null;
      const { data: dc } = await supabase
        .from('discount_codes')
        .select('code, percent, is_active')
        .eq('influencer_id', influencerId)
        .maybeSingle();
      if (dc) discountCode = { code: dc.code, percent: dc.percent, is_active: dc.is_active };

      // Count orders this month
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { count: monthOrders } = await supabase
        .from('attributed_orders')
        .select('*', { count: 'exact', head: true })
        .eq('influencer_id', influencerId)
        .gte('placed_at', monthStart);

      // WHITELIST fields per spec §09 — only expose safe fields
      res.json({ success: true, data: {
        id: athlete.id,
        name: athlete.name,
        athlete_no: athlete.athlete_no,
        athlete_status: athlete.athlete_status,
        xp_total: athlete.xp_total,
        coin_balance: athlete.coin_balance,
        standing_score: athlete.standing_score,
        joined_at: athlete.joined_at,
        instagram_handle: athlete.instagram_handle,
        phone: athlete.phone,
        leaderboard_opt_out: athlete.leaderboard_opt_out,
        level: level ? { display_name: level.display_name, ordinal: level.ordinal, display_number: level.display_number, dial_segments_lit: level.dial_segments_lit, min_xp: level.min_xp } : null,
        next_level: nextLevel ? { display_name: nextLevel.display_name, min_xp: nextLevel.min_xp } : null,
        discount_code: discountCode,
        month_orders: monthOrders || 0
      }});
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Assignments ──
  app.get('/api/athlete/:token/assignments', authAthlete, async (req, res) => {
    try {
      const { influencerId } = req.athleteScope;
      const { data, error } = await supabase
        .from('assignments')
        .select('id, task_template_id, status, due_at, submitted_at, attempt_no, xp_awarded, coin_awarded')
        .eq('influencer_id', influencerId)
        .in('status', ['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'])
        .order('due_at', { ascending: true });

      if (error) throw error;

      // Enrich with task template info
      const templateIds = [...new Set((data || []).map(a => a.task_template_id))];
      let templatesMap = {};
      if (templateIds.length > 0) {
        const { data: templates } = await supabase.from('task_templates').select('id, title, type, platform, xp_value, coin_value, brief_md').in('id', templateIds);
        (templates || []).forEach(t => templatesMap[t.id] = t);
      }

      const enriched = (data || []).map(a => ({
        ...a,
        title: templatesMap[a.task_template_id]?.title || 'Task',
        task_type: templatesMap[a.task_template_id]?.type || 'CONTENT_POST',
        platform: templatesMap[a.task_template_id]?.platform || '',
        xp_value: templatesMap[a.task_template_id]?.xp_value || 0,
        coin_value: templatesMap[a.task_template_id]?.coin_value || 0,
        brief: templatesMap[a.task_template_id]?.brief_md || ''
      }));

      res.json({ success: true, data: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Submit Proof ──
  app.post('/api/athlete/:token/submissions/:assignmentId', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      const { assignmentId } = req.params;
      const { post_url, caption, disclosure_found } = req.body;

      if (!post_url) return res.status(400).json({ error: 'post_url is required' });

      // Verify assignment belongs to this athlete
      const { data: assignment } = await supabase
        .from('assignments')
        .select('*')
        .eq('id', parseInt(assignmentId))
        .eq('influencer_id', influencerId)
        .single();

      if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

      // Create submission
      const crypto = require('crypto');
      const urlHash = crypto.createHash('sha256').update(post_url).digest('hex');

      const { data: submission, error } = await supabase.from('submissions').insert([{
        assignment_id: assignment.id,
        attempt_no: (assignment.attempt_no || 0) + 1,
        post_url,
        url_hash: urlHash,
        posted_at: new Date().toISOString(),
        caption,
        disclosure_found: disclosure_found || false
      }]).select().single();

      if (error) throw error;

      // Update assignment
      await supabase.from('assignments').update({
        status: 'SUBMITTED',
        submitted_at: new Date().toISOString(),
        attempt_no: submission.attempt_no
      }).eq('id', assignment.id);

      // If first submission, transition to IN_PROGRESS first
      if (assignment.status === 'ASSIGNED') {
        await TransitionService.move('assignment', assignment.id, 'IN_PROGRESS', 'athlete');
        await TransitionService.move('assignment', assignment.id, 'SUBMITTED', 'athlete');
      }

      res.json({ success: true, data: { submission_id: submission.id } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Leaderboard ──
  app.get('/api/athlete/:token/leaderboard', authAthlete, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('influencers')
        .select('id, name, athlete_no, xp_total, level_id, leaderboard_opt_out')
        .eq('leaderboard_opt_out', false)
        .in('athlete_status', ['ACTIVE', 'ON_TRIAL'])
        .order('xp_total', { ascending: false })
        .limit(20);

      if (error) throw error;

      // Enrich with level names
      const levelIds = [...new Set((data || []).map(a => a.level_id).filter(Boolean))];
      let levelsMap = {};
      if (levelIds.length > 0) {
        const { data: levels } = await supabase.from('comfort_levels').select('id, display_name').in('id', levelIds);
        (levels || []).forEach(l => levelsMap[l.id] = l);
      }

      const enriched = (data || []).map(a => ({
        ...a,
        level_name: levelsMap[a.level_id]?.display_name || '—',
        last_seen: portalPresence.get(a.id) || null
      }));

      res.json({ success: true, data: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GAMIFICATION — ADMIN ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // ── Daily Task Pools (Admin) ──
  app.get('/api/athlete-admin/daily-pools', authAdmin, async (req, res) => {
    try {
      const { start_date, end_date } = req.query;
      const pools = await GamificationService.listDailyPools(start_date, end_date);
      res.json({ success: true, data: pools });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/daily-pools', authAdmin, async (req, res) => {
    try {
      const { pool_date, task_template_ids } = req.body;
      if (!pool_date || !task_template_ids || !Array.isArray(task_template_ids)) {
        return res.status(400).json({ error: 'pool_date and task_template_ids[] are required' });
      }
      const pool = await GamificationService.createDailyPool(pool_date, task_template_ids, req.adminToken);
      res.json({ success: true, data: pool });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Weekly Challenges (Admin) ──
  app.get('/api/athlete-admin/weekly-challenges', authAdmin, async (req, res) => {
    try {
      const { include_past } = req.query;
      const challenges = await GamificationService.listWeeklyChallenges(include_past === 'true');
      res.json({ success: true, data: challenges });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/weekly-challenges', authAdmin, async (req, res) => {
    try {
      const body = req.body;
      body.created_by = req.adminToken;
      body.reward_xp = parseInt(body.reward_xp) || 0;
      body.reward_coins = parseInt(body.reward_coins) || 0;
      body.max_winners = parseInt(body.max_winners) || 3;

      const { data, error } = await supabase.from('weekly_challenges').insert([body]).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/weekly-challenges/:id', authAdmin, async (req, res) => {
    try {
      const body = { ...req.body };
      if (body.reward_xp !== undefined) body.reward_xp = parseInt(body.reward_xp);
      if (body.reward_coins !== undefined) body.reward_coins = parseInt(body.reward_coins);
      if (body.max_winners !== undefined) body.max_winners = parseInt(body.max_winners);

      const { data, error } = await supabase.from('weekly_challenges').update(body).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/athlete-admin/weekly-challenges/:id/leaderboard', authAdmin, async (req, res) => {
    try {
      const challengeId = parseInt(req.params.id);

      // Get all entries for this challenge
      const { data: entries, error } = await supabase
        .from('weekly_challenge_entries')
        .select('*')
        .eq('weekly_challenge_id', challengeId)
        .order('rank', { ascending: true, nullsLast: true });

      if (error) throw error;

      // Enrich with athlete info
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

      const enriched = (entries || []).map(e => ({
        ...e,
        athlete: athletesMap[e.influencer_id] || { name: 'Unknown', athlete_no: '—' }
      }));

      const { data: challenge } = await supabase.from('weekly_challenges').select('*').eq('id', challengeId).single();

      res.json({ success: true, data: { challenge, entries: enriched } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/weekly-entries/:id/review', authAdmin, async (req, res) => {
    try {
      const { status, score, rank } = req.body;
      const entry = await GamificationService.reviewWeeklyEntry(
        parseInt(req.params.id), status, score, rank, req.adminToken
      );
      res.json({ success: true, data: entry });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/weekly-challenges/:id/award-winners', authAdmin, async (req, res) => {
    try {
      const result = await GamificationService.awardWeeklyWinners(parseInt(req.params.id));
      res.json({ success: true, data: result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Game Settings (Admin) ──
  app.get('/api/athlete-admin/game-settings', authAdmin, async (req, res) => {
    try {
      const settings = await GamificationService.getGameSettings();
      res.json({ success: true, data: settings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/game-settings', authAdmin, async (req, res) => {
    try {
      const { settings } = req.body;
      if (!settings || !Array.isArray(settings)) return res.status(400).json({ error: 'settings[] array required' });
      await GamificationService.updateGameSettings(settings, req.adminToken);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Streaks (Admin) ──
  app.get('/api/athlete-admin/streaks', authAdmin, async (req, res) => {
    try {
      const streaks = await GamificationService.getAllStreaks();
      res.json({ success: true, data: streaks });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/streaks/:influencerId', authAdmin, async (req, res) => {
    try {
      const { current_streak, longest_streak } = req.body;
      const updateData = { updated_at: new Date().toISOString() };
      if (current_streak !== undefined) updateData.current_streak = parseInt(current_streak);
      if (longest_streak !== undefined) updateData.longest_streak = parseInt(longest_streak);

      const { data, error } = await supabase
        .from('athlete_streaks')
        .update(updateData)
        .eq('influencer_id', parseInt(req.params.influencerId))
        .select()
        .single();

      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Badges (Admin) ──
  app.get('/api/athlete-admin/badges', authAdmin, async (req, res) => {
    try {
      const badges = await GamificationService.getAllBadgeDefinitions();
      res.json({ success: true, data: badges });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/badges', authAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('badge_definitions').insert([req.body]).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/badges/award', authAdmin, async (req, res) => {
    try {
      const { influencer_id, badge_code } = req.body;
      if (!influencer_id || !badge_code) return res.status(400).json({ error: 'influencer_id and badge_code required' });
      const result = await GamificationService.manualAwardBadge(parseInt(influencer_id), badge_code);
      res.json({ success: true, data: result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GAMIFICATION — ATHLETE-FACING ROUTES (scoped token auth)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Daily Tasks ──
  app.get('/api/athlete/:token/daily-tasks', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const result = await GamificationService.getDailyTasksForAthlete(influencerId);
      res.json({ success: true, data: result });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/athlete/:token/daily-tasks/pick', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const { task_template_id, date } = req.body;
      if (!task_template_id) return res.status(400).json({ error: 'task_template_id is required' });

      const result = await GamificationService.pickTask(influencerId, parseInt(task_template_id), date);
      res.json({ success: true, data: result });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Weekly Challenge ──
  app.get('/api/athlete/:token/weekly-challenge', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const result = await GamificationService.getWeeklyChallengeForAthlete(influencerId);
      res.json({ success: true, data: result });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/athlete/:token/weekly-challenge/submit', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const { challenge_id, submission_url, caption, disclosure_found } = req.body;
      if (!challenge_id || !submission_url) {
        return res.status(400).json({ error: 'challenge_id and submission_url are required' });
      }

      const entry = await GamificationService.submitWeeklyEntry(
        influencerId, parseInt(challenge_id), submission_url, caption, disclosure_found
      );
      res.json({ success: true, data: entry });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Weekly Leaderboard ──
  app.get('/api/athlete/:token/weekly-leaderboard', authAthlete, async (req, res) => {
    try {
      const { challenge_id } = req.query;
      const result = await GamificationService.getWeeklyLeaderboard(challenge_id ? parseInt(challenge_id) : null);
      res.json({ success: true, data: result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Streak ──
  app.get('/api/athlete/:token/streak', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const streak = await GamificationService.getStreak(influencerId);
      res.json({ success: true, data: streak });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Climb / Comfort-Level Ladder ──
  app.get('/api/athlete/:token/climb', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      res.json({ success: true, data: await GamificationService.getClimb(influencerId) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Personal Ranks / History ──
  app.get('/api/athlete/:token/ranks', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      res.json({ success: true, data: await GamificationService.getRanks(influencerId) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Personal Activity Log ──
  app.get('/api/athlete/:token/log', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      res.json({ success: true, data: await GamificationService.getActivityLog(influencerId) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Badges ──
  app.get('/api/athlete/:token/badges', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const badges = await GamificationService.getAthleteBadges(influencerId);
      res.json({ success: true, data: badges });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Orders ──
  app.get('/api/athlete/:token/orders', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      const orders = await AttributionService.getOrders(influencerId, { limit: 100 });
      res.json({ success: true, data: orders });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Commissions ──
  app.get('/api/athlete/:token/commissions', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const COMMISSION_RATE = 7; // 7% flat rate on every order

      const { data: orders, error } = await supabase
        .from('attributed_orders')
        .select('commission_amount, commission_status, placed_at, net_value, code_used, customer_name, shopify_order_id, is_cancelled, refunded_amount')
        .eq('influencer_id', influencerId)
        .order('placed_at', { ascending: false });
      if (error) throw error;

      // Calculate commission at 7% on each order's net_value
      const effectiveOrders = (orders || []).map(o => {
        const netVal = parseFloat(o.net_value) || 0;
        const commission = Math.round(netVal * COMMISSION_RATE / 100 * 100) / 100;
        const isCancelled = o.is_cancelled || false;
        const status = isCancelled ? 'REVERSED' : (o.commission_status || 'PENDING');
        return { ...o, net_value: netVal, commission_7pct: commission, effective_status: status };
      });

      // Summary
      const summary = {
        total_orders: effectiveOrders.length,
        total_revenue: effectiveOrders.reduce((s, o) => s + o.net_value, 0),
        total_commission: effectiveOrders.reduce((s, o) => s + o.commission_7pct, 0),
        earned: effectiveOrders.filter(o => o.effective_status === 'EARNED').reduce((s, o) => s + o.commission_7pct, 0),
        pending: effectiveOrders.filter(o => o.effective_status === 'PENDING').reduce((s, o) => s + o.commission_7pct, 0),
        paid: effectiveOrders.filter(o => o.effective_status === 'PAID').reduce((s, o) => s + o.commission_7pct, 0),
        reversed: effectiveOrders.filter(o => o.effective_status === 'REVERSED').reduce((s, o) => s + o.commission_7pct, 0),
        commission_rate: COMMISSION_RATE
      };

      // Monthly breakdown
      const monthlyMap = {};
      for (const o of effectiveOrders) {
        const d = new Date(o.placed_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyMap[key]) monthlyMap[key] = { month: key, orders: 0, revenue: 0, commission: 0, earned: 0, pending: 0, paid: 0, reversed: 0, codes: {} };
        monthlyMap[key].orders++;
        monthlyMap[key].revenue += o.net_value;
        monthlyMap[key].commission += o.commission_7pct;
        // Track coupon codes used this month
        const code = o.code_used || 'DIRECT';
        monthlyMap[key].codes[code] = (monthlyMap[key].codes[code] || 0) + 1;
        const status = o.effective_status.toLowerCase();
        if (monthlyMap[key][status] !== undefined) monthlyMap[key][status] += o.commission_7pct;
      }
      const monthly = Object.values(monthlyMap).sort((a, b) => b.month.localeCompare(a.month));

      res.json({ success: true, data: { summary, monthly } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Product Requests ──
  app.get('/api/athlete/:token/product-requests', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const { data, error } = await supabase
        .from('shipment_requests')
        .select('*')
        .eq('influencer_id', influencerId)
        .order('requested_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete/:token/product-requests', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const { reason, items, address } = req.body;
      if (!reason || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'reason and items (non-empty array) are required' });
      }

      const { data, error } = await supabase
        .from('shipment_requests')
        .insert([{
          influencer_id: influencerId,
          reason: reason.toUpperCase(),
          status: 'REQUESTED',
          items: items,
          address_snapshot: address || null,
          requested_by: String(influencerId)
        }])
        .select()
        .single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
