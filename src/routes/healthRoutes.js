/**
 * healthRoutes.js — liveness and readiness for the returns / exchange service
 * (Phase 1 §B1–B5). Same envelope as whatsappbot-main's router of the same name;
 * the checks differ because what this app depends on differs.
 *
 * WHAT THIS IS FOR:
 * this service's work is a chain — Shopify webhook → Supabase row → Delhivery /
 * Ekart label → background sync — and every historical "why is nothing
 * updating?" investigation started by guessing which link broke. /ready names
 * the link. /health stays dumb: it answers whether the process can serve HTTP
 * and nothing else, so it can never be the thing that takes a healthy instance
 * out of rotation.
 *
 * MOUNTING:
 * before cors() and before apiLimiter in server.js. A rate-limited instance
 * still has to prove it is alive, and the readiness report (pool sizing, sync
 * staleness, memory headroom) has no business being readable from a browser
 * origin.
 *
 * COST, because /ready does reach the network here:
 * the Supabase probe is one head request with no rows, memoised for two seconds
 * so a dashboard polling at 1 Hz cannot multiply into provider traffic. Nothing
 * else in the shallow path allocates, connects, or takes a database connection —
 * including the Shopper Hub fallback pool, which is only probed under ?deep=1.
 */

const express = require('express');
const supabase = require('../../config/supabase');
const { getPoolStatus } = require('../../config/shopper-hub-db');
const report = require('../utils/healthReport');

// Supabase's client sets no timeout of its own (config/supabase.js), so the
// probe is bounded here instead — otherwise a stalled REST call turns a
// readiness answer into a hung request and a hung request into a false outage.
const SUPABASE_PROBE_TIMEOUT_MS = 2000;
// Long enough that a monitoring poller cannot stampede the provider, short
// enough that nobody ever sees a readiness answer more than two seconds old.
const SUPABASE_PROBE_CACHE_MS = 2000;
// Only used with ?deep=1: an actual round trip on the fallback pool.
const DEEP_QUERY_TIMEOUT_MS = 1500;
// How recently a query error has to be to still count as "happening now".
const RECENT_ERROR_WINDOW_MS = 60 * 1000;
// 'requests' is this app's core table — present in every working deployment,
// so a probe failure means the datastore is the problem, not the query.
const DEFAULT_PROBE_TABLE = 'requests';
// The background sync runs hourly (and 30s after boot), so an hour and a half
// of silence is a stuck job rather than a quiet moment.
const SYNC_STALE_MS = 90 * 60 * 1000;
// Grace for the first scheduled run, so a report from a just-started instance
// does not call an unstarted cron a stale one.
const SYNC_STARTUP_GRACE_MS = 3 * 60 * 1000;

function isRecent(timestampMs, nowMs) {
    return typeof timestampMs === 'number' && (nowMs - timestampMs) <= RECENT_ERROR_WINDOW_MS;
}

function ageOf(timestampMs, nowMs) {
    return typeof timestampMs === 'number' ? nowMs - timestampMs : null;
}

// --------------------------------------------------------------- checks -----

// Shallow Supabase probe: HEAD with a limit, no rows, no payload. Answers "can
// this process reach and authenticate against the datastore?" — which is the
// question the old absence of an endpoint left everyone to infer.
let probeCache = { at: 0, outcome: null, table: null };

async function supabaseCheck(deps = {}, nowMs = Date.now()) {
    const table = deps.probeTable || process.env.HEALTH_PROBE_TABLE || DEFAULT_PROBE_TABLE;
    const client = deps.supabaseClient || supabase;
    const cacheMs = typeof deps.probeCacheMs === 'number' ? deps.probeCacheMs : SUPABASE_PROBE_CACHE_MS;
    const timeoutMs = typeof deps.probeTimeoutMs === 'number' ? deps.probeTimeoutMs : SUPABASE_PROBE_TIMEOUT_MS;

    if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
        return report.check('unhealthy', 'SUPABASE_URL or a Supabase key is not configured — the datastore is unreachable by definition', { table });
    }

    if (cacheMs > 0 && probeCache.table === table && probeCache.outcome && (nowMs - probeCache.at) < cacheMs) {
        const cached = describeProbeOutcome(probeCache.outcome, table, timeoutMs);
        cached.cached = true;
        return cached;
    }

    const outcome = await report.runWithTimeout(async () => {
        // head:true asks PostgREST for the count header only; limit(1) keeps the
        // range tiny. No row data crosses the wire, so this costs the same
        // whether the table holds 50 rows or 500,000.
        const { count, error } = await client
            .from(table)
            .select('*', { head: true, count: 'exact' })
            .limit(1);
        if (error) {
            const wrapped = new Error(error.message || 'PostgREST error');
            wrapped.code = error.code;
            throw wrapped;
        }
        return count;
    }, timeoutMs);

    probeCache = { at: nowMs, outcome, table };
    return describeProbeOutcome(outcome, table, timeoutMs);
}

