const supabase = require('./supabase');

// Helper functions for database operations

/**
 * Create a new request (return or exchange)
 */
async function createRequest(requestData) {
    const row = {
        request_id: requestData.requestId,
        order_number: requestData.orderNumber,
        email: requestData.email,
        customer_name: requestData.customerName,
        customer_email: requestData.customerEmail || requestData.email,
        customer_phone: requestData.customerPhone,
        type: requestData.type,
        status: requestData.status || 'pending',
        reason: requestData.reason,
        comments: requestData.comments,
        items: requestData.items,
        shipping_address: requestData.shippingAddress,
        shipping_city: requestData.shippingCity || null,
        shipping_state: requestData.shippingState || null,
        shipping_pincode: requestData.shippingPincode || null,
        new_address: requestData.newAddress,
        new_city: requestData.newCity,
        new_state: requestData.newState,
        new_pincode: requestData.newPincode,
        payment_id: requestData.paymentId,
        payment_amount: requestData.paymentAmount,
        cod_charges: requestData.codCharges || 0,
        awb_number: requestData.awbNumber,
        shipment_id: requestData.shipmentId,
        pickup_date: requestData.pickupDate,
        images: requestData.images,
        admin_notes: requestData.adminNotes || null,
        agent_notes: requestData.agentNotes || null,
        carrier: requestData.carrier || 'shiprocket',
        carrier_shipment_id: requestData.carrierShipmentId,
        carrier_awb: requestData.carrierAwb,
        carrier_fallback_reason: requestData.carrierFallbackReason || null
    };

    let { data, error } = await supabase
        .from('requests')
        .insert([row])
        .select()
        .single();

    // Fallback: cod_charges migration not applied yet — retry without the column
    if (error && /cod_charges/.test(error.message || '')) {
        console.warn('[createRequest] cod_charges column missing, retrying insert without it. Run supabase_migration_add_cod_charges.sql');
        const { cod_charges, ...rowWithoutCod } = row;
        ({ data, error } = await supabase
            .from('requests')
            .insert([rowWithoutCod])
            .select()
            .single());
    }

    if (error) throw error;
    return data;
}

/**
 * Get request by request ID
 */
async function getRequestById(requestId) {
    const { data, error } = await supabase
        .from('requests')
        .select('*')
        .eq('request_id', requestId)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
    }

    return convertFromSnakeCase(data);
}

/**
 * Get all requests for a given order number (customer may have multiple)
 */
