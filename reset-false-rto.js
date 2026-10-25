/**
 * Reset incorrectly-marked RTO/failed requests in exchange-return-tracking-main
 * 
 * Issue: Many requests are marked as 'failed' (RTO) when they're actually still
 * in transit or delivered. This script resets them so the sync can re-evaluate
 * with the fixed RTO detection logic.
 * 
 * The fix:
 * 1. StatusType 'RT'/'RTO' now ALWAYS maps to 'failed' (DTO is also a failure case)
 * 2. Terminal 'failed' status cannot be overridden by forward progress
 * 3. Reset 'failed' rows that are actually in transit or delivered
 */

require('dotenv').config();
const supabase = require('./config/supabase');

async function resetFalseRtoRequests() {
    console.log('🔄 Starting RTO/failed reset process...\n');

    try {
        // Find requests marked as 'failed' (RTO) that might be incorrectly classified
        // We'll check recent failed requests (last 30 days) to see if they're actually in transit or delivered
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const { data: failedRequests, error } = await supabase
            .from('requests')
            .select('id, request_id, awb_number, status, forward_status, updated_at, carrier')
            .eq('status', 'failed')
            .gte('updated_at', thirtyDaysAgo.toISOString())
            .order('updated_at', { ascending: false });

        if (error) {
            console.error('❌ Failed to fetch failed requests:', error.message);
            return;
        }

        console.log(`📊 Found ${failedRequests?.length || 0} failed (RTO) requests in last 30 days\n`);

        if (!failedRequests || failedRequests.length === 0) {
            console.log('✅ No failed requests to reset');
            return;
        }

        // For each failed request, we'll reset it to 'in_transit' so the sync re-evaluates
        // The fixed RTO detection will then correctly classify it
        let resetCount = 0;
        for (const req of failedRequests) {
            try {
                // Reset request to 'in_transit' so sync picks it up
                const updates = {
                    status: 'in_transit',
                    updated_at: new Date().toISOString()
                };

                // Also reset forward_status if it's 'failed'
                if (req.forward_status === 'failed') {
                    updates.forward_status = 'in_transit';
                }

                const { error: updateError } = await supabase
                    .from('requests')
                    .update(updates)
                    .eq('id', req.id);

                if (updateError) {
                    console.error(`❌ Failed to reset request #${req.id}:`, updateError.message);
                } else {
                    console.log(`✅ Reset request #${req.id} (${req.request_id}, AWB ${req.awb_number}) from failed to in_transit`);
                    resetCount++;
                }
            } catch (err) {
                console.error(`❌ Failed to reset request #${req.id}:`, err.message);
            }
        }

        console.log(`\n✅ Reset ${resetCount} / ${failedRequests.length} failed requests to in_transit`);
        console.log('🔄 The background sync will now re-evaluate these requests with the fixed RTO detection logic\n');

    } catch (error) {
        console.error('❌ RTO reset failed:', error);
    } finally {
        process.exit(0);
    }
}

// Run the reset
resetFalseRtoRequests();