function describeProbeOutcome(outcome, table, timeoutMs) {
    const metrics = { table, durationMs: outcome.ms, timeoutMs, deep: false };
    if (outcome.ok) {
        return report.check('healthy', `PostgREST answered on ${table} in ${outcome.ms}ms (${timeoutMs}ms budget)`, metrics);
    }
    if (outcome.timedOut) {
        return report.check('unhealthy', `PostgREST did not answer for ${table} within ${timeoutMs}ms — the request is stalling, not failing`, metrics);
    }
    // A reachable REST layer that cannot find the probe table is a
    // misconfiguration of this check, not an outage. Degrading keeps the
    // instance in rotation while still putting the reason on screen.
    if (outcome.code === '42P01' || outcome.code === 'PGRST205' || /does not exist|relation|schema cache/i.test(outcome.error || '')) {
        return report.check('degraded', `PostgREST reachable but ${table} is not exposed: ${outcome.error}`, Object.assign(metrics, { probeCode: outcome.code || null }));
    }
    return report.check('unhealthy', `PostgREST error on ${table}: ${outcome.error}`, Object.assign(metrics, { probeCode: outcome.code || null }));
}

// The Shopper Hub pool is an optional read-replica of the bot's database. Three
// kinds of "no pool" have to be told apart, because only one of them is news.
function shoppersHubCheck(stats, nowMs) {
    if (stats.state === 'disabled') {
        return report.skipped('SHOPPERHUB_DB_URL not set — the custom-channel order fallback is off by design', stats);
    }
    if (stats.state === 'uninitialised') {
        return report.skipped('no fallback lookup has been attempted since boot', stats);
    }
    if (stats.state === 'failed') {
        return report.check('degraded', `pool could not be created: ${stats.failureReason}`, stats);
    }
    if (stats.waiting > 0) {
        return report.check('degraded', `${stats.waiting} lookup(s) queued for a connection (pool ${stats.inUse}/${stats.max} in use)`, stats);
    }
    if (isRecent(stats.lastQueryErrorAt, nowMs) && (stats.lastQueryAt === null || stats.lastQueryErrorAt > stats.lastQueryAt)) {
        return report.check('degraded', `fallback lookups failing: ${stats.lastQueryErrorMessage}`, stats);
    }
    if (isRecent(stats.lastPoolErrorAt, nowMs)) {
        return report.check('degraded', `idle connection dropped: ${stats.lastPoolErrorMessage}`, stats);
    }
    const activity = stats.lastQueryAgeMs === null
        ? 'no lookup since boot'
        : `last lookup ${Math.round(stats.lastQueryAgeMs / 1000)}s ago`;
    return report.check('healthy', `pool ${stats.inUse}/${stats.max} in use, ${activity}`, stats);
}

async function deepShoppersHubCheck(deps = {}) {
    const client = deps.shoppersHubQuery;
    if (typeof client !== 'function') {
        return report.skipped('no fallback pool to probe on this deployment');
    }
    const outcome = await report.runWithTimeout(client, DEEP_QUERY_TIMEOUT_MS);
    const metrics = { durationMs: outcome.ms, timeoutMs: DEEP_QUERY_TIMEOUT_MS };
    if (outcome.ok) {
        return report.check('healthy', `SELECT 1 round-tripped in ${outcome.ms}ms (1500ms budget)`, metrics);
    }
    if (outcome.timedOut) {
        return report.check('unhealthy', `SELECT 1 exceeded ${DEEP_QUERY_TIMEOUT_MS}ms — connections are acquired but never served`, metrics);
    }
    return report.check('unhealthy', `SELECT 1 failed: ${outcome.error}`, metrics);
}