async function getRequestsByOrderNumber(orderNumber) {
    // Try both with and without # prefix since orders may be stored either way
    const bare = orderNumber.replace(/^#/, '');  // '1234'
    const hashed = '#' + bare;                   // '#1234'

    // Run both lookups in parallel
    const [res1, res2] = await Promise.all([
        supabase.from('requests').select('*').eq('order_number', bare).order('created_at', { ascending: false }),
        supabase.from('requests').select('*').eq('order_number', hashed).order('created_at', { ascending: false })
    ]);

    if (res1.error && res1.error.code !== 'PGRST116') throw res1.error;
    if (res2.error && res2.error.code !== 'PGRST116') throw res2.error;

    // Merge and deduplicate by request_id
    const seen = new Set();
    const merged = [...(res1.data || []), ...(res2.data || [])].filter(row => {
        if (seen.has(row.request_id)) return false;
        seen.add(row.request_id);
        return true;
    });

    // Sort newest first
    merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return merged.map(convertFromSnakeCase);
}

/**
 * Get all requests with optional filters
 */
async function getAllRequests(filters = {}) {
    let query = supabase.from('requests').select('*', { count: 'exact' });

    if (filters.status) {
        query = query.eq('status', filters.status);
    }

    if (filters.type) {
        query = query.eq('type', filters.type);
    }

    if (filters.date) {
        const startDate = new Date(filters.date);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date(filters.date);
        endDate.setHours(23, 59, 59, 999);

        query = query.gte('created_at', startDate.toISOString())
            .lte('created_at', endDate.toISOString());
    }

    if (filters.carrier) {
        query = query.eq('carrier', filters.carrier);
    }

    if (filters.search) {
        const searchTerm = filters.search;
        // Log search activity without exposing the actual search term (could contain PII)
        console.log('Applying Admin Search: [REDACTED]');
        query = query.or(`request_id.ilike.%${searchTerm}%,order_number.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,customer_email.ilike.%${searchTerm}%,customer_phone.ilike.%${searchTerm}%`);
    }

    query = query.order('created_at', { ascending: false });

    // Ensure pagination defaults
    const page = parseInt(filters.page, 10) || 1;
    const limit = parseInt(filters.limit, 10) || 50;
    const offset = (page - 1) * limit;
    const rangeTo = offset + limit - 1;
    
    console.log(`[Pagination Debug] Page: ${page}, Limit: ${limit}, Range: ${offset} - ${rangeTo}`);
    query = query.range(offset, rangeTo);

    const { data, count, error } = await query;
    console.log(`[Pagination Debug] Database returned ${data ? data.length : 0} rows. Total count: ${count}`);

    if (filters.search) {
        console.log(`Search Results for "${filters.search}": ${data ? data.length : 0} records found`);
    }

    if (error) {
        console.error('Database Query Error:', error);
        throw error;
    }

    return {
        data: data.map(convertFromSnakeCase),
        pagination: {
            total: count || 0,
            page: filters.page ? parseInt(filters.page, 10) : 1,
            limit: filters.limit ? parseInt(filters.limit, 10) : (count || 0)
        }
    };
}

/**
 * Get all requests for export (no pagination, supports date range)
 * Optimized: uses paging loop to bypass Supabase 1000-row cap
 */
async function getAllRequestsForExport(filters = {}) {
    const PAGE_SIZE = 1000;
    let allRows = [];
    let offset = 0;

    while (true) {
        let query = supabase.from('requests').select('*');

        if (filters.status) {
            query = query.eq('status', filters.status);
        }
        if (filters.type) {
            query = query.eq('type', filters.type);
        }
        if (filters.carrier) {
            query = query.eq('carrier', filters.carrier);
        }

        // Date range: from and/or to
        if (filters.dateFrom) {
            const from = new Date(filters.dateFrom);
            from.setHours(0, 0, 0, 0);
            query = query.gte('created_at', from.toISOString());
        }
        if (filters.dateTo) {
            const to = new Date(filters.dateTo);
            to.setHours(23, 59, 59, 999);
            query = query.lte('created_at', to.toISOString());
        }
        // Single date (backward compat)
        if (filters.date && !filters.dateFrom && !filters.dateTo) {
            const startDate = new Date(filters.date);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(filters.date);
            endDate.setHours(23, 59, 59, 999);
            query = query.gte('created_at', startDate.toISOString())
                .lte('created_at', endDate.toISOString());
        }

        if (filters.search) {
            const searchTerm = filters.search;
            query = query.or(`request_id.ilike.%${searchTerm}%,order_number.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,customer_email.ilike.%${searchTerm}%,customer_phone.ilike.%${searchTerm}%`);
        }

        query = query.order('created_at', { ascending: false });
        query = query.range(offset, offset + PAGE_SIZE - 1);

        const { data, error } = await query;
        if (error) {
            console.error('[Export] Database query error:', error);
            throw error;
        }

        allRows = allRows.concat(data || []);
        if (!data || data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return allRows.map(convertFromSnakeCase);
}

/**
 * Get request statistics
 */
/**
 * Get request statistics with detailed analytics (OPTIMIZED with database aggregation)
 */
async function getRequestStats() {
    try {
        // Fetch counts using database aggregation (much faster than loading all records)
        const [
            { count: totalCount },
            { count: pendingCount },
            { count: pickupPendingCount },
            { count: scheduledCount },
            { count: approvedCount },
            { count: rejectedCount },
            { count: waitingPaymentCount },
            { count: returnsCount },
            { count: exchangesCount }
        ] = await Promise.all([
            supabase.from('requests').select('*', { count: 'exact', head: true }),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('status', 'pickup_pending'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('status', 'scheduled'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('status', 'waiting_payment'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('type', 'return'),
            supabase.from('requests').select('*', { count: 'exact', head: true }).eq('type', 'exchange')
        ]);

        // Fetch reason breakdown
        const { data: reasonData, error: reasonError } = await supabase
            .from('requests')
            .select('reason');
        
        if (reasonError) throw reasonError;

        const reasons = {
            size: 0,
            fit: 0,
            color: 0,
            changed_mind: 0,
            defective: 0,
            wrong_item: 0,
            other: 0
        };
        
        reasonData.forEach(r => {
            if (r.reason && reasons[r.reason] !== undefined) {
                reasons[r.reason]++;
            } else if (r.reason) {
                reasons.other++;
            }
        });

        // Fetch total revenue (only records with payment_amount)
        const { data: revenueData, error: revenueError } = await supabase
            .from('requests')
            .select('payment_amount')
            .not('payment_amount', 'is', null);
        
        if (revenueError) throw revenueError;
        
        const totalRevenue = revenueData.reduce((sum, r) => sum + (parseFloat(r.payment_amount) || 0), 0);

        return {
            total: totalCount || 0,
            pending: pendingCount || 0,
            pickupPending: pickupPendingCount || 0,
            scheduled: scheduledCount || 0,
            approved: approvedCount || 0,
            rejected: rejectedCount || 0,
            waitingPayment: waitingPaymentCount || 0,
            returns: returnsCount || 0,
            exchanges: exchangesCount || 0,
            totalRevenue,
            reasons
        };
    } catch (error) {
        console.error('Error in getRequestStats:', error);
        throw error;
    }
}

/**
 * Overwrite core submission data on an existing request (used when resubmitting a waiting_payment request)
 * Preserves the REQ ID — does NOT create a new record.
 */
async function updateRequestData(requestId, data) {
    const updateData = {
        type: data.type,
        reason: data.reason,
        comments: data.comments,
        items: data.items,
        images: data.images,
        customer_name: data.customerName,
        customer_email: data.customerEmail,
        customer_phone: data.customerPhone,
        shipping_address: data.shippingAddress,
        shipping_city: data.shippingCity || null,
        shipping_state: data.shippingState || null,
        shipping_pincode: data.shippingPincode || null,
        new_address: data.newAddress,
        new_city: data.newCity,
        new_state: data.newState,
        new_pincode: data.newPincode,
        payment_id: data.paymentId || null,
        payment_amount: data.paymentAmount || null,
        status: data.status || 'waiting_payment',
        admin_notes: data.adminNotes || null,
        agent_notes: data.agentNotes || null,
        updated_at: new Date().toISOString()
    };

    const { data: row, error } = await supabase
        .from('requests')
        .update(updateData)
        .eq('request_id', requestId)
        .select()
        .single();

    if (error) throw error;
    return convertFromSnakeCase(row);
}

/**
 * Update request status (approve/reject)
 */
async function updateRequestStatus(requestId, updates) {
    const updateData = {};

    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.adminNotes !== undefined) updateData.admin_notes = updates.adminNotes;
    if (updates.agentNotes !== undefined) updateData.agent_notes = updates.agentNotes;

    // Status Timestamps
    if (updates.status === 'approved') {
        updateData.approved_at = new Date().toISOString();
    } else if (updates.status === 'rejected') {
        updateData.rejected_at = new Date().toISOString();
    }

    // Payment Info
    if (updates.paymentId !== undefined) {
        updateData.payment_id = updates.paymentId;
        console.log(`[${requestId}] 💳 DB Update: payment_id = ${updates.paymentId}`);
    }
    if (updates.paymentAmount !== undefined) updateData.payment_amount = updates.paymentAmount;

    // Tracking Info
    if (updates.awbNumber !== undefined) updateData.awb_number = updates.awbNumber;
    if (updates.shipmentId !== undefined) updateData.shipment_id = updates.shipmentId;
    if (updates.pickupDate !== undefined) updateData.pickup_date = updates.pickupDate;

    // Status Timestamps
    if (updates.deliveredAt) updateData.delivered_at = updates.deliveredAt;
    if (updates.pickedUpAt) updateData.picked_up_at = updates.pickedUpAt;
    if (updates.inTransitAt) updateData.in_transit_at = updates.inTransitAt;
    if (updates.outForDeliveryAt) updateData.out_for_delivery_at = updates.outForDeliveryAt;
    if (updates.inspectedAt) updateData.inspected_at = updates.inspectedAt;

    // Forward Tracking
    if (updates.forwardShipmentId !== undefined) updateData.forward_shipment_id = updates.forwardShipmentId;
    if (updates.forwardAwbNumber !== undefined) updateData.forward_awb_number = updates.forwardAwbNumber;
    if (updates.forwardStatus !== undefined) updateData.forward_status = updates.forwardStatus;
    if (updates.forwardCarrier !== undefined) updateData.forward_carrier = updates.forwardCarrier;

    // Carrier Tracking
    if (updates.carrier !== undefined) updateData.carrier = updates.carrier;
    if (updates.carrierShipmentId !== undefined) updateData.carrier_shipment_id = updates.carrierShipmentId;
    if (updates.carrierAwb !== undefined) updateData.carrier_awb = updates.carrierAwb;
    if (updates.carrierFallbackReason !== undefined) updateData.carrier_fallback_reason = updates.carrierFallbackReason;

    // Discount Code (return compensation)
    if (updates.discountCode !== undefined) updateData.discount_code = updates.discountCode;
    if (updates.discountValue !== undefined) updateData.discount_value = updates.discountValue;
    if (updates.discountType !== undefined) updateData.discount_type = updates.discountType;
    if (updates.approvedAt !== undefined) updateData.approved_at = updates.approvedAt;

    // WhatsApp Tracking
    if (updates.whatsappSent !== undefined) updateData.whatsapp_sent = updates.whatsappSent;
    if (updates.whatsappMessageId !== undefined) updateData.whatsapp_message_id = updates.whatsappMessageId;
    if (updates.whatsappSentAt !== undefined) updateData.whatsapp_sent_at = updates.whatsappSentAt;
    if (updates.whatsappError !== undefined) updateData.whatsapp_error = updates.whatsappError;

    // EDD (Expected Delivery Date) - persisted from carrier sync
    if (updates.expectedDeliveryDate !== undefined) updateData.expected_delivery_date = updates.expectedDeliveryDate;
    if (updates.forwardExpectedDeliveryDate !== undefined) updateData.forward_expected_delivery_date = updates.forwardExpectedDeliveryDate;
    if (updates.carrierName !== undefined) updateData.carrier_name = updates.carrierName;
    if (updates.forwardCarrierName !== undefined) updateData.forward_carrier_name = updates.forwardCarrierName;
    if (updates.lastSyncedAt !== undefined) updateData.last_synced_at = updates.lastSyncedAt;

    // Video Evidence (pickup handover & warehouse unboxing)
    if (updates.pickupVideoUrl !== undefined) updateData.pickup_video_url = updates.pickupVideoUrl;
    if (updates.pickupVideoSubmittedAt !== undefined) updateData.pickup_video_submitted_at = updates.pickupVideoSubmittedAt;
    if (updates.unboxingVideoUrl !== undefined) updateData.unboxing_video_url = updates.unboxingVideoUrl;
    if (updates.unboxingVideoSubmittedAt !== undefined) updateData.unboxing_video_submitted_at = updates.unboxingVideoSubmittedAt;

    // Agent Payment Link
    if (updates.agentPaymentLink !== undefined) updateData.agent_payment_link = updates.agentPaymentLink;
    if (updates.agentPaymentLinkId !== undefined) updateData.agent_payment_link_id = updates.agentPaymentLinkId;
    if (updates.agentPaymentAmount !== undefined) updateData.agent_payment_amount = updates.agentPaymentAmount;
    if (updates.agentPaymentStatus !== undefined) updateData.agent_payment_status = updates.agentPaymentStatus;
    if (updates.agentPaymentPaidAt !== undefined) updateData.agent_payment_paid_at = updates.agentPaymentPaidAt;
    if (updates.agentPaymentInitiatedBy !== undefined) updateData.agent_payment_initiated_by = updates.agentPaymentInitiatedBy;
    if (updates.agentPaymentInitiatedAt !== undefined) updateData.agent_payment_initiated_at = updates.agentPaymentInitiatedAt;

    // Resolution & Conversion
    if (updates.resolution !== undefined) updateData.resolution = updates.resolution;
    if (updates.originalType !== undefined) updateData.original_type = updates.originalType;
    if (updates.requestHistory !== undefined) updateData.request_history = updates.requestHistory;
    if (updates.type !== undefined) updateData.type = updates.type;

    // Shipping Address (backfill from Shopify)
    if (updates.shippingAddress !== undefined) updateData.shipping_address = updates.shippingAddress;
    if (updates.shippingCity !== undefined) updateData.shipping_city = updates.shippingCity;
    if (updates.shippingState !== undefined) updateData.shipping_state = updates.shippingState;
    if (updates.shippingPincode !== undefined) updateData.shipping_pincode = updates.shippingPincode;

    // Customer Info (backfill from Shopify)
    if (updates.customerPhone !== undefined) updateData.customer_phone = updates.customerPhone;
    if (updates.customerName !== undefined) updateData.customer_name = updates.customerName;

    if (Object.keys(updateData).length === 0) return null;

    const { data, error } = await supabase
        .from('requests')
        .update(updateData)
        .eq('request_id', requestId)
        .select()
        .single();

    if (error) {
        console.error('Update Request Error:', error);
        throw error;
    }

    return convertFromSnakeCase(data);
}

/**
 * Convert snake_case database fields to camelCase for API responses
 */
function convertFromSnakeCase(data) {
    if (!data) return null;

    return {
        id: data.id,
        requestId: data.request_id,
        orderNumber: data.order_number,
        email: data.email,
        customerName: data.customer_name,
        customerEmail: data.customer_email,
        customerPhone: data.customer_phone,
        type: data.type,
        status: data.status,
        reason: data.reason,
        comments: data.comments,
        items: data.items,
        shippingAddress: data.shipping_address,
        shippingCity: data.shipping_city,
        shippingState: data.shipping_state,
        shippingPincode: data.shipping_pincode,
        newAddress: data.new_address,
        newCity: data.new_city,
        newState: data.new_state,
        newPincode: data.new_pincode,
        paymentId: data.payment_id,
        paymentAmount: data.payment_amount,
        codCharges: parseFloat(data.cod_charges) || 0,
        awbNumber: data.awb_number,
        shipmentId: data.shipment_id,
        pickupDate: data.pickup_date,
        pickedUpAt: data.picked_up_at,
        inTransitAt: data.in_transit_at,
        outForDeliveryAt: data.out_for_delivery_at || null,
        deliveredAt: data.delivered_at,
        inspectedAt: data.inspected_at,
        approvedAt: data.approved_at,
        rejectedAt: data.rejected_at,
        adminNotes: data.admin_notes,
        agentNotes: data.agent_notes,
        images: data.images,
        forwardShipmentId: data.forward_shipment_id,
        forwardAwbNumber: data.forward_awb_number,
        forwardStatus: data.forward_status,
        forwardCarrier: data.forward_carrier,
        carrier: data.carrier,
        carrierShipmentId: data.carrier_shipment_id,
        carrierAwb: data.carrier_awb,
        carrierFallbackReason: data.carrier_fallback_reason,
        expectedDeliveryDate: data.expected_delivery_date || null,
        forwardExpectedDeliveryDate: data.forward_expected_delivery_date || null,
        carrierName: data.carrier_name || null,
        forwardCarrierName: data.forward_carrier_name || null,
        lastSyncedAt: data.last_synced_at || null,
        discountCode: data.discount_code || null,
        discountValue: data.discount_value || null,
        discountType: data.discount_type || null,
        whatsappSent: data.whatsapp_sent || false,
        whatsappMessageId: data.whatsapp_message_id || null,
        whatsappSentAt: data.whatsapp_sent_at || null,
        pickupVideoUrl: data.pickup_video_url || null,
        pickupVideoSubmittedAt: data.pickup_video_submitted_at || null,
        unboxingVideoUrl: data.unboxing_video_url || null,
        unboxingVideoSubmittedAt: data.unboxing_video_submitted_at || null,
        agentPaymentLink: data.agent_payment_link || null,
        agentPaymentLinkId: data.agent_payment_link_id || null,
        agentPaymentAmount: parseFloat(data.agent_payment_amount) || null,
        agentPaymentStatus: data.agent_payment_status || null,
        agentPaymentPaidAt: data.agent_payment_paid_at || null,
        agentPaymentInitiatedBy: data.agent_payment_initiated_by || null,
        agentPaymentInitiatedAt: data.agent_payment_initiated_at || null,
        resolution: data.resolution || null,
        originalType: data.original_type || null,
        requestHistory: data.request_history || [],
        createdAt: data.created_at,
        updatedAt: data.updated_at
    };
}

/**
 * Save agent notes on a request (visible to admin, agent cannot approve/reject)
 */
async function saveAgentNotes(requestId, notes) {
    const { data, error } = await supabase
        .from('requests')
        .update({ agent_notes: notes, updated_at: new Date().toISOString() })
        .eq('request_id', requestId)
        .select()
        .single();

    if (error) throw error;
    return convertFromSnakeCase(data);
}

// ── Dynamic Power Settings ──

let settingsCache = {};
let lastCacheUpdate = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

/**
 * Fetch a setting by key. Uses in-memory cache to prevent DB spam.
 */
async function getSetting(key, defaultValue = null) {
    try {
        if (Date.now() - lastCacheUpdate > CACHE_TTL) {
            const { data, error } = await supabase.from('store_settings').select('key, value');
            if (!error && data) {
                const newCache = {};
                data.forEach(row => newCache[row.key] = row.value);
                settingsCache = newCache;
                lastCacheUpdate = Date.now();
            }
        }
        if (settingsCache[key] !== undefined) return settingsCache[key];
    } catch (err) {
        console.error('Error fetching setting:', err);
    }
    return defaultValue;
}

/**
 * Update or insert a setting
 */
async function updateSetting(key, value) {
    const { error } = await supabase
        .from('store_settings')
        .upsert({ key, value, updated_at: new Date().toISOString() });

    if (error) throw error;

    // Update local cache immediately
    settingsCache[key] = value;
    return value;
}

/**
 * Delete multiple requests by ID
 */
async function deleteRequests(requestIds) {
    if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) return { count: 0 };

    const { data, error, count } = await supabase
        .from('requests')
        .delete({ count: 'exact' })
        .in('request_id', requestIds);

    if (error) {
        console.error('Delete DB Error:', error);
        throw error;
    }

    return { count };
}

// ── Influencer Helpers ──

/**
 * Get all influencers
 */
async function getAllInfluencers() {
    const { data, error } = await supabase
        .from('influencers')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
}

/**
 * Create a new influencer
 */
async function createInfluencer(influencerData) {
    const insertRow = {
        name: influencerData.name,
        referral_code: influencerData.referralCode,
        link_token: influencerData.linkToken,
        commission_rate: influencerData.commissionRate ?? 7.00,
        discount_value: influencerData.discountValue ?? influencerData.commissionRate ?? 7.00,
        displayed_commission_rate: influencerData.displayedCommissionRate ?? influencerData.commissionRate ?? 7.00,
        usage_limit: influencerData.usageLimit ?? null,
        phone: influencerData.phone,
        is_active: influencerData.isActive !== undefined ? influencerData.isActive : true
    };

    // ── Application fields (only if provided; safe for legacy schemas) ──
    if (influencerData.status !== undefined) insertRow.status = influencerData.status;
    if (influencerData.email !== undefined) insertRow.email = influencerData.email;
    if (influencerData.instagramHandle !== undefined) insertRow.instagram_handle = influencerData.instagramHandle;
    if (influencerData.youtubeHandle !== undefined) insertRow.youtube_handle = influencerData.youtubeHandle;
    if (influencerData.followerCount !== undefined) insertRow.follower_count = influencerData.followerCount;
    if (influencerData.niche !== undefined) insertRow.niche = influencerData.niche;
    if (influencerData.city !== undefined) insertRow.city = influencerData.city;
    if (influencerData.whyJoin !== undefined) insertRow.why_join = influencerData.whyJoin;
    if (influencerData.payoutUpi !== undefined) insertRow.payout_upi = influencerData.payoutUpi;
    if (influencerData.payoutNotes !== undefined) insertRow.payout_notes = influencerData.payoutNotes;
    if (influencerData.appliedAt !== undefined) insertRow.applied_at = influencerData.appliedAt;
    if (influencerData.contentWeeklyCount !== undefined) insertRow.content_weekly_count = influencerData.contentWeeklyCount;
    if (influencerData.monthlyTarget !== undefined) insertRow.monthly_target = influencerData.monthlyTarget;
    if (influencerData.followerTier !== undefined) insertRow.follower_tier = influencerData.followerTier;
    if (influencerData.heightCm !== undefined) insertRow.height_cm = influencerData.heightCm;
    if (influencerData.weightKg !== undefined) insertRow.weight_kg = influencerData.weightKg;
    if (influencerData.shippingAddress !== undefined) insertRow.shipping_address = influencerData.shippingAddress;
    if (influencerData.shippingCity !== undefined) insertRow.shipping_city = influencerData.shippingCity;
    if (influencerData.shippingState !== undefined) insertRow.shipping_state = influencerData.shippingState;
    if (influencerData.shippingPin !== undefined) insertRow.shipping_pin = influencerData.shippingPin;
    if (influencerData.shippingLandmark !== undefined) insertRow.shipping_landmark = influencerData.shippingLandmark;
    if (influencerData.addressType !== undefined) insertRow.address_type = influencerData.addressType;
    if (influencerData.selectedProducts !== undefined) insertRow.selected_products = influencerData.selectedProducts;

    const { data, error } = await supabase
        .from('influencers')
        .insert([insertRow])
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Update an influencer's profile
 */
async function updateInfluencer(id, updates) {
    const updateData = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.referralCode !== undefined) updateData.referral_code = updates.referralCode;
    if (updates.commissionRate !== undefined) updateData.commission_rate = parseFloat(updates.commissionRate);
    if (updates.discountValue !== undefined) updateData.discount_value = parseFloat(updates.discountValue);
    if (updates.displayedCommissionRate !== undefined) updateData.displayed_commission_rate = parseFloat(updates.displayedCommissionRate);
    if (updates.usageLimit !== undefined) updateData.usage_limit = updates.usageLimit === '' ? null : parseInt(updates.usageLimit);
    if (updates.phone !== undefined) updateData.phone = updates.phone;
    if (updates.isActive !== undefined) updateData.is_active = updates.isActive;
    if (updates.shopifyPriceRuleId !== undefined) updateData.shopify_price_rule_id = updates.shopifyPriceRuleId;
    if (updates.shopifyDiscountCodeId !== undefined) updateData.shopify_discount_code_id = updates.shopifyDiscountCodeId;

    // ── Application fields ──
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.email !== undefined) updateData.email = updates.email;
    if (updates.instagramHandle !== undefined) updateData.instagram_handle = updates.instagramHandle;
    if (updates.youtubeHandle !== undefined) updateData.youtube_handle = updates.youtubeHandle;
    if (updates.followerCount !== undefined) updateData.follower_count = updates.followerCount;
    if (updates.niche !== undefined) updateData.niche = updates.niche;
    if (updates.city !== undefined) updateData.city = updates.city;
    if (updates.whyJoin !== undefined) updateData.why_join = updates.whyJoin;
    if (updates.payoutUpi !== undefined) updateData.payout_upi = updates.payoutUpi;
    if (updates.payoutNotes !== undefined) updateData.payout_notes = updates.payoutNotes;
    if (updates.approvedAt !== undefined) updateData.approved_at = updates.approvedAt;

    // ── Shipping address fields ──
    if (updates.shippingAddress !== undefined) updateData.shipping_address = updates.shippingAddress;
    if (updates.shippingCity !== undefined) updateData.shipping_city = updates.shippingCity;
    if (updates.shippingState !== undefined) updateData.shipping_state = updates.shippingState;
    if (updates.shippingPin !== undefined) updateData.shipping_pin = updates.shippingPin;
    if (updates.shippingLandmark !== undefined) updateData.shipping_landmark = updates.shippingLandmark;
    if (updates.addressType !== undefined) updateData.address_type = updates.addressType;
    if (updates.heightCm !== undefined) updateData.height_cm = updates.heightCm;
    if (updates.weightKg !== undefined) updateData.weight_kg = updates.weightKg;
    if (updates.contentWeeklyCount !== undefined) updateData.content_weekly_count = updates.contentWeeklyCount;
    if (updates.monthlyTarget !== undefined) updateData.monthly_target = updates.monthlyTarget;
    if (updates.followerTier !== undefined) updateData.follower_tier = updates.followerTier;

    const { data, error } = await supabase
        .from('influencers')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Delete an influencer
 */
async function deleteInfluencer(id) {
    const { error } = await supabase
        .from('influencers')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return { success: true };
}

/**
 * Get influencer by token (for portal auth).
 * Allows status='pending' (so applicants can preview their portal) but blocks suspended/rejected.
 */
async function getInfluencerByToken(token) {
    const { data, error } = await supabase
        .from('influencers')
        .select('*')
        .eq('link_token', token)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
    }
    if (!data) return null;

    // If status column exists, block suspended/rejected
    if (data.status === 'suspended' || data.status === 'rejected') return null;
    // If legacy schema (no status column), fall back to is_active
    if (data.status === undefined && data.is_active === false) return null;

    return data;
}

/**
 * Get influencer by ID (for admin)
 */
async function getInfluencerById(id) {
    const { data, error } = await supabase
        .from('influencers')
        .select('*')
        .eq('id', id)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
    }
    return data;
}

// ── Self-Signup & Duplicate Checks ──

/**
 * Check if a referral code is already taken (case-insensitive)
 */
async function isReferralCodeTaken(code) {
    if (!code) return false;
    const { data, error } = await supabase
        .from('influencers')
        .select('id')
        .ilike('referral_code', code)
        .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
}

/**
 * Check if an email is already registered (case-insensitive)
 */
async function isEmailTaken(email) {
    if (!email) return false;
    const { data, error } = await supabase
        .from('influencers')
        .select('id')
        .ilike('email', email)
        .limit(1);
    if (error) {
        // If 'email' column doesn't exist yet (pre-migration), don't block signup
        if (error.code === '42703') return false;
        throw error;
    }
    return Array.isArray(data) && data.length > 0;
}

/**
 * Check if a phone is already registered
 */
async function isPhoneTaken(phone) {
    if (!phone) return false;
    const cleaned = String(phone).replace(/\D/g, '');
    const { data, error } = await supabase
        .from('influencers')
        .select('id, phone')
        .not('phone', 'is', null);
    if (error) throw error;
    return Array.isArray(data) && data.some(row => String(row.phone || '').replace(/\D/g, '') === cleaned);
}

/**
 * List pending (un-approved) influencer applications
 */
async function listPendingInfluencers() {
    const { data, error } = await supabase
        .from('influencers')
        .select('*')
        .eq('status', 'pending')
        .order('applied_at', { ascending: false });
    if (error) {
        if (error.code === '42703') return []; // status column missing
        throw error;
    }
    return data || [];
}

// ── Payout Helpers ──

/**
 * List payouts for an influencer (newest period first)
 */
async function listPayouts(influencerId) {
    const { data, error } = await supabase
        .from('influencer_payouts')
        .select('*')
        .eq('influencer_id', influencerId)
        .order('period_end', { ascending: false });
    if (error) {
        if (error.code === '42P01') return []; // table missing (pre-migration)
        throw error;
    }
    return data || [];
}

/**
 * Create a new payout entry
 */
async function createPayout(payoutData) {
    const insertRow = {
        influencer_id: payoutData.influencerId,
        period_start: payoutData.periodStart,
        period_end: payoutData.periodEnd,
        amount: parseFloat(payoutData.amount) || 0,
        currency: payoutData.currency || 'INR',
        status: payoutData.status || 'pending',
        reference: payoutData.reference || null,
        notes: payoutData.notes || null
    };
    if (insertRow.status === 'paid') {
        insertRow.paid_at = new Date().toISOString();
    }

    const { data, error } = await supabase
        .from('influencer_payouts')
        .insert([insertRow])
        .select()
        .single();
    if (error) throw error;
    return data;
}

/**
 * Update payout status (e.g., mark as paid / cancelled)
 */
async function updatePayoutStatus(payoutId, status, reference = null) {
    const updateRow = {
        status,
        updated_at: new Date().toISOString()
    };
    if (status === 'paid') {
        updateRow.paid_at = new Date().toISOString();
    } else if (status === 'pending') {
        updateRow.paid_at = null;
    }
    if (reference !== null && reference !== undefined) {
        updateRow.reference = reference;
    }

    const { data, error } = await supabase
        .from('influencer_payouts')
        .update(updateRow)
        .eq('id', payoutId)
        .select()
        .single();
    if (error) throw error;
    return data;
}

/**
 * Get a single payout by ID
 */
async function getPayoutById(payoutId) {
    const { data, error } = await supabase
        .from('influencer_payouts')
        .select('*')
        .eq('id', payoutId)
        .single();
    if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
    }
    return data;
}

module.exports = {
    createRequest,
    getRequestById,
    getRequestsByOrderNumber,
    getAllRequests,
    getAllRequestsForExport,
    getRequestStats,
    updateRequestStatus,
    updateRequestData,
    saveAgentNotes,
    deleteRequests,
    getSetting,
    updateSetting,
    
    // Influencer Helpers
    getAllInfluencers,
    createInfluencer,
    updateInfluencer,
    deleteInfluencer,
    getInfluencerByToken,
    getInfluencerById,

    // Self-Signup & Duplicate Checks
    isReferralCodeTaken,
    isEmailTaken,
    isPhoneTaken,
    listPendingInfluencers,

    // Payout Helpers
    listPayouts,
    createPayout,
    updatePayoutStatus,
    getPayoutById,

    // Influencer Shipments (Analytics)
    createShipment,
    listShipments,
    listShipmentsByInfluencer,
    updateShipment,
    deleteShipment,
    getShipmentById,

    // Influencer Monthly Payouts (Analytics)
    listPayoutsByInfluencer,
    upsertPayout,
    
    // Reel Target Helpers
    createReelTarget,
    getReelTargetsByInfluencer,
    getReelTargetProgress,
    
    // Product Request Helpers
    createProductRequest,
    getProductRequests,
    updateProductRequest,
    getProductRequestById,
    
    // Utility
    convertFromSnakeCase,
    
    // Messaging Helpers
    createMessage,
    getAdminMessages,
    getInfluencerMessages,
    markMessageAsRead,
    getUnreadMessageCount,

    // Operator Helpers (Team & Permissions)
    hashOperatorPassword,
    verifyOperatorPassword,
    createOperator,
    getOperatorByUsername,
    getOperatorById,
    listOperators,
    updateOperator,
    setOperatorActive,
    deleteOperator,
    touchOperatorLogin,
    logOperatorActivity,
    getOperatorActivityLogs
};

// ── Influencer Product Shipments ──

async function createShipment(data) {
    const supabase = require('./supabase');
    const { data: row, error } = await supabase
        .from('influencer_product_shipments')
        .insert([{
            influencer_id: data.influencerId,
            product_title: data.productTitle,
            product_image_url: data.productImageUrl || null,
            shopify_product_id: data.shopifyProductId || null,
            sent_at: data.sentAt,
            reel_due_date: data.reelDueDate,
            reel_status: 'pending',
            notes: data.notes || null
        }])
        .select()
        .single();
    if (error) throw error;
    return row;
}

async function listShipments() {
    const supabase = require('./supabase');
    const { data, error } = await supabase
        .from('influencer_product_shipments')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
}

async function listShipmentsByInfluencer(influencerId) {
    const supabase = require('./supabase');
    const { data, error } = await supabase
        .from('influencer_product_shipments')
        .select('*')
        .eq('influencer_id', influencerId)
        .order('sent_at', { ascending: false });
    if (error) throw error;
    return data;
}

async function updateShipment(shipmentId, updates) {
    const supabase = require('./supabase');
    const updateData = {};
    if (updates.productTitle !== undefined) updateData.product_title = updates.productTitle;
    if (updates.productImageUrl !== undefined) updateData.product_image_url = updates.productImageUrl;
    if (updates.shopifyProductId !== undefined) updateData.shopify_product_id = updates.shopifyProductId;
    if (updates.sentAt !== undefined) updateData.sent_at = updates.sentAt;
    if (updates.reelDueDate !== undefined) updateData.reel_due_date = updates.reelDueDate;
    if (updates.reelStatus !== undefined) updateData.reel_status = updates.reelStatus;
    if (updates.reelUrl !== undefined) updateData.reel_url = updates.reelUrl;
    if (updates.reelReceivedAt !== undefined) updateData.reel_received_at = updates.reelReceivedAt;
    if (updates.notes !== undefined) updateData.notes = updates.notes;
    if (updates.tracking_awb !== undefined) updateData.tracking_awb = updates.tracking_awb;
    if (updates.carrier !== undefined) updateData.carrier = updates.carrier;
    if (updates.delhivery_shipment_id !== undefined) updateData.delhivery_shipment_id = updates.delhivery_shipment_id;
    if (updates.reelStatus === 'received' && !updates.reelReceivedAt) {
        updateData.reel_received_at = new Date().toISOString();
    }

    const { data: row, error } = await supabase
        .from('influencer_product_shipments')
        .update(updateData)
        .eq('id', shipmentId)
        .select()
        .single();
    if (error) throw error;
    return row;
}

async function deleteShipment(shipmentId) {
    const supabase = require('./supabase');
    const { error } = await supabase
        .from('influencer_product_shipments')
        .delete()
        .eq('id', shipmentId);
    if (error) throw error;
    return { success: true };
}

async function getShipmentById(shipmentId) {
    const supabase = require('./supabase');
    const { data, error } = await supabase
        .from('influencer_product_shipments')
        .select('*')
        .eq('id', shipmentId)
        .single();
    if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
    }
    return data;
}

