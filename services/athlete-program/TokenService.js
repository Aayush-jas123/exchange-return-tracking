// ============================================================================
// TokenService — Scoped tokens for athlete-facing routes
// ----------------------------------------------------------------------------
// Athletes reach the system through unguessable links, not accounts.
// One table (access_tokens), several scopes.
// Stores token_hash only — raw token returned once at creation.
// ============================================================================

const crypto = require('crypto');
const supabase = require('../../config/supabase');

// Token scope definitions (spec §09)
const SCOPE_CONFIG = {
  PROGRESS: {
    lifetime: 'permanent',  // null expires_at, rotatable, revoked on discharge
    singleUse: false,
    mayExpose: [
      'level', 'xp_total', 'standing_score', 'progress_to_next',
      'open_tasks', 'ladder', 'leaderboard_position'
    ],
    neverExpose: ['address', 'phone', 'email', 'bank', 'upi', 'kyc', 'order_history', 'rupee_amounts']
  },
  SUBMISSION: {
    lifetime: 'until_due_plus_14d',
    singleUse: false,
    mayExpose: ['assignment_brief', 'deadline', 'submission_form']
  },
  ADDRESS: {
    lifetime: '7_days',
    singleUse: true,
    mayExpose: ['address', 'size_picker']
  },
  ONBOARDING: {
    lifetime: '14_days',
    singleUse: true,
    mayExpose: ['profile', 'socials', 'terms', 'kyc_upload']
  }
};

const TokenService = {

  /**
   * Issue a new token. Stores hash only, returns raw token once.
   *
   * @param {'PROGRESS'|'SUBMISSION'|'ADDRESS'|'ONBOARDING'} scope
   * @param {number} influencerId
   * @param {number|null} subjectId — assignment_id for SUBMISSION, shipment_request_id for ADDRESS
   * @param {number|null} ttlSeconds — null = use scope default
   * @returns {Promise<string>} rawToken — the ONLY time this value is available
   */
  async issue(scope, influencerId, subjectId = null, ttlSeconds = null) {
    const config = SCOPE_CONFIG[scope];
    if (!config) throw new Error(`Unknown token scope: ${scope}`);

    // Generate raw token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Calculate expiry
    let expiresAt = null;
    if (scope === 'SUBMISSION' && ttlSeconds) {
      expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    } else if (scope === 'ADDRESS') {
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (scope === 'ONBOARDING') {
      expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    } else if (ttlSeconds) {
      expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    }

    const { data, error } = await supabase
      .from('access_tokens')
      .insert([{
        influencer_id: influencerId,
        scope,
        subject_id: subjectId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        single_use: config.singleUse,
        consumed_at: null,
        revoked_at: null
      }])
      .select()
      .single();

    if (error) throw error;

    console.log(`[TokenService] Issued ${scope} token for athlete ${influencerId} (id: ${data.id})`);

    // Return raw token — this is the ONLY time it's available
    return rawToken;
  },

  /**
   * Resolve a raw token to its scope and athlete.
   * Checks expiry, single-use, and revocation.
   *
   * @param {string} rawToken
   * @returns {Promise<{scope: string, influencerId: number, subjectId: number|null}|null>}
   */
  async resolve(rawToken) {
    if (!rawToken) return null;

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const hashTag = tokenHash.slice(0, 8) + '…';

    const { data: token, error } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error) {
      console.warn(`[athlete-auth] token lookup failed (${hashTag}):`, error.message);
      throw error;
    }
    if (!token) {
      console.warn(`[athlete-auth] token not found in access_tokens (${hashTag})`);
      return null;
    }

    // Check revocation
    if (token.revoked_at) {
      console.warn(`[athlete-auth] token revoked (${hashTag}, influencer=${token.influencer_id}, revoked_at=${token.revoked_at})`);
      return null;
    }

    // Check expiry
    if (token.expires_at && new Date(token.expires_at) < new Date()) {
      console.warn(`[athlete-auth] token expired (${hashTag}, influencer=${token.influencer_id}, expires_at=${token.expires_at})`);
      return null;
    }

    // Check single-use consumption
    if (token.single_use && token.consumed_at) {
      console.warn(`[athlete-auth] single-use token already consumed (${hashTag}, influencer=${token.influencer_id}, consumed_at=${token.consumed_at})`);
      return null;
    }

    // Mark as consumed if single-use
    if (token.single_use && !token.consumed_at) {
      await supabase
        .from('access_tokens')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', token.id);
    }

    return {
      scope: token.scope,
      influencerId: token.influencer_id,
      subjectId: token.subject_id,
      tokenId: token.id
    };
  },

  /**
   * Rotate a token — revoke old, issue new with same scope.
   *
   * @param {number} influencerId
   * @param {'PROGRESS'|'SUBMISSION'|'ADDRESS'|'ONBOARDING'} scope
   * @param {number|null} subjectId
   * @returns {Promise<string>} newRawToken
   */
  async rotate(influencerId, scope, subjectId = null) {
    // Revoke existing tokens of this scope
    await supabase
      .from('access_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('influencer_id', influencerId)
      .eq('scope', scope)
      .is('revoked_at', null);

    // Issue new token
    return this.issue(scope, influencerId, subjectId);
  },

  /**
   * Revoke ALL tokens for an athlete (called on discharge).
   *
   * @param {number} influencerId
   * @returns {Promise<number>} count of revoked tokens
   */
  async revokeAll(influencerId) {
    const { data, error } = await supabase
      .from('access_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('influencer_id', influencerId)
      .is('revoked_at', null)
      .select('id');

    if (error) throw error;

    const count = data?.length || 0;
    console.log(`[TokenService] Revoked ${count} tokens for athlete ${influencerId}`);
    return count;
  },

  /**
   * Get active tokens for an athlete.
   *
   * @param {number} influencerId
   * @returns {Promise<object[]>}
   */
  async listActive(influencerId) {
    const { data, error } = await supabase
      .from('access_tokens')
      .select('id, scope, subject_id, expires_at, single_use, consumed_at, created_at')
      .eq('influencer_id', influencerId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  /**
   * Get the field whitelist for a token scope.
   * Used by route handlers to filter response fields.
   *
   * @param {string} scope
   * @returns {string[]|null}
   */
  getFieldWhitelist(scope) {
    return SCOPE_CONFIG[scope]?.mayExpose || null;
  }
};

module.exports = TokenService;