// Background jobs are this service's actual product: a return request that
// never syncs is a customer who never gets a label. Staleness degrades the
// report rather than failing it — the HTTP surface still works, but nobody
// should call this instance healthy.
function syncCheck(state, opts, nowMs) {
    const label = opts.label;
    if (!state) {
        return report.skipped(`${label} state was not wired into this router`, {});
    }
    const metrics = {
        running: Boolean(state.running),
        lastRunAt: state.lastRunAt || null,
        lastRunAgeMs: state.lastRunAt ? nowMs - Date.parse(state.lastRunAt) : null,
        staleAfterMs: opts.staleMs
    };
    if (metrics.lastRunAgeMs !== null && Number.isNaN(metrics.lastRunAgeMs)) {
        return report.check('degraded', `${label} reported an unreadable timestamp: ${state.lastRunAt}`, metrics);
    }
    if (metrics.lastRunAt === null) {
        if (process.uptime() * 1000 < SYNC_STARTUP_GRACE_MS) {
            return report.check('healthy', `${label} has not needed to run yet (first run is scheduled after boot)`, metrics);
        }
        return report.check('degraded', `${label} has never run since boot`, metrics);
    }
    if (metrics.running) {
        return report.check('healthy', `${label} in progress, last completed run ${Math.round(metrics.lastRunAgeMs / 60000)}m ago`, metrics);
    }
    if (metrics.lastRunAgeMs > opts.staleMs) {
        const hours = Math.round(metrics.lastRunAgeMs / 3600000 * 10) / 10;
        return report.check('degraded', `${label} has not completed a run in ${hours}h (expected within ${Math.round(opts.staleMs / 60000)}m)`, metrics);
    }
    return report.check('healthy', `${label} last completed ${Math.round(metrics.lastRunAgeMs / 60000)}m ago`, metrics);
}

// --------------------------------------------------------------- router -----

function createHealthRouter(deps = {}) {
    const version = deps.version || 'unknown';
    const router = express.Router();

    const authorize = deps.authorize || report.createReadinessAuth({
        getInternalToken: deps.getInternalToken || (() => process.env.WHATSAPP_INTERNAL_TOKEN),
        authenticate: deps.authenticate
    });

    router.get('/health', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(report.livenessEnvelope({ version }));
    });

    router.get('/ready', authorize, async (req, res) => {
        const nowMs = Date.now();
        const deep = req.query.deep === '1' || req.query.deep === 'true';
        const checks = {};

        try {
            // Awaited first because it is the only shallow check that can be
            // slow, and its 2s ceiling is what bounds the whole response.
            checks.database = await supabaseCheck(deps, nowMs);
            checks.shoppersHubDb = shoppersHubCheck(getPoolStatus(), nowMs);
            checks.backgroundSync = syncCheck(
                typeof deps.getSyncState === 'function' ? deps.getSyncState() : null,
                { label: 'background sync', staleMs: deps.syncStaleMs || SYNC_STALE_MS },
                nowMs
            );
            checks.shopifySync = syncCheck(
                typeof deps.getShopifySyncState === 'function' ? deps.getShopifySyncState() : null,
                { label: 'Shopify usage sync', staleMs: deps.shopifySyncStaleMs || SYNC_STALE_MS },
                nowMs
            );
            checks.memory = report.memoryCheck({ rssLimitMB: deps.rssLimitMB || 512 });
            checks.eventLoop = report.eventLoopCheck();

            if (deep) {
                checks.shoppersHubQuery = await deepShoppersHubCheck(deps);
            }
        } catch (e) {
            // A throwing check must never become an unexplained 500, and the
            // message must never carry a stack or a connection string.
            const reason = String((e && e.message) ? e.message : e).slice(0, 200);
            checks.collection = report.check('unhealthy', `readiness checks failed: ${reason}`);
        }

        const status = report.worstStatus(checks);
        const envelope = report.buildEnvelope({ version, status, checks });
        envelope.deep = deep;

        res.status(report.statusToHttpStatus(status)).set('Cache-Control', 'no-store').json(envelope);
    });

    return router;
}

// Test seam: the memoised probe would otherwise make check order significant.
function resetProbeCache() {
    probeCache = { at: 0, outcome: null, table: null };
}

module.exports = {
    createHealthRouter,
    supabaseCheck,
    describeProbeOutcome,
    shoppersHubCheck,
    deepShoppersHubCheck,
    syncCheck,
    resetProbeCache,
    SUPABASE_PROBE_TIMEOUT_MS,
    DEEP_QUERY_TIMEOUT_MS,
    DEFAULT_PROBE_TABLE
};