// ── Influencer Monthly Payouts ──

async function listPayoutsByInfluencer(influencerId) {
    const supabase = require('./supabase');
    const { data, error } = await supabase
        .from('influencer_payouts')
        .select('*')
        .eq('influencer_id', influencerId)
        .order('month', { ascending: false });
    if (error) throw error;
    return data;
}

async function upsertPayout(data) {
    const supabase = require('./supabase');
    const { data: row, error } = await supabase
        .from('influencer_payouts')
        .upsert({
            influencer_id: data.influencerId,
            month: data.month,
            orders_count: data.ordersCount,
            revenue_amount: data.revenueAmount,
            commission_rate: data.commissionRate,
            amount_due: data.amountDue,
            status: data.status || 'pending'
        }, { onConflict: 'influencer_id,month' })
        .select()
        .single();
    if (error) throw error;
    return row;
}

// ── Reel Target Helpers ──

/**
 * Create or update monthly reel target for an influencer
 */
async function createReelTarget(data) {
    const supabase = require('./supabase');
    const { data: row, error } = await supabase
        .from('influencer_reel_targets')
        .upsert({
            influencer_id: data.influencerId,
            month: data.month,
            year: data.year,
            target_count: data.targetCount,
            notes: data.notes || null,
            updated_at: new Date().toISOString()
        }, {
            onConflict: 'influencer_id,month,year'
        })
        .select()
        .single();
    
    if (error) throw error;
    return row;
}

