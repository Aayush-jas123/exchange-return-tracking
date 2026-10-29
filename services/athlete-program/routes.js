// ============================================================================
// Athlete Program — API Routes
// ----------------------------------------------------------------------------
// Mount these in server.js: require('./services/athlete-program/routes')(app)
// Admin routes under /api/athlete-admin/
// Athlete routes under /api/athlete/
// ============================================================================

const supabase = require('../../config/supabase');
const otpService = require('../../config/otp-service');
const {
  LedgerService, LevelEngine, TransitionService,
  TokenService, StandingService, AttributionService, PayoutService,
  GamificationService, CommissionService, DiscountCodeService
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

      // Enrich with level info — the level's commission rate is the rate the
      // athlete earns today, so the console can show it without a second call.
      const levelIds = [...new Set(data.map(a => a.level_id).filter(Boolean))];
      let levelsMap = {};
      if (levelIds.length > 0) {
        const { data: levels } = await supabase
          .from('comfort_levels')
          .select('id, display_name, ordinal, dial_segments_lit, commission_pct, perks')
          .in('id', levelIds);
        levels.forEach(l => levelsMap[l.id] = l);
      }
      const defaultRate = await CommissionService.getDefaultRate();

      const enriched = (data || []).map(a => ({
        ...a,
        level: levelsMap[a.level_id] || null,
        level_name: levelsMap[a.level_id]?.display_name || 'Unranked',
        level_ordinal: levelsMap[a.level_id]?.ordinal || 0,
        level_dial: levelsMap[a.level_id]?.dial_segments_lit || 0,
        level_commission_pct: CommissionService.pctOf(levelsMap[a.level_id]) ?? defaultRate
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

      // Normalize phone to 91XXXXXXXXXX format for consistent lookup
      const normalizedAppPhone = otpService.normalizeIndianPhone(app.phone) || app.phone;

      // Create influencer
      const { data: influencer, error: infErr } = await supabase
        .from('influencers')
        .insert([{
          name: app.payload?.name || app.email,
          phone: normalizedAppPhone,
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
          // Athlete portal is Shopify-hosted (the Render app has no /pages route).
          // Live page handle: "athlete-portal" (renamed from "athelete-portal" 24 Oct 2026;
          // the old spelling 301-redirects here).
          portal_url: process.env.ATHLETE_PORTAL_URL || 'https://offcomfrt.in/pages/athlete-portal',
          access_token: rawToken // Only returned once!
        } 
      });
    } catch (err) { 
      res.status(500).json({ error: err.message }); 
    }
  });

  // ── Open an athlete's portal from the admin console ──
  // Issues an EXTRA PROGRESS token instead of rotating, so the athlete's own
  // session keeps working while the admin looks in. The token rides in the URL
  // hash (#ap_token=…) which never reaches a server or Referer header.
  app.post('/api/athlete-admin/athletes/:id/portal-session', authAdmin, async (req, res) => {
    try {
      const athleteId = parseInt(req.params.id, 10);
      if (!athleteId) return res.status(400).json({ error: 'Invalid athlete id' });

      const { data: athlete, error } = await supabase
        .from('influencers')
        .select('id, name, phone, athlete_status')
        .eq('id', athleteId)
        .maybeSingle();
      if (error) throw error;
      if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

      // 7-day TTL: long enough for one admin session, short enough that a leaked
      // link does not stay live forever.
      const rawToken = await TokenService.issue('PROGRESS', athlete.id, null, 7 * 24 * 60 * 60);
      // Athlete portal is Shopify-hosted (the Render app has no /pages route).
      const portalUrl = process.env.ATHLETE_PORTAL_URL || 'https://offcomfrt.in/pages/athlete-portal';

      console.log(`[athlete-admin-portal] Opened portal for athlete ${athlete.id} (${athlete.name})`);

      res.json({
        success: true,
        data: {
          athlete: { id: athlete.id, name: athlete.name, status: athlete.athlete_status },
          portal_url: portalUrl,
          portal_link: `${portalUrl}#ap_token=${rawToken}`,
          access_token: rawToken // Only returned once
        }
      });
    } catch (err) {
      console.error('[athlete-admin-portal] error:', err.message);
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
      res.json({ success: true, data: (data || []).map(l => ({ ...l, commission_pct: CommissionService.pctOf(l) })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Level Commission Ladder ──
  // The commission % paid on every attributed order, one rate per comfort level.
  // Athletes see these rates in the portal Climb tab, so this is the source of truth.
  app.post('/api/athlete-admin/levels/commission', authAdmin, async (req, res) => {
    try {
      const updated = await CommissionService.setLevelRates(req.body.levels);
      res.json({ success: true, data: updated });
    } catch (err) { res.status(400).json({ error: err.message }); }
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
  // ATHLETE OTP LOGIN (mobile → OTP via Message Central → portal token)
  // ══════════════════════════════════════════════════════════════════════════

  // Step 1: Send OTP to athlete's mobile
  app.post('/api/athlete/otp/send', async (req, res) => {
    try {
      const { phone } = req.body;
      const normalized = otpService.normalizeIndianPhone(phone);
      if (!normalized) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
      }

      // Check if this phone belongs to a registered athlete (try normalized first, then raw 10-digit)
      let { data: athlete } = await supabase
        .from('influencers')
        .select('id, name, athlete_status')
        .eq('phone', normalized)
        .maybeSingle();

      if (!athlete) {
        const raw10 = normalized.substring(2);
        const { data: legacyAthlete } = await supabase
          .from('influencers')
          .select('id, name, athlete_status')
          .eq('phone', raw10)
          .maybeSingle();
        if (legacyAthlete) {
          // Fix legacy record and use it
          await supabase.from('influencers').update({ phone: normalized }).eq('id', legacyAthlete.id);
          athlete = legacyAthlete;
        }
      }

      if (!athlete) {
        return res.status(404).json({ error: 'No athlete account found with this number. Please apply first.' });
      }

      // Send OTP using existing Message Central config
      const result = await otpService.sendOtp(normalized);
      console.log(`[athlete-otp] OTP sent to athlete ${athlete.id} at +${normalized} via ${result.via}`);

      res.json({
        success: true,
        data: {
          via: result.via,
          expiresInSeconds: result.expiresInSeconds,
          resendInSeconds: result.resendInSeconds,
          devOtp: result.devOtp
        }
      });
    } catch (err) {
      if (err instanceof otpService.OtpError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[athlete-otp] send error:', err.message);
      res.status(500).json({ error: 'Could not send OTP. Please try again.' });
    }
  });

  // Step 2: Verify OTP and return portal token
  app.post('/api/athlete/otp/verify', async (req, res) => {
    try {
      const { phone, otp } = req.body;
      const normalized = otpService.normalizeIndianPhone(phone);
      if (!normalized || !otp) {
        return res.status(400).json({ error: 'Mobile number and OTP are required' });
      }

      // Verify OTP via Message Central
      await otpService.verifyOtp(normalized, otp);

      // Look up athlete (try normalized first, then raw 10-digit fallback)
      let { data: athlete, error: athErr } = await supabase
        .from('influencers')
        .select('id, name, athlete_status')
        .eq('phone', normalized)
        .maybeSingle();

      if (athErr) throw athErr;
      if (!athlete) {
        const raw10 = normalized.substring(2);
        const { data: legacyAthlete } = await supabase
          .from('influencers')
          .select('id, name, athlete_status')
          .eq('phone', raw10)
          .maybeSingle();
        if (legacyAthlete) {
          await supabase.from('influencers').update({ phone: normalized }).eq('id', legacyAthlete.id);
          athlete = legacyAthlete;
        }
      }

      if (!athlete) {
        return res.status(404).json({ error: 'No athlete account found with this number' });
      }

      // Get or create PROGRESS token
      const { data: existingTokens } = await supabase
        .from('access_tokens')
        .select('id')
        .eq('influencer_id', athlete.id)
        .eq('scope', 'PROGRESS')
        .is('revoked_at', null)
        .limit(1);

      let rawToken;
      if (existingTokens && existingTokens.length > 0) {
        rawToken = await TokenService.rotate(athlete.id, 'PROGRESS');
      } else {
        rawToken = await TokenService.issue('PROGRESS', athlete.id);
      }

      console.log(`[athlete-otp] Athlete ${athlete.id} (${athlete.name}) logged in via OTP`);

      res.json({
        success: true,
        data: {
          token: rawToken,
          athlete: { id: athlete.id, name: athlete.name, status: athlete.athlete_status }
        }
      });
    } catch (err) {
      if (err instanceof otpService.OtpError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[athlete-otp] verify error:', err.message);
      res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
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

      // Normalize phone to 91XXXXXXXXXX format for consistent lookup
      const normalizedPhone = otpService.normalizeIndianPhone(phone) || phone;

      const { data, error } = await supabase.from('applications').insert([{
        payload: { name, platform, followers, niche, city, why_join },
        email, phone: normalizedPhone, primary_handle: handle, auto_score: autoScore, status: 'APPLIED'
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

      // Try with avatar columns first, fall back to without if columns don't exist yet
      let athlete, error;
      const baseFields = 'id, name, athlete_no, athlete_status, xp_total, coin_balance, standing_score, level_id, level_since, joined_at, instagram_handle, phone, leaderboard_opt_out, shipping_address, shipping_city, shipping_state, shipping_pin, shipping_landmark, address_type';
      const avatarFields = ', avatar_base, avatar_head, avatar_mark, avatar_ground, avatar_frame';
      
      ({ data: athlete, error } = await supabase
        .from('influencers')
        .select(baseFields + avatarFields)
        .eq('id', influencerId)
        .single());
      
      // If avatar columns don't exist yet (migration not run), retry without them
      // Supabase returns error code 42703 (undefined_column) or message containing column name
      if (error && (error.code === '42703' || (error.message && error.message.includes('avatar_base')))) {
        console.log('[Avatar] GET /progress: Columns not found, falling back to base fields. Error:', error.code, error.message);
        ({ data: athlete, error } = await supabase
          .from('influencers')
          .select(baseFields)
          .eq('id', influencerId)
          .single());
      } else if (!error) {
        console.log('[Avatar] GET /progress: Avatar columns exist, returning:', athlete?.avatar_base, athlete?.avatar_head, athlete?.avatar_mark, athlete?.avatar_ground, athlete?.avatar_frame);
      }

      if (error) throw error;

      // Get level info
      let level = null, nextLevel = null;
      if (athlete.level_id) {
        const { data: lvl } = await supabase.from('comfort_levels').select('*').eq('id', athlete.level_id).single();
        level = lvl;
        const { data: next } = await supabase.from('comfort_levels').select('*').eq('ordinal', lvl.ordinal + 1).maybeSingle();
        nextLevel = next;
      }

      // Promotion is gated on more than XP (days at the current level, standing,
      // manual approval). The portal needs these to name the gate that is
      // actually holding, otherwise a time-gated level looks frozen.
      const levelSince = athlete.level_since || athlete.joined_at;
      const daysInLevel = levelSince ? Math.max(0, Math.floor((Date.now() - new Date(levelSince).getTime()) / 86400000)) : 0;

      // Get discount code. Resolved through DiscountCodeService so athletes
      // whose code only lives on the legacy influencers.referral_code columns
      // (added after the one-shot athlete-program migration) still get it.
      const dc = await DiscountCodeService.getForAthlete(influencerId);
      const discountCode = dc ? { code: dc.code, percent: dc.percent, is_active: dc.is_active } : null;

      // Count coupon orders this month (cancelled/refunded ones don't count)
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { count: monthOrders } = await supabase
        .from('attributed_orders')
        .select('*', { count: 'exact', head: true })
        .eq('influencer_id', influencerId)
        .eq('is_cancelled', false)
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
        shipping_address: athlete.shipping_address,
        shipping_city: athlete.shipping_city,
        shipping_state: athlete.shipping_state,
        shipping_pin: athlete.shipping_pin,
        shipping_landmark: athlete.shipping_landmark,
        address_type: athlete.address_type,
        avatar_base: athlete.avatar_base,
        avatar_head: athlete.avatar_head,
        avatar_mark: athlete.avatar_mark,
        avatar_ground: athlete.avatar_ground,
        avatar_frame: athlete.avatar_frame,
        level: level ? { display_name: level.display_name, ordinal: level.ordinal, display_number: level.display_number, dial_segments_lit: level.dial_segments_lit, min_xp: level.min_xp, commission_pct: CommissionService.pctOf(level) } : null,
        next_level: nextLevel ? {
          code: nextLevel.code,
          display_name: nextLevel.display_name,
          min_xp: nextLevel.min_xp,
          min_standing: nextLevel.min_standing,
          min_days_in_previous: nextLevel.min_days_in_previous,
          requires_manual_approval: !!nextLevel.requires_manual_approval,
          commission_pct: CommissionService.pctOf(nextLevel),
          days_in_level: daysInLevel
        } : null,
        days_in_level: daysInLevel,
        commission_rate: CommissionService.pctOf(level) ?? await CommissionService.getDefaultRate(),
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

      // An open portal/game socket on the RaceHub counts as live right now.
      const hub = require('./RaceHub').getHub();
      const enriched = (data || []).map(a => ({
        ...a,
        level_name: levelsMap[a.level_id]?.display_name || '—',
        last_seen: (hub && hub.isOnline(a.id)) ? Date.now() : (portalPresence.get(a.id) || null)
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

  // ── Game Unlocks (Admin) ──
  app.get('/api/athlete-admin/game-unlocks', authAdmin, async (req, res) => {
    try {
      const unlocks = await GamificationService.getGameUnlocks();
      res.json({ success: true, data: unlocks });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/game-unlocks/:gameId', authAdmin, async (req, res) => {
    try {
      const { gameId } = req.params;
      const { unlocked } = req.body;
      if (typeof unlocked !== 'boolean') return res.status(400).json({ error: 'unlocked boolean required' });
      const result = await GamificationService.updateGameUnlock(gameId, unlocked, req.adminToken);
      res.json({ success: true, data: result });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Coin Shop / Drops (Admin) ──
  // The shop opens only when 'shop.unlocked' is true; until then the portal
  // keeps its "Coming soon" veil. Products are priced in coins, never rupees.
  app.get('/api/athlete-admin/shop/settings', authAdmin, async (req, res) => {
    try {
      res.json({ success: true, data: { unlocked: await GamificationService.isShopUnlocked() } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/shop/settings', authAdmin, async (req, res) => {
    try {
      const { unlocked } = req.body;
      if (typeof unlocked !== 'boolean') return res.status(400).json({ error: 'unlocked boolean required' });
      res.json({ success: true, data: await GamificationService.setShopUnlocked(unlocked, req.adminToken) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.get('/api/athlete-admin/shop/products', authAdmin, async (req, res) => {
    try {
      res.json({ success: true, data: await GamificationService.getShopProducts() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/shop/products', authAdmin, async (req, res) => {
    try {
      res.json({ success: true, data: await GamificationService.createShopProduct(req.body || {}) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.patch('/api/athlete-admin/shop/products/:id', authAdmin, async (req, res) => {
    try {
      res.json({ success: true, data: await GamificationService.updateShopProduct(req.params.id, req.body || {}) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.delete('/api/athlete-admin/shop/products/:id', authAdmin, async (req, res) => {
    try {
      res.json({ success: true, data: await GamificationService.deleteShopProduct(req.params.id) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // Drop image upload — multipart goes straight to Cloudinary so the admin page
  // can attach a product photo without a separate media pipeline.
  const shopImageUpload = (() => {
    try {
      const multer = require('multer');
      return multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 8 * 1024 * 1024, files: 1 }
      }).single('image');
    } catch (err) {
      console.error('[shop] image upload unavailable:', err.message);
      return null;
    }
  })();

  app.post('/api/athlete-admin/shop/upload-image',
    (req, res, next) => {
      if (!shopImageUpload) return res.status(503).json({ error: 'Uploads are not configured on this server' });
      shopImageUpload(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
        next();
      });
    },
    authAdmin,
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'image file is required' });
        if (!/^image\//.test(req.file.mimetype || '')) return res.status(400).json({ error: 'Only image files are allowed' });

        const pkg = require('cloudinary');
        const cloudinary = pkg.v2 || pkg;
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET
        });

        const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        const uploaded = await cloudinary.uploader.upload(dataUri, {
          folder: 'shop',
          resource_type: 'image',
          allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
        });

        res.json({ success: true, url: uploaded.secure_url });
      } catch (err) {
        console.error('[shop] image upload failed:', err.message);
        res.status(500).json({ error: err.message || 'Upload failed' });
      }
    }
  );

  app.get('/api/athlete-admin/shop/redemptions', authAdmin, async (req, res) => {
    try {
      const { status, athlete_id, limit } = req.query;
      res.json({
        success: true,
        data: await GamificationService.getAllShopRedemptions({
          status,
          athleteId: athlete_id,
          limit: limit ? parseInt(limit, 10) : 200
        })
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/shop/redemptions/:id/approve', authAdmin, async (req, res) => {
    try {
      const { notes } = req.body || {};
      res.json({ success: true, data: await GamificationService.approveShopRedemption(req.params.id, { notes, actor: 'admin' }) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/athlete-admin/shop/redemptions/:id/reject', authAdmin, async (req, res) => {
    try {
      const { reason } = req.body || {};
      res.json({ success: true, data: await GamificationService.rejectShopRedemption(req.params.id, { reason, actor: 'admin' }) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
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

  // ── Arcade: XP for a finished mini-game run ──
  app.post('/api/athlete/:token/games/xp', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      const { game, score, run_id } = req.body || {};
      const result = await GamificationService.awardGameXp(influencerId, game, score, run_id);
      if (result.awarded > 0) {
        try { await LevelEngine.evaluate(influencerId); } catch (e) { console.error('[Arcade] Level evaluation failed:', e.message); }
      }
      res.json({ success: true, data: result });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Game unlock status (which games are available to play) ──
  app.get('/api/athlete/:token/games/unlocks', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      const unlocks = await GamificationService.getGameUnlocks();
      res.json({ success: true, data: unlocks });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Arcade leaderboard: athletes ranked by game XP, not overall comfort XP ──
  app.get('/api/athlete/:token/arcade', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      res.json({ success: true, data: await GamificationService.getArcadeLeaderboard(influencerId, {
        period: req.query.period,
        limit: req.query.limit
      }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Coin Shop (balance, coin sources, open drops, this athlete's requests) ──
  app.get('/api/athlete/:token/shop', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });
      res.json({ success: true, data: await GamificationService.getCoinSummary(influencerId) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Coin Shop: request a drop. Coins are held immediately and refunded if
  // the admin rejects the request, so a balance can never be spent twice. ──
  app.post('/api/athlete/:token/shop/redeem', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const { product_id, size, note } = req.body || {};
      if (!product_id) return res.status(400).json({ error: 'product_id is required' });

      res.json({ success: true, data: await GamificationService.redeemShopProduct(influencerId, product_id, { size, note }) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
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
      res.json({ success: true, data: await GamificationService.getActivityLog(influencerId, { limit: req.query.limit }) });
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

      // Commission is a property of the athlete's comfort level: the same rate
      // applies to every order, and the next/top rungs are returned so the Log
      // panel can say what the next promotion is worth.
      const rates = await CommissionService.getForAthlete(influencerId);
      const COMMISSION_RATE = rates.rate;

      const { data: orders, error } = await supabase
        .from('attributed_orders')
        .select('commission_amount, commission_status, placed_at, net_value, code_used, customer_name, shopify_order_id, is_cancelled, refunded_amount')
        .eq('influencer_id', influencerId)
        .order('placed_at', { ascending: false });
      if (error) throw error;

      // Calculate commission at the athlete's level rate on each order's net_value
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
        commission_rate: COMMISSION_RATE,
        level_name: rates.level_name,
        next_rate: rates.next_rate,
        next_level_name: rates.next_level_name,
        next_change_rate: rates.next_change_rate,
        next_change_level_name: rates.next_change_level_name,
        top_rate: rates.top_rate,
        top_level_name: rates.top_level_name
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

  // ─ Update athlete profile ──
  app.patch('/api/athlete/:token/profile', authAthlete, async (req, res) => {
    try {
      const { influencerId, scope } = req.athleteScope;
      if (scope !== 'PROGRESS') return res.status(403).json({ error: 'Wrong scope' });

      const ALLOWED = ['name','instagram_handle','phone','shipping_address','shipping_city','shipping_state','shipping_pin','shipping_landmark','address_type','avatar_base','avatar_head','avatar_mark','avatar_ground','avatar_frame'];
      const patch = {};
      for (const k of ALLOWED) {
        if (req.body[k] !== undefined) patch[k] = req.body[k];
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No valid fields' });

      // Validate avatar slots against athlete's level ordinal
      const AVATAR_SLOTS = {
        avatar_base: 1,    // Unlocks at ordinal 1 (Comfort Level - 5)
        avatar_head: 2,    // Unlocks at ordinal 2 (Comfort Level - 4)
        avatar_mark: 3,    // Unlocks at ordinal 3 (Comfort Level - 3)
        avatar_ground: 4,  // Unlocks at ordinal 4 (Comfort Level - 2)
        avatar_frame: 5    // Unlocks at ordinal 5 (Comfort Level - 1)
      };
      const AVATAR_OPTIONS = {
        avatar_base: ['stand', 'walk', 'reach', 'bow', 'sit'],
        avatar_head: ['none', 'cap', 'hood', 'band', 'mask'],
        avatar_mark: ['none', 'rain', 'breath', 'voice', 'eyes'],
        avatar_ground: ['none', 'line', 'mat', 'blocks', 'water'],
        avatar_frame: ['plain', 'ring', 'invert', 'cut', 'halo']
      };
      const AVATAR_NEUTRAL = {
        avatar_head: 'none',
        avatar_mark: 'none',
        avatar_ground: 'none',
        avatar_frame: 'plain'
      };
      
      // Get athlete's current level ordinal
      const { data: athlete, error: athleteErr } = await supabase
        .from('influencers')
        .select('level_id')
        .eq('id', influencerId)
        .single();
      if (athleteErr) throw athleteErr;
      
      let athleteOrdinal = 1; // Default to lowest level
      if (athlete.level_id) {
        const { data: level } = await supabase
          .from('comfort_levels')
          .select('ordinal')
          .eq('id', athlete.level_id)
          .single();
        if (level) athleteOrdinal = level.ordinal;
      }
      
      // Validate each avatar field being updated
      for (const [field, value] of Object.entries(patch)) {
        if (!field.startsWith('avatar_')) continue;
        const requiredOrdinal = AVATAR_SLOTS[field];
        if (!requiredOrdinal) continue;
        
        // Check if value is valid for this slot
        if (!AVATAR_OPTIONS[field].includes(value)) {
          return res.status(400).json({ error: `Invalid value '${value}' for ${field}` });
        }
        
        // Ordinals ascend with rank (1 = Comfort Level - 5 … 6 = Zero Comfort), so a slot
        // unlocks once the athlete's ordinal reaches its unlock level. The neutral value is
        // always accepted: the portal sends all five fields on every save and fills locked
        // slots with their empty piece, which is what a locked slot renders as anyway.
        const neutral = AVATAR_NEUTRAL[field];
        if (athleteOrdinal < requiredOrdinal && value !== neutral) {
          return res.status(403).json({ error: `Avatar slot ${field} requires Comfort Level ${requiredOrdinal} or higher` });
        }
        
        // Special case: halo is only for Zero Comfort (ordinal 6)
        if (field === 'avatar_frame' && value === 'halo' && athleteOrdinal !== 6) {
          return res.status(403).json({ error: 'Halo frame requires Zero Comfort level' });
        }
      }
      
      console.log('[Avatar] PATCH /profile: Saving avatar fields:', { base: patch.avatar_base, head: patch.avatar_head, mark: patch.avatar_mark, ground: patch.avatar_ground, frame: patch.avatar_frame });
      const baseReturnFields = 'id,name,instagram_handle,phone,shipping_address,shipping_city,shipping_state,shipping_pin,shipping_landmark,address_type';
      const avatarReturnFields = ',avatar_base,avatar_head,avatar_mark,avatar_ground,avatar_frame';
      
      let { data, error } = await supabase
        .from('influencers')
        .update(patch)
        .eq('id', influencerId)
        .select(baseReturnFields + avatarReturnFields)
        .single();
      
      // If avatar columns don't exist yet (migration not run), retry without them
      // Supabase returns error code 42703 (undefined_column) or message containing column name
      if (error && (error.code === '42703' || (error.message && error.message.includes('avatar_base')))) {
        console.log('[Avatar] Columns not found, retrying without avatar fields');
        // Remove avatar fields from patch if migration not run
        const basePatch = { ...patch };
        delete basePatch.avatar_base;
        delete basePatch.avatar_head;
        delete basePatch.avatar_mark;
        delete basePatch.avatar_ground;
        delete basePatch.avatar_frame;
        
        if (Object.keys(basePatch).length === 0) {
          return res.status(400).json({ error: 'Avatar builder not yet available — database migration pending' });
        }
        
        ({ data, error } = await supabase
          .from('influencers')
          .update(basePatch)
          .eq('id', influencerId)
          .select(baseReturnFields)
          .single());
      }
      
      if (error) {
        console.error('[Avatar] Save failed:', error.code, error.message);
        throw error;
      }
      console.log('[Avatar] Saved successfully for athlete', influencerId, 'Returning:', data?.avatar_base, data?.avatar_head, data?.avatar_mark, data?.avatar_ground, data?.avatar_frame);
      res.json({ success: true, data });
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

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — PRODUCT REQUEST MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  // ── List All Product Requests ──
  app.get('/api/athlete-admin/product-requests', authAdmin, async (req, res) => {
    try {
      const { status, athlete_id } = req.query;
      let query = supabase
        .from('shipment_requests')
        .select('*, influencers(name, athlete_no, instagram_handle)')
        .order('requested_at', { ascending: false })
        .limit(200);

      if (status) query = query.eq('status', status.toUpperCase());
      if (athlete_id) query = query.eq('influencer_id', athlete_id);

      const { data, error } = await query;
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Approve Product Request ──
  app.post('/api/athlete-admin/product-requests/:id/approve', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { notes, shipping_method } = req.body;

      const { data: request, error: fetchError } = await supabase
        .from('shipment_requests')
        .select('*')
        .eq('id', id)
        .single();
      if (fetchError || !request) throw new Error('Request not found');

      const { data, error } = await supabase
        .from('shipment_requests')
        .update({
          status: 'APPROVED',
          approved_at: new Date().toISOString(),
          approved_by: 'admin',
          admin_notes: notes || null,
          shipping_method: shipping_method || null
        })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Reject Product Request ──
  app.post('/api/athlete-admin/product-requests/:id/reject', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const { data, error } = await supabase
        .from('shipment_requests')
        .update({
          status: 'REJECTED',
          rejected_at: new Date().toISOString(),
          rejected_by: 'admin',
          rejection_reason: reason || null
        })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — GAME RESULTS & LEADERBOARDS
  // ══════════════════════════════════════════════════════════════════════════

  // ── Global Leaderboard ──
  app.get('/api/athlete-admin/leaderboard', authAdmin, async (req, res) => {
    try {
      const { limit = 100 } = req.query;
      const { data, error } = await supabase
        .from('influencers')
        .select('id, name, athlete_no, xp_total, coin_balance, level_id, standing_score, leaderboard_opt_out')
        .eq('leaderboard_opt_out', false)
        .order('xp_total', { ascending: false })
        .limit(parseInt(limit));
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Game XP/Coins Ledger ──
  app.get('/api/athlete-admin/game-ledger', authAdmin, async (req, res) => {
    try {
      const { athlete_id, reason_code, limit = 200 } = req.query;
      let query = supabase
        .from('ledger_entries')
        .select('*, influencers(name, athlete_no)')
        .in('reason_code', ['GAME_XP', 'GAME_COINS', 'RACE_XP'])
        .order('created_at', { ascending: false })
        .limit(parseInt(limit));

      if (athlete_id) query = query.eq('influencer_id', athlete_id);
      if (reason_code) query = query.eq('reason_code', reason_code);

      const { data, error } = await query;
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Weekly Challenge Entries with Scores ──
  app.get('/api/athlete-admin/weekly-challenges/:id/entries', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('weekly_challenge_entries')
        .select('*, influencers(name, athlete_no, instagram_handle)')
        .eq('challenge_id', id)
        .order('score', { ascending: false });
      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — OVERRIDE CONTROLS
  // ══════════════════════════════════════════════════════════════════════════

  // ── Override Athlete XP ──
  app.post('/api/athlete-admin/athletes/:id/override-xp', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { xp_total, reason } = req.body;
      if (xp_total === undefined || xp_total === null || xp_total === '') {
        const err = new Error('xp_total is required');
        err.status = 400;
        throw err;
      }

      // LedgerService writes the delta as a ledger row, then sets the cached total
      const result = await LedgerService.setBalance(id, 'XP', xp_total, reason || 'Admin override', 'admin');

      // XP written by hand can cross one or more thresholds at once; the nightly
      // engine would otherwise be the only thing that notices, so evaluate here.
      let levelChange = null;
      try {
        levelChange = await LevelEngine.evaluate(id);
      } catch (evalErr) {
        console.error(`[AthleteAdmin] Level evaluation after XP override failed for ${id}:`, evalErr.message);
      }

      const { data, error } = await supabase
        .from('influencers')
        .select()
        .eq('id', id)
        .single();
      if (error) throw error;

      res.json({ success: true, data, delta: result.delta, level: levelChange });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Override Athlete Coins ──
  app.post('/api/athlete-admin/athletes/:id/override-coins', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { coin_balance, reason } = req.body;
      if (coin_balance === undefined || coin_balance === null || coin_balance === '') {
        const err = new Error('coin_balance is required');
        err.status = 400;
        throw err;
      }

      const result = await LedgerService.setBalance(id, 'COIN', coin_balance, reason || 'Admin override', 'admin');

      const { data, error } = await supabase
        .from('influencers')
        .select()
        .eq('id', id)
        .single();
      if (error) throw error;

      res.json({ success: true, data, delta: result.delta });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // ── Override Athlete Status ──
  app.post('/api/athlete-admin/athletes/:id/override-status', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { athlete_status, reason } = req.body;
      if (!athlete_status) throw new Error('athlete_status is required');

      const { data, error } = await supabase
        .from('influencers')
        .update({ athlete_status: athlete_status.toUpperCase() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;

      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Reset Athlete Streak ──
  app.post('/api/athlete-admin/athletes/:id/reset-streak', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('athlete_streaks')
        .update({ current_streak: 0, last_active_date: null })
        .eq('influencer_id', id)
        .select()
        .single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Manual Badge Award ──
  app.post('/api/athlete-admin/athletes/:id/award-badge', authAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { badge_code, reason } = req.body;
      if (!badge_code) throw new Error('badge_code is required');

      const result = await GamificationService.awardBadge(id, badge_code, reason || 'Admin manual award');
      res.json({ success: true, data: result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — CONFIGURATION MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  // ── Get All Configuration ──
  app.get('/api/athlete-admin/config/all', authAdmin, async (req, res) => {
    try {
      const [settings, gameSettings, levels, badges] = await Promise.all([
        supabase.from('program_settings').select('*').order('key'),
        GamificationService.getGameSettings(),
        supabase.from('comfort_levels').select('*').order('sort_order', { ascending: true }),
        supabase.from('badge_definitions').select('*').order('category', { ascending: true })
      ]);

      res.json({
        success: true,
        data: {
          program_settings: settings.data || [],
          game_settings: gameSettings,
          levels: (levels.data || []).map(l => ({ ...l, commission_pct: CommissionService.pctOf(l) })),
          badges: badges.data || []
        }
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Update Multiple Settings ──
  app.post('/api/athlete-admin/config/bulk-update', authAdmin, async (req, res) => {
    try {
      const { settings } = req.body;
      if (!settings || !Array.isArray(settings)) throw new Error('settings array is required');

      const results = [];
      for (const { key, value } of settings) {
        const { data, error } = await supabase
          .from('program_settings')
          .update({ value: String(value), updated_at: new Date().toISOString() })
          .eq('key', key)
          .select()
          .single();
        if (error) {
          results.push({ key, success: false, error: error.message });
        } else {
          results.push({ key, success: true, data });
        }
      }

      res.json({ success: true, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Reset Gamification Settings to Defaults ──
  app.post('/api/athlete-admin/config/reset-gamification', authAdmin, async (req, res) => {
    try {
      const defaults = {
        'daily_task.max_picks': '5',
        'weekly_challenge.xp_reward_1st': '500',
        'weekly_challenge.xp_reward_2nd': '300',
        'weekly_challenge.xp_reward_3rd': '200',
        'weekly_challenge.coin_reward_1st': '100',
        'weekly_challenge.coin_reward_2nd': '60',
        'weekly_challenge.coin_reward_3rd': '40',
        'weekly_challenge.max_winners': '10',
        'streak.bonus_xp_per_day': '10',
        'streak.milestone_7_day': '50',
        'streak.milestone_30_day': '200',
        'streak.milestone_100_day': '1000',
        'streak.milestone_365_day': '5000',
        'game.daily_xp_cap': '500',
        'game.daily_coin_cap': '100',
        'game.xp_per_run_max': '100',
        'game.coins_per_run_max': '20',
        'gamification.confetti_enabled': 'true',
        'gamification.sound_enabled': 'true'
      };

      const results = [];
      for (const [key, value] of Object.entries(defaults)) {
        const { data, error } = await supabase
          .from('program_settings')
          .update({ value, updated_at: new Date().toISOString() })
          .eq('key', key)
          .select()
          .single();
        results.push({ key, success: !error, data: data || null });
      }

      res.json({ success: true, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
