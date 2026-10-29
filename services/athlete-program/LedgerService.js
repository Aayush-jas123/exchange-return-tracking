// ============================================================================
// LedgerService — The ONLY mechanism by which XP or coins change
// ----------------------------------------------------------------------------
// Rules (spec §06):
//   1. XP and coins change ONLY by inserting a ledger row
//   2. Cached totals on influencer are written in the same transaction
//   3. The ledger is append-only — corrections are new rows with reverses_entry_id
//   4. Nothing is edited or deleted, including by admin
// ============================================================================

const supabase = require('../../config/supabase');

const LedgerService = {

  /**
   * Award XP or coins to an athlete.
   * Inserts a ledger row and updates the cached balance atomically.
   * Idempotent on idempotencyKey — returns existing entry if key already used.
   *
   * @param {number} influencerId
   * @param {'XP'|'COIN'} currency
   * @param {number} amount — positive integer
   * @param {'ASSIGNMENT'|'ORDER'|'REFERRAL'|'MANUAL'|'REVERSAL'|'EXPIRY'|'REDEMPTION'} sourceType
   * @param {number|null} sourceId — assignment_id, order_id, etc.
   * @param {string} idempotencyKey — unique key (e.g. "assignment:123:approved")
   * @param {string} reasonCode — human-readable reason
   * @param {string|null} actorId — null = system, admin email for manual
   * @returns {Promise<{entry: object, isNew: boolean}>}
   */
  async award(influencerId, currency, amount, sourceType, sourceId, idempotencyKey, reasonCode = 'AWARD', actorId = null) {
    if (!['XP', 'COIN'].includes(currency)) throw new Error(`Invalid currency: ${currency}`);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be a positive integer');

    // Check idempotency — if key exists, return existing entry (no-op)
    const { data: existing, error: lookupErr } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (existing) return { entry: existing, isNew: false };

    // Get current balance
    const { data: influencer, error: infErr } = await supabase
      .from('influencers')
      .select('id, xp_total, coin_balance')
      .eq('id', influencerId)
      .single();

    if (infErr) throw infErr;
    if (!influencer) throw new Error(`Influencer ${influencerId} not found`);

    const currentBalance = currency === 'XP' ? influencer.xp_total : influencer.coin_balance;
    const balanceAfter = currentBalance + amount;

    // Insert ledger entry + update cached balance in sequence
    // Note: Supabase JS doesn't support transactions, so we do sequential ops
    const { data: entry, error: insertErr } = await supabase
      .from('ledger_entries')
      .insert([{
        influencer_id: influencerId,
        currency,
        amount,
        balance_after: balanceAfter,
        source_type: sourceType,
        source_id: sourceId,
        reason_code: reasonCode,
        actor_id: actorId,
        idempotency_key: idempotencyKey
      }])
      .select()
      .single();

    if (insertErr) {
      // Handle race condition on idempotency key
      if (insertErr.code === '23505') {
        const { data: race } = await supabase
          .from('ledger_entries')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .single();
        return { entry: race, isNew: false };
      }
      throw insertErr;
    }

    // Update cached balance on influencer
    const balanceCol = currency === 'XP' ? 'xp_total' : 'coin_balance';
    const { error: updateErr } = await supabase
      .from('influencers')
      .update({ [balanceCol]: balanceAfter })
      .eq('id', influencerId);

    if (updateErr) {
      console.error(`[LedgerService] Failed to update cached ${currency} balance for influencer ${influencerId}:`, updateErr);
      // Don't throw — the ledger entry is the source of truth, balance can be replayed
    }

    return { entry, isNew: true };
  },

  /**
   * Debit XP or coins from an athlete — the mirror image of award().
   * Inserts a NEGATIVE ledger row and lowers the cached balance in the same
   * sequence, so a spend is still just an append: nothing is edited.
   * Reject the spend with err.code = 'INSUFFICIENT_BALANCE' when the athlete
   * cannot cover it, and refund it later with reverse(entry.id).
   *
   * @param {number} influencerId
   * @param {'XP'|'COIN'} currency
   * @param {number} amount — positive integer; written as a negative entry
   * @param {'ASSIGNMENT'|'ORDER'|'REFERRAL'|'MANUAL'|'REVERSAL'|'EXPIRY'|'REDEMPTION'} sourceType
   * @param {number|null} sourceId — redemption_id, etc.
   * @param {string} idempotencyKey — unique key (e.g. "shop:42")
   * @param {string} reasonCode — e.g. SHOP_REDEMPTION
   * @param {string|null} actorId — null = system, admin email for manual debits
   * @returns {Promise<{entry: object, isNew: boolean, balance: number}>}
   */
  async spend(influencerId, currency, amount, sourceType, sourceId, idempotencyKey, reasonCode = 'REDEMPTION', actorId = null) {
    if (!['XP', 'COIN'].includes(currency)) throw new Error(`Invalid currency: ${currency}`);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be a positive integer');

    // Check idempotency — if key exists, the spend already happened (no-op)
    const { data: existing, error: lookupErr } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (existing) return { entry: existing, isNew: false, balance: existing.balance_after };

    const { data: influencer, error: infErr } = await supabase
      .from('influencers')
      .select('id, xp_total, coin_balance')
      .eq('id', influencerId)
      .single();

    if (infErr) throw infErr;
    if (!influencer) throw new Error(`Influencer ${influencerId} not found`);

    const balanceCol = currency === 'XP' ? 'xp_total' : 'coin_balance';
    const currentBalance = Number(influencer[balanceCol] || 0);
    if (currentBalance < amount) {
      const err = new Error(`Insufficient ${currency === 'COIN' ? 'coins' : 'XP'}: ${currentBalance} available, ${amount} needed`);
      err.code = 'INSUFFICIENT_BALANCE';
      err.status = 400;
      throw err;
    }

    const balanceAfter = currentBalance - amount;

    const { data: entry, error: insertErr } = await supabase
      .from('ledger_entries')
      .insert([{
        influencer_id: influencerId,
        currency,
        amount: -amount,
        balance_after: balanceAfter,
        source_type: sourceType,
        source_id: sourceId,
        reason_code: reasonCode,
        actor_id: actorId,
        idempotency_key: idempotencyKey
      }])
      .select()
      .single();

    if (insertErr) {
      // Handle race condition on idempotency key
      if (insertErr.code === '23505') {
        const { data: race } = await supabase
          .from('ledger_entries')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .single();
        return { entry: race, isNew: false, balance: race?.balance_after ?? balanceAfter };
      }
      throw insertErr;
    }

    const { error: updateErr } = await supabase
      .from('influencers')
      .update({ [balanceCol]: balanceAfter })
      .eq('id', influencerId);

    if (updateErr) {
      console.error(`[LedgerService] Failed to update cached ${currency} balance for influencer ${influencerId}:`, updateErr);
    }

    return { entry, isNew: true, balance: balanceAfter };
  },

  /**
   * Admin override — force the balance to an absolute value.
   * Rule 1 still applies: the balance only moves by appending a ledger row, so
   * the DIFFERENCE between the current and the requested balance is written as
   * one signed entry (MANUAL / ADMIN_ADJUSTMENT) before the cached total is set.
   * A no-op override returns the existing balance without writing anything.
   *
   * @param {number} influencerId
   * @param {'XP'|'COIN'} currency
   * @param {number} targetBalance — requested absolute balance, >= 0
   * @param {string} [reason] — free-text audit note stored in ledger_entries.notes
   * @param {string|null} [actorId] — admin label, never a credential
   * @returns {Promise<{entry: object|null, isNew: boolean, balance: number, delta: number}>}
   */
  async setBalance(influencerId, currency, targetBalance, reason = 'Admin override', actorId = null) {
    if (!['XP', 'COIN'].includes(currency)) throw new Error(`Invalid currency: ${currency}`);

    const target = Number(targetBalance);
    if (!Number.isInteger(target) || target < 0) {
      const err = new Error(`${currency} balance must be a non-negative integer`);
      err.status = 400;
      throw err;
    }

    const balanceCol = currency === 'XP' ? 'xp_total' : 'coin_balance';
    const { data: influencer, error: infErr } = await supabase
      .from('influencers')
      .select(`id, ${balanceCol}`)
      .eq('id', influencerId)
      .single();

    if (infErr) {
      // PostgREST reports a missing row as PGRST116 — surface it as a 404
      if (infErr.code === 'PGRST116') {
        const err = new Error(`Influencer ${influencerId} not found`);
        err.status = 404;
        throw err;
      }
      throw infErr;
    }

    const before = Number(influencer[balanceCol] || 0);
    const delta = target - before;
    if (delta === 0) return { entry: null, isNew: false, balance: before, delta: 0 };

    const row = {
      influencer_id: influencerId,
      currency,
      amount: delta,
      balance_after: target,
      source_type: 'MANUAL',
      source_id: null,
      reason_code: 'ADMIN_ADJUSTMENT',
      actor_id: actorId,
      idempotency_key: `admin-override:${currency}:${influencerId}:${Date.now()}`
    };

    let { data: entry, error: insertErr } = await supabase
      .from('ledger_entries')
      .insert([{ ...row, notes: reason }])
      .select()
      .single();

    // `notes` ships with supabase_migration_ledger_notes.sql. Until that has run,
    // retry without it rather than failing the override outright.
    const missingNotes = insertErr && (
      insertErr.code === '42703' ||
      (/notes/i.test(insertErr.message || '') && /column/i.test(insertErr.message || ''))
    );
    if (missingNotes) {
      ({ data: entry, error: insertErr } = await supabase
        .from('ledger_entries')
        .insert([row])
        .select()
        .single());
    }

    if (insertErr) throw insertErr;

    const { error: updateErr } = await supabase
      .from('influencers')
      .update({ [balanceCol]: target })
      .eq('id', influencerId);

    if (updateErr) {
      console.error(`[LedgerService] Failed to set cached ${currency} balance for influencer ${influencerId}:`, updateErr);
    }

    return { entry, isNew: true, balance: target, delta };
  },

  /**
   * Reverse a previous ledger entry.
   * Creates a new entry with negated amount and reverses_entry_id set.
   *
   * @param {number} entryId — the ledger entry to reverse
   * @param {string} reasonCode
   * @param {string|null} actorId
   * @returns {Promise<object>} the new reversing entry
   */
  async reverse(entryId, reasonCode = 'REVERSAL', actorId = null) {
    // Fetch original entry
    const { data: original, error } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('id', entryId)
      .single();

    if (error) throw error;
    if (!original) throw new Error(`Ledger entry ${entryId} not found`);

    // Check if already reversed
    const { data: existingReverse } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('reverses_entry_id', entryId)
      .maybeSingle();

    if (existingReverse) return existingReverse;

    const reversalAmount = -original.amount;
    const idempotencyKey = `reversal:${entryId}:${Date.now()}`;

    // Get current balance
    const { data: influencer } = await supabase
      .from('influencers')
      .select('xp_total, coin_balance')
      .eq('id', original.influencer_id)
      .single();

    const currentBalance = original.currency === 'XP' ? influencer.xp_total : influencer.coin_balance;
    const balanceAfter = currentBalance + reversalAmount;

    // Insert reversal entry
    const { data: entry, error: insertErr } = await supabase
      .from('ledger_entries')
      .insert([{
        influencer_id: original.influencer_id,
        currency: original.currency,
        amount: reversalAmount,
        balance_after: balanceAfter,
        source_type: 'REVERSAL',
        source_id: original.source_id,
        reason_code: reasonCode,
        actor_id: actorId,
        reverses_entry_id: entryId,
        idempotency_key: idempotencyKey
      }])
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Update cached balance
    const balanceCol = original.currency === 'XP' ? 'xp_total' : 'coin_balance';
    await supabase
      .from('influencers')
      .update({ [balanceCol]: balanceAfter })
      .eq('id', original.influencer_id);

    return entry;
  },

  /**
   * Get current balance for an athlete.
   *
   * @param {number} influencerId
   * @param {'XP'|'COIN'} currency
   * @returns {Promise<number>}
   */
  async balance(influencerId, currency = 'XP') {
    const col = currency === 'XP' ? 'xp_total' : 'coin_balance';
    const { data, error } = await supabase
      .from('influencers')
      .select(col)
      .eq('id', influencerId)
      .single();

    if (error) throw error;
    return data[col];
  },

  /**
   * Replay all ledger entries for an athlete and verify against cached balance.
   * Used for reconciliation and testing.
   *
   * @param {number} influencerId
   * @returns {Promise<{xp: {ledger: number, cached: number, match: boolean}, coin: {ledger: number, cached: number, match: boolean}}>}
   */
  async replay(influencerId) {
    const { data: entries, error } = await supabase
      .from('ledger_entries')
      .select('currency, amount')
      .eq('influencer_id', influencerId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    const { data: influencer } = await supabase
      .from('influencers')
      .select('xp_total, coin_balance')
      .eq('id', influencerId)
      .single();

    const xpLedger = entries
      .filter(e => e.currency === 'XP')
      .reduce((sum, e) => sum + e.amount, 0);

    const coinLedger = entries
      .filter(e => e.currency === 'COIN')
      .reduce((sum, e) => sum + e.amount, 0);

    return {
      xp: { ledger: xpLedger, cached: influencer.xp_total, match: xpLedger === influencer.xp_total },
      coin: { ledger: coinLedger, cached: influencer.coin_balance, match: coinLedger === influencer.coin_balance }
    };
  },

  /**
   * Get ledger history for an athlete.
   *
   * @param {number} influencerId
   * @param {object} opts — { currency, limit, offset }
   * @returns {Promise<object[]>}
   */
  async history(influencerId, { currency, limit = 50, offset = 0 } = {}) {
    let query = supabase
      .from('ledger_entries')
      .select('*')
      .eq('influencer_id', influencerId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (currency) query = query.eq('currency', currency);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

module.exports = LedgerService;