/**
 * Get reel targets for a specific influencer with progress data
 */
async function getReelTargetsByInfluencer(influencerId, filters = {}) {
    const supabase = require('./supabase');
    let query = supabase
        .from('influencer_reel_targets')
        .select('*')
        .eq('influencer_id', influencerId)
        .order('year', { ascending: false })
        .order('month', { ascending: false });
    
    if (filters.month) query = query.eq('month', filters.month);
    if (filters.year) query = query.eq('year', filters.year);
    if (filters.limit) query = query.limit(filters.limit);
    
    const { data, error } = await query;
    if (error) throw error;
    
    // Enrich each target with progress data
    const enriched = await Promise.all((data || []).map(async (target) => {
        const progress = await getReelTargetProgress(influencerId, target.month, target.year);
        return { ...target, ...progress };
    }));
    
    return enriched;
}

/**
 * Calculate progress for a specific monthly target
 */
async function getReelTargetProgress(influencerId, month, year) {
    const supabase = require('./supabase');
    // Calculate date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`;
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + 1);
    
    const { data: shipments, error } = await supabase
        .from('influencer_product_shipments')
        .select('reel_status, reel_due_date')
        .eq('influencer_id', influencerId)
        .eq('is_monthly_target', true)
        .gte('created_at', startDate)
        .lt('created_at', endDate.toISOString());
    
    if (error) throw error;
    
    const submittedCount = (shipments || []).filter(s => s.reel_status === 'received').length;
    const pendingCount = (shipments || []).filter(s => s.reel_status === 'pending').length;
    const now = new Date().toISOString().split('T')[0];
    const overdueCount = (shipments || []).filter(s => s.reel_status === 'pending' && s.reel_due_date < now).length;
    
    // Get target count
    const { data: target } = await supabase
        .from('influencer_reel_targets')
        .select('target_count')
        .eq('influencer_id', influencerId)
        .eq('month', month)
        .eq('year', year)
        .single();
    
    const targetCount = target?.target_count || 0;
    const completionPercentage = targetCount > 0 ? (submittedCount / targetCount) * 100 : 0;
    
    return {
        targetCount,
        submittedCount,
        pendingCount,
        overdueCount,
        completionPercentage: Math.round(completionPercentage * 100) / 100
    };
}

