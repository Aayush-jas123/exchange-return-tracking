// ============================================================================
// AttributionService — Order-to-athlete matching + commission freezing
// ----------------------------------------------------------------------------
// Rule (spec §06): Commission is frozen at order time.
// attributed_order.commission_rate is stored on the row.
// Recalculating historical commission after promotion is forbidden.
// ============================================================================

const supabase = require('../../config/supabase');
const LedgerService = require('./LedgerService');
const CommissionService = require('./CommissionService');
const DiscountCodeService = require('./DiscountCodeService');

// Shopify financial statuses that mean the order no longer earns anything.
const VOID_FINANCIAL_STATUSES = ['refunded', 'voided', 'expired'];

async function getSetting(key, defaultValue) {
  const { data } = await supabase
    .from('program_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  const value = data?.value ?? defaultValue;
  return typeof value === 'string' && value.trim() !== '' && !isNaN(value) ? Number(value) : value;
}

const AttributionService = {

  /**
   * Ingest a Shopify order and attribute it to an athlete.
   * Idempotent on shopify_order_id (unique constraint).
   *
   * @param {object} payload — { shopify_order_id, code_used, attribution_method, net_value,
   *   placed_at, customer_name, financial_status, fulfillment_status, currency,
   *   influencer_id (optional — skips the code lookup when the caller already matched it) }
   * @returns {Promise<{order: object|null, attributed: boolean, xpAwarded: boolean}>}
   */
  async ingestOrder(payload) {
    const {
      shopify_order_id, code_used, attribution_method = 'CODE',
      net_value, placed_at, customer_name, financial_status,
      fulfillment_status, currency = 'INR', is_self_purchase = false,
      influencer_id: knownInfluencerId = null
    } = payload;

    if (!shopify_order_id) throw new Error('shopify_order_id is required');

    // Check idempotency — if order already exists, return it
    const { data: existing } = await supabase
      .from('attributed_orders')
      .select('*')
      .eq('shopify_order_id', shopify_order_id)
      .maybeSingle();

    if (existing) return { order: existing, attributed: false, xpAwarded: false };

    // Find the athlete by discount code
    let influencerId = knownInfluencerId;
    let commissionRate = 7; // Flat fallback, matches the portal commissions view

    if (!influencerId && code_used) {
      // resolveByCode falls back to influencers.referral_code, so codes added
      // after the athlete-program migration still attribute their orders.
      const discount = await DiscountCodeService.resolveByCode(code_used);
      if (discount && discount.is_active) {
        influencerId = discount.influencer_id;
        commissionRate = parseFloat(discount.percent) || 0;
      }
    }

    // If no athlete found by code, try UTM or link attribution
    // (Future: implement UTM/link attribution lookup)

    if (!influencerId) {
      // Order not attributable — store without influencer for analytics
      console.log(`[Attribution] Order ${shopify_order_id} not attributable to any athlete`);
      return { order: null, attributed: false, xpAwarded: false };
    }

    // Freeze the athlete's current level commission rate on the order. The rate
    // comes from the comfort level ladder (admin-editable), never recomputed later.
    try {
      const rates = await CommissionService.getForAthlete(influencerId, { fallback: commissionRate });
      commissionRate = rates.rate;
    } catch (err) {
      console.error(`[Attribution] Commission rate lookup failed for athlete ${influencerId}, using ${commissionRate}%:`, err.message);
    }

    const netValue = parseFloat(net_value) || 0;
    const commissionAmount = Math.round(netValue * commissionRate / 100 * 100) / 100;

    // Insert attributed order with FROZEN commission rate
    const { data: order, error } = await supabase
      .from('attributed_orders')
      .insert([{
        influencer_id: influencerId,
        shopify_order_id,
        code_used,
        attribution_method,
        net_value: netValue,
        placed_at,
        customer_name,
        financial_status,
        fulfillment_status,
        currency,
        is_self_purchase,
        commission_rate: commissionRate,  // FROZEN — never recalculate
        commission_amount: commissionAmount,
        commission_status: is_self_purchase ? 'PENDING' : 'EARNED'
      }])
      .select()
      .single();

    if (error) {
      // Handle unique constraint race
      if (error.code === '23505') {
        const { data: race } = await supabase
          .from('attributed_orders')
          .select('*')
          .eq('shopify_order_id', shopify_order_id)
          .single();
        return { order: race, attributed: false, xpAwarded: false };
      }
      throw error;
    }

    // Award XP for the order (idempotent)
    let xpAwarded = false;
    if (!is_self_purchase) {
      try {
        const xpPerOrder = parseInt(await getSetting('xp.per_order', 20), 10) || 0;
        if (xpPerOrder > 0) {
          const { isNew } = await LedgerService.award(
            influencerId, 'XP', xpPerOrder, 'ORDER', order.id,
            `order:${shopify_order_id}:xp`, 'ORDER_XP'
          );
          xpAwarded = isNew;
        }

        // Also award XP based on revenue (per Rs1000)
        const xpPer1000 = parseFloat(await getSetting('xp.per_1000_revenue', 10)) || 0;
        const revenueXp = Math.floor(netValue / 1000 * xpPer1000);
        if (revenueXp > 0) {
          await LedgerService.award(
            influencerId, 'XP', revenueXp, 'ORDER', order.id,
            `order:${shopify_order_id}:revenue_xp`, 'ORDER_REVENUE_XP'
          );
        }
      } catch (err) {
        console.error(`[Attribution] Failed to award XP for order ${shopify_order_id}:`, err);
      }
    }

    console.log(`[Attribution] Order ${shopify_order_id} -> Athlete ${influencerId} | Rs${netValue} | ${commissionRate}% = Rs${commissionAmount}`);

    return { order, attributed: true, xpAwarded };
  },

  /**
   * Reverse an order's commission (refund or cancellation).
   *
   * @param {number} shopifyOrderId
   * @param {number} refundedAmount
   * @returns {Promise<void>}
   */
  async reverseOrder(shopifyOrderId, refundedAmount = 0) {
    const { data: order, error } = await supabase
      .from('attributed_orders')
      .select('*')
      .eq('shopify_order_id', shopifyOrderId)
      .maybeSingle();

    if (error) throw error;
    if (!order || order.is_cancelled) return;

    // Update order record
    const updateData = { is_cancelled: true };
    if (refundedAmount > 0) {
      updateData.refunded_amount = parseFloat(order.refunded_amount || 0) + refundedAmount;
    }
    // Reverse commission unless it was already paid out
    if (order.commission_status !== 'PAID') updateData.commission_status = 'REVERSED';

    await supabase
      .from('attributed_orders')
      .update(updateData)
      .eq('shopify_order_id', shopifyOrderId);

    // Reverse every XP entry this order produced (order XP + revenue XP)
    try {
      const { data: xpEntries, error: xpErr } = await supabase
        .from('ledger_entries')
        .select('id')
        .eq('source_type', 'ORDER')
        .eq('source_id', order.id)
        .eq('currency', 'XP')
        .gt('amount', 0);
      if (xpErr) throw xpErr;

      for (const entry of (xpEntries || [])) {
        await LedgerService.reverse(entry.id, 'ORDER_REFUND');
      }
    } catch (err) {
      console.error(`[Attribution] Failed to reverse XP for order ${shopifyOrderId}:`, err);
    }

    console.log(`[Attribution] Reversed order ${shopifyOrderId} — refunded Rs${refundedAmount}`);
  },

  /**
   * Reconcile influencer_orders (filled by the Shopify coupon sync) into
   * attributed_orders, which is what the athlete portal and XP read from.
   * New coupon orders are ingested (and earn XP); orders that were later
   * cancelled/refunded are reversed. Safe to run repeatedly.
   *
   * @returns {Promise<{ingested: number, reversed: number, errors: number, affectedInfluencerIds: number[]}>}
   */
  async syncFromInfluencerOrders() {
    const sourceRows = await this._fetchAll('influencer_orders',
      'shopify_order_id, influencer_id, referral_code, total_price, currency, financial_status, fulfillment_status, customer_name, cancelled_at, order_created_at');
    const attributedRows = await this._fetchAll('attributed_orders', 'shopify_order_id, is_cancelled');
    const attributed = new Map(attributedRows.map(r => [String(r.shopify_order_id), r]));

    const affected = new Set();
    let ingested = 0, reversed = 0, errors = 0;

    for (const row of sourceRows) {
      if (!row.influencer_id) continue;
      const isVoid = !!row.cancelled_at || VOID_FINANCIAL_STATUSES.includes(row.financial_status);
      const existing = attributed.get(String(row.shopify_order_id));

      try {
        if (!existing) {
          if (isVoid) continue; // never counted, nothing to undo
          const result = await this.ingestOrder({
            shopify_order_id: row.shopify_order_id,
            influencer_id: row.influencer_id,
            code_used: row.referral_code,
            net_value: row.total_price,
            placed_at: row.order_created_at,
            customer_name: row.customer_name,
            financial_status: row.financial_status,
            fulfillment_status: row.fulfillment_status,
            currency: row.currency || 'INR'
          });
          if (result.attributed) {
            ingested++;
            affected.add(row.influencer_id);
          }
        } else if (isVoid && !existing.is_cancelled) {
          await this.reverseOrder(row.shopify_order_id);
          reversed++;
          affected.add(row.influencer_id);
        }
      } catch (err) {
        errors++;
        console.error(`[Attribution] Sync failed for order ${row.shopify_order_id}:`, err.message || err);
      }
    }

    console.log(`[Attribution] Coupon order sync: ${ingested} ingested, ${reversed} reversed, ${errors} errors`);
    return { ingested, reversed, errors, affectedInfluencerIds: [...affected] };
  },

  /** @private — page through a whole table (PostgREST caps responses at 1000 rows) */
  async _fetchAll(table, columns) {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .order('shopify_order_id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  },

  /**
   * Get attributed orders for an athlete.
   *
   * @param {number} influencerId
   * @param {object} opts — { limit, offset, status }
   * @returns {Promise<object[]>}
   */
  async getOrders(influencerId, { limit = 50, offset = 0, status } = {}) {
    let query = supabase
      .from('attributed_orders')
      .select('*')
      .eq('influencer_id', influencerId)
      .order('placed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('commission_status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * Get commission summary for an athlete.
   *
   * @param {number} influencerId
   * @returns {Promise<object>}
   */
  async getCommissionSummary(influencerId) {
    const { data: orders, error } = await supabase
      .from('attributed_orders')
      .select('commission_status, commission_amount, net_value')
      .eq('influencer_id', influencerId);

    if (error) throw error;

    const summary = {
      total_orders: orders?.length || 0,
      total_revenue: 0,
      total_commission: 0,
      earned: 0,
      pending: 0,
      reversed: 0,
      paid: 0
    };

    for (const o of (orders || [])) {
      summary.total_revenue += parseFloat(o.net_value) || 0;
      summary.total_commission += parseFloat(o.commission_amount) || 0;

      if (o.commission_status === 'EARNED') summary.earned += parseFloat(o.commission_amount) || 0;
      else if (o.commission_status === 'PENDING') summary.pending += parseFloat(o.commission_amount) || 0;
      else if (o.commission_status === 'REVERSED') summary.reversed += parseFloat(o.commission_amount) || 0;
      else if (o.commission_status === 'PAID') summary.paid += parseFloat(o.commission_amount) || 0;
    }

    return summary;
  }
};

module.exports = AttributionService;