// ── Product Request Helpers ──

/**
 * Create a new product request from influencer
 */
async function createProductRequest(data) {
    const supabase = require('./supabase');
    const { data: row, error } = await supabase
        .from('influencer_product_requests')
        .insert([{
            influencer_id: data.influencerId,
            product_title: data.productTitle,
            product_image_url: data.productImageUrl || null,
            shopify_product_id: data.shopifyProductId || null,
            shopify_variant_id: data.shopifyVariantId || null,
            reason: data.reason,
            shipping_full_name: data.shippingFullName,
            shipping_address_line1: data.shippingAddressLine1,
            shipping_address_line2: data.shippingAddressLine2 || null,
            shipping_city: data.shippingCity,
            shipping_state: data.shippingState,
            shipping_pincode: data.shippingPincode,
            shipping_phone: data.shippingPhone,
            status: 'pending'
        }])
        .select()
        .single();
    
    if (error) throw error;
    return row;
}

/**
 * Get product requests with filtering and pagination
 */
async function getProductRequests(filters = {}) {
    const supabase = require('./supabase');
    let query = supabase
        .from('influencer_product_requests')
        .select(`
            *,
            influencers (
                id, name, referral_code
            )
        `);
    
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.influencerId) query = query.eq('influencer_id', filters.influencerId);
    if (filters.search) {
        query = query.or(`product_title.ilike.%${filters.search}%,influencers.name.ilike.%${filters.search}%`);
    }
    
    query = query.order('created_at', { ascending: false });
    
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 50;
    const offset = (page - 1) * limit;
    
    const { data, count, error } = await query.range(offset, offset + limit - 1);
    if (error) throw error;
    
    // Get summary counts
    const { data: allRequests } = await supabase
        .from('influencer_product_requests')
        .select('status');
    
    const summary = { pending: 0, approved: 0, rejected: 0, shipped: 0, delivered: 0 };
    (allRequests || []).forEach(r => {
        if (summary[r.status] !== undefined) summary[r.status]++;
    });
    
    return {
        requests: data || [],
        pagination: {
            currentPage: page,
            totalRequests: count || 0,
            totalPages: Math.ceil((count || 0) / limit),
            hasNextPage: offset + limit < (count || 0)
        },
        summary
    };
}

/**
 * Update product request status and fields
 */
async function updateProductRequest(requestId, updates) {
    const supabase = require('./supabase');
    const updateData = {
        updated_at: new Date().toISOString()
    };
    
    if (updates.status) updateData.status = updates.status;
    if (updates.delhiveryAwb) updateData.delhivery_awb = updates.delhiveryAwb;
    if (updates.delhiveryShipmentId) updateData.delhivery_shipment_id = updates.delhiveryShipmentId;
    if (updates.adminNotes) updateData.admin_notes = updates.adminNotes;
    if (updates.rejectionReason) updateData.rejection_reason = updates.rejectionReason;
    if (updates.approvedAt) updateData.approved_at = updates.approvedAt;
    if (updates.rejectedAt) updateData.rejected_at = updates.rejectedAt;
    if (updates.shippedAt) updateData.shipped_at = updates.shippedAt;
    if (updates.deliveredAt) updateData.delivered_at = updates.deliveredAt;
    
    const { data, error } = await supabase
        .from('influencer_product_requests')
        .update(updateData)
        .eq('id', requestId)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

/**
 * Get single product request by ID
 */
async function getProductRequestById(requestId) {
    const supabase = require('./supabase');
    const { data, error } = await supabase
        .from('influencer_product_requests')
        .select(`
            *,
            influencers (
                id, name, referral_code
            )
        `)
        .eq('id', requestId)
        .single();
    
    if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
    }
    return data;
}

// ── Messaging Helpers ──

/**
 * Create a new message (admin to influencer, influencer to admin, or broadcast)
 */
async function createMessage(messageData) {
    const supabase = require('./supabase');
    const messageId = 'MSG-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 5).toUpperCase();
    
    const insertRow = {
        message_id: messageId,
        sender_type: messageData.senderType, // 'admin' or 'influencer'
        sender_id: messageData.senderId || null,
        recipient_type: messageData.recipientType, // 'admin', 'influencer', 'all'
        recipient_id: messageData.recipientId || null,
        subject: messageData.subject || null,
        content: messageData.content,
        is_broadcast: messageData.isBroadcast || false,
        is_read: false
    };

    const { data, error } = await supabase
        .from('influencer_messages')
        .insert([insertRow])
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Get all messages for admin view (with optional filters)
 */
async function getAdminMessages(filters = {}) {
    const supabase = require('./supabase');
    let query = supabase
        .from('influencer_messages')
        .select(`
            *,
            influencers!fk_influencer_messages_sender (
                id, name, referral_code, email
            )
        `);

    if (filters.influencerId) {
        query = query.or(`sender_id.eq.${filters.influencerId},recipient_id.eq.${filters.influencerId}`);
    }

    if (filters.type === 'broadcast') {
        query = query.eq('is_broadcast', true);
    } else if (filters.type === 'direct') {
        query = query.eq('is_broadcast', false);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    
    if (error) {
        console.error('getAdminMessages query error:', error);
        // Fallback: query without join if FK name is incorrect
        let fallbackQuery = supabase.from('influencer_messages').select('*');
        
        if (filters.influencerId) {
            fallbackQuery = fallbackQuery.or(`sender_id.eq.${filters.influencerId},recipient_id.eq.${filters.influencerId}`);
        }
        if (filters.type === 'broadcast') {
            fallbackQuery = fallbackQuery.eq('is_broadcast', true);
        } else if (filters.type === 'direct') {
            fallbackQuery = fallbackQuery.eq('is_broadcast', false);
        }
        
        const { data: fallbackData, error: fallbackError } = await fallbackQuery.order('created_at', { ascending: false });
        if (fallbackError) throw fallbackError;
        
        // Manually enrich with influencer data
        const enriched = await Promise.all((fallbackData || []).map(async (msg) => {
            if (msg.sender_type === 'influencer' && msg.sender_id) {
                const { data: inf } = await supabase.from('influencers').select('id, name, referral_code, email').eq('id', msg.sender_id).single();
                return { ...msg, influencers: inf };
            } else if (msg.recipient_type === 'influencer' && msg.recipient_id) {
                const { data: inf } = await supabase.from('influencers').select('id, name, referral_code, email').eq('id', msg.recipient_id).single();
                return { ...msg, influencers: inf };
            }
            return msg;
        }));
        
        return enriched;
    }
    
    return data || [];
}

/**
 * Get messages for a specific influencer
 */
async function getInfluencerMessages(influencerId, filters = {}) {
    const supabase = require('./supabase');
    let query = supabase
        .from('influencer_messages')
        .select('*')
        .or(`and(sender_type.eq.influencer,sender_id.eq.${influencerId}),and(recipient_type.eq.influencer,recipient_id.eq.${influencerId}),is_broadcast.eq.true`);

    if (filters.unreadOnly) {
        query = query.eq('is_read', false).neq('sender_type', 'influencer');
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    
    if (error) throw error;
    return data || [];
}

/**
 * Mark a message as read
 */
async function markMessageAsRead(messageId) {
    const supabase = require('./supabase');
    const { data, error } = await supabase
        .from('influencer_messages')
        .update({ 
            is_read: true, 
            read_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('message_id', messageId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Get unread message count for an influencer
 */
async function getUnreadMessageCount(influencerId) {
    const supabase = require('./supabase');
    const { count, error } = await supabase
        .from('influencer_messages')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_type', 'influencer')
        .eq('recipient_id', influencerId)
        .eq('is_read', false);

    if (error) throw error;
    return count || 0;
}

// ── Operator Helpers (Team & Permissions) ──

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }; // modest params: ~50ms, login/reset only

/**
 * Hash an operator password with scrypt (built-in crypto, no dependency).
 * Stored format: scrypt:<saltHex>:<hashHex>
 */
function hashOperatorPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
    return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a password against a stored scrypt hash (timing-safe).
 */
function verifyOperatorPassword(password, stored) {
    try {
        if (!stored || typeof stored !== 'string') return false;
        const parts = stored.split(':');
        if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
        const salt = Buffer.from(parts[1], 'hex');
        const expected = Buffer.from(parts[2], 'hex');
        const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT_OPTS);
        return crypto.timingSafeEqual(actual, expected);
    } catch (err) {
        console.error('verifyOperatorPassword error:', err.message);
        return false;
    }
}

/** Strip sensitive fields before returning an operator row to clients */
function sanitizeOperator(op) {
    if (!op) return null;
    const { password_hash, ...rest } = op;
    return rest;
}

async function createOperator(opData) {
    const row = {
        username: opData.username,
        name: opData.name || null,
        email: opData.email || null,
        password_hash: opData.passwordHash,
        permissions: opData.permissions || [],
        is_active: true
    };
    // manufacture_scope may not exist yet if migration hasn't been run
    if (opData.manufactureScope) row.manufacture_scope = opData.manufactureScope;

    const { data, error } = await supabase
        .from('operators')
        .insert([row])
        .select()
        .single();

    if (error) {
        // Retry without manufacture_scope if column doesn't exist yet
        if (error.code === '42703' || (error.message || '').includes('manufacture_scope')) {
            delete row.manufacture_scope;
            const retry = await supabase.from('operators').insert([row]).select().single();
            if (retry.error) throw retry.error;
            return sanitizeOperator(retry.data);
        }
        throw error;
    }
    return sanitizeOperator(data);
}

async function getOperatorByUsername(username) {
    const { data, error } = await supabase
        .from('operators')
        .select('*')
        .ilike('username', username)
        .limit(1);

    if (error) throw error;
    return (data && data[0]) || null; // full row incl. password_hash (login only)
}

async function getOperatorById(id) {
    const { data, error } = await supabase
        .from('operators')
        .select('*')
        .eq('id', id)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
    }
    return data;
}

async function listOperators() {
    const { data, error } = await supabase
        .from('operators')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) throw error;
    return (data || []).map(sanitizeOperator);
}

async function updateOperator(id, updates) {
    const updateData = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.email !== undefined) updateData.email = updates.email;
    if (updates.permissions !== undefined) updateData.permissions = updates.permissions;
    if (updates.manufactureScope !== undefined) updateData.manufacture_scope = updates.manufactureScope;
    if (updates.passwordHash !== undefined) updateData.password_hash = updates.passwordHash;

    const { data, error } = await supabase
        .from('operators')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        // Retry without manufacture_scope if column doesn't exist yet
        if (updateData.manufacture_scope && (error.code === '42703' || (error.message || '').includes('manufacture_scope'))) {
            delete updateData.manufacture_scope;
            const retry = await supabase.from('operators').update(updateData).eq('id', id).select().single();
            if (retry.error) throw retry.error;
            return sanitizeOperator(retry.data);
        }
        throw error;
    }
    return sanitizeOperator(data);
}

async function setOperatorActive(id, active) {
    const { data, error } = await supabase
        .from('operators')
        .update({
            is_active: active,
            banned_at: active ? null : new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return sanitizeOperator(data);
}

async function deleteOperator(id) {
    const { error } = await supabase
        .from('operators')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return { success: true };
}

/** Update last_login_at (fire-and-forget friendly) */
async function touchOperatorLogin(id) {
    const { error } = await supabase
        .from('operators')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', id);
    if (error) console.error('touchOperatorLogin error:', error.message);
}

/** Insert an audit entry. Callers treat this as fire-and-forget. */
async function logOperatorActivity(entry) {
    const { error } = await supabase
        .from('operator_activity_logs')
        .insert([{
            operator_id: entry.operatorId || null,
            username: entry.username || 'super-admin',
            action: entry.action,
            method: entry.method || null,
            path: entry.path || null,
            target: entry.target || null,
            success: entry.success !== false,
            ip: entry.ip || null
        }]);
    if (error) throw error;
}

/** Paginated activity logs with filters */
async function getOperatorActivityLogs(filters = {}) {
    let query = supabase
        .from('operator_activity_logs')
        .select('*', { count: 'exact' });

    // ── Free-text cross-table search ──
    let searchAscending = false;
    if (filters.search) {
        const term = filters.search;
        // Collect all identifiers to match against the target column
        const targetValues = new Set();

        // Always match the raw term against target (handles operator handles, partial REQ-XXXXX, etc.)
        targetValues.add(term);

        // Normalise: if user types "REQ-12345" or just "12345", resolve to the canonical REQ-XXXXX form
        const bareNumeric = term.replace(/^REQ-/i, '').trim();
        if (/^\d{4,}$/.test(bareNumeric)) {
            targetValues.add(`REQ-${bareNumeric}`);
        }

        // Cross-reference the requests table for order_id, AWBs linked to this REQ-ID
        const reqIdMatch = term.match(/^REQ-(\d+)$/i) || (/^\d{4,}$/.test(bareNumeric) ? [null, bareNumeric] : null);
        if (reqIdMatch) {
            const canonicalId = `REQ-${reqIdMatch[1]}`;
            try {
                const { data: reqRows } = await supabase
                    .from('requests')
                    .select('request_id, order_id, awb_number, forward_awb_number, carrier_awb')
                    .eq('request_id', canonicalId);
                if (reqRows && reqRows.length) {
                    for (const r of reqRows) {
                        if (r.request_id) targetValues.add(r.request_id);
                        if (r.order_id) targetValues.add(String(r.order_id));
                        if (r.awb_number) targetValues.add(String(r.awb_number));
                        if (r.forward_awb_number) targetValues.add(String(r.forward_awb_number));
                        if (r.carrier_awb) targetValues.add(String(r.carrier_awb));
                    }
                }
            } catch (e) {
                console.warn('[ActivitySearch] requests cross-ref failed:', e.message);
            }
        }

        // Also search by order number pattern (e.g. #12345 or plain numeric that could be an order id)
        const orderCandidate = term.replace(/^#/, '').trim();
        if (/^\d{3,}$/.test(orderCandidate)) {
            try {
                const { data: orderRows } = await supabase
                    .from('requests')
                    .select('request_id, order_id, awb_number, forward_awb_number, carrier_awb')
                    .eq('order_id', orderCandidate);
                if (orderRows && orderRows.length) {
                    for (const r of orderRows) {
                        if (r.request_id) targetValues.add(r.request_id);
                        if (r.order_id) targetValues.add(String(r.order_id));
                        if (r.awb_number) targetValues.add(String(r.awb_number));
                        if (r.forward_awb_number) targetValues.add(String(r.forward_awb_number));
                        if (r.carrier_awb) targetValues.add(String(r.carrier_awb));
                    }
                }
            } catch (e) {
                console.warn('[ActivitySearch] order cross-ref failed:', e.message);
            }
        }

        // Also search by AWB (typically a numeric string of 10+ digits)
        const awbCandidate = term.trim();
        if (/^\d{8,}$/.test(awbCandidate)) {
            try {
                const { data: awbRows } = await supabase
                    .from('requests')
                    .select('request_id, order_id, awb_number, forward_awb_number, carrier_awb')
                    .or(`awb_number.eq.${awbCandidate},forward_awb_number.eq.${awbCandidate},carrier_awb.eq.${awbCandidate}`);
                if (awbRows && awbRows.length) {
                    for (const r of awbRows) {
                        if (r.request_id) targetValues.add(r.request_id);
                        if (r.order_id) targetValues.add(String(r.order_id));
                        if (r.awb_number) targetValues.add(String(r.awb_number));
                        if (r.forward_awb_number) targetValues.add(String(r.forward_awb_number));
                        if (r.carrier_awb) targetValues.add(String(r.carrier_awb));
                    }
                }
            } catch (e) {
                console.warn('[ActivitySearch] AWB cross-ref failed:', e.message);
            }
        }

        // Build OR filter: target IN (...) OR username ILIKE term
        const targetArr = Array.from(targetValues);
        const usernameFilter = `username.ilike.*${term}*`;
        if (targetArr.length === 1) {
            query = query.or(`target.eq.${targetArr[0]},${usernameFilter}`);
        } else {
            const targetInClause = targetArr.map(t => `target.eq.${t}`).join(',');
            query = query.or(`${targetInClause},${usernameFilter}`);
        }

        // When searching, show the complete trail chronologically (oldest → newest)
        searchAscending = true;
    }

    if (filters.operatorId) query = query.eq('operator_id', filters.operatorId);
    if (filters.username) query = query.eq('username', filters.username);
    if (filters.action) query = query.eq('action', filters.action);
    if (filters.fromDate) query = query.gte('created_at', filters.fromDate);
    if (filters.toDate) query = query.lte('created_at', filters.toDate);

    query = query.order('created_at', { ascending: searchAscending });

    const page = parseInt(filters.page, 10) || 1;
    const limit = Math.min(parseInt(filters.limit, 10) || 50, 200);
    const offset = (page - 1) * limit;

    const { data, count, error } = await query.range(offset, offset + limit - 1);
    if (error) throw error;

    return {
        logs: data || [],
        pagination: { page, limit, total: count || 0 }
    };
}
