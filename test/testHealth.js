/**
 * Standalone test for the health/readiness endpoints (Phase 1 §C3).
 * Run: node test/testHealth.js
 *
 * NO NETWORK, NO CREDENTIALS, NO DATABASE.
 * This file never calls dotenv, so process.env.SUPABASE_URL is unset here and
 * config/supabase.js builds its placeholder client — nothing can reach
 * production. Every datastore assertion runs against an injected fake PostgREST
 * client that records exactly what was asked of it, which is also the only way
 * to drive the interesting cases on demand: a stalled REST call, a missing
 * relation, an expired key.
 *
 * WHAT THIS PROVES:
 *   1. /health answers in well under 20 ms from a process that can reach
 *      nothing, and 25 polls take no connection from the fallback pool.
 *   2. /ready is unreadable unauthenticated and unreadable cross-origin, and it
 *      fails closed when no internal token is configured.
 *   3. The probe really is head + limit(1) — an endpoint that quietly starts
 *      fetching rows would pass every status assertion below and still take the
 *      service down under polling, so the request shape is asserted, not assumed.
 *   4. The 2 s ceiling bounds the response even when the provider stalls, and
 *      the memo keeps a 1 Hz poller from becoming 1 Hz of provider traffic.
 *   5. Each status in the report is a pure function of a stats object, so the
 *      whole healthy/degraded/unhealthy matrix is driven directly — including
 *      the "optional database deliberately off" case that must read as skipped
 *      and not as an outage.
 *
 * Reporting uses process.stdout.write only, never console.*.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const report = require('../src/utils/healthReport');
const {
    createHealthRouter,
    supabaseCheck,
    describeProbeOutcome,
    shoppersHubCheck,
    syncCheck,
    resetProbeCache,
    SUPABASE_PROBE_TIMEOUT_MS,
    DEEP_QUERY_TIMEOUT_MS
} = require('../src/routes/healthRoutes');
const { getPoolStatus } = require('../config/shopper-hub-db');

const say = (line) => process.stdout.write(`${line}\n`);

let passed = 0;
let failed = 0;
const queue = [];

function check(name, fn) {
    queue.push({ name, fn });
}

async function run() {
    for (const item of queue) {
        try {
            await item.fn();
            passed++;
            say(`PASS  ${item.name}`);
        } catch (err) {
            failed++;
            say(`FAIL  ${item.name}`);
            say(`      ${err.message}`);
        }
    }
    say('');
    say(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

// ─── harness ───────────────────────────────────────────────────────────────

const TEST_TOKEN = 'phase1-c3-internal-token';
const VERSION = require('../package.json').version;

// A PostgREST double that records what the probe actually asked for.
function fakeClient(behavior) {
    const state = { calls: 0, selectArgs: null, selectOpts: null, limit: null, table: null };
    return {
        state,
        from(table) {
            state.table = table;
            return {
                select(columns, options) {
                    state.selectArgs = columns;
                    state.selectOpts = options;
                    return {
                        limit(n) {
                            state.calls++;
                            state.limit = n;
                            if (behavior === 'stall') return new Promise(() => { });
                            if (behavior === 'throw') return Promise.reject(new Error('socket hang up'));
                            if (behavior === 'missing-table') {
                                const err = new Error('relation "requests" does not exist');
                                err.code = '42P01';
                                return Promise.reject(err);
                            }
                            if (behavior === 'rest-error') {
                                return Promise.resolve({ count: null, error: { message: 'JWSError JWSInvalidSignature', code: 'PGRST301' } });
                            }
                            return Promise.resolve({ count: 4210, error: null });
                        }
                    };
                }
            };
        }
    };
}

// Mirrors server.js: mounted before cors(), which is what stops a browser on
// another origin from reading /ready.
function buildApp(deps = {}) {
    const app = express();
    app.use(createHealthRouter(Object.assign({
        version: VERSION,
        rssLimitMB: 512,
        getInternalToken: () => TEST_TOKEN,
        authenticate: (req, res, next) => res.status(401).json({ error: 'JWT path reached' }),
        supabaseClient: fakeClient('ok'),
        probeCacheMs: 0,
        getSyncState: () => ({ running: false, lastRunAt: new Date(Date.now() - 60000).toISOString() }),
        getShopifySyncState: () => ({ running: false, lastRunAt: new Date(Date.now() - 60000).toISOString() })
    }, deps)));
    app.use((req, res) => res.status(404).json({ error: 'not found' }));
    return app;
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function requestOnce(server, path, opts = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = process.hrtime.bigint();
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path,
            method: 'GET',
            headers: opts.headers || {},
            agent: false
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try { body = JSON.parse(raw); } catch (e) { body = raw; }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body,
                    raw,
                    ms: Number(process.hrtime.bigint() - startedAt) / 1e6
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

const authedHeaders = { 'x-internal-token': TEST_TOKEN };

// supabaseCheck reads these; the fake client keeps them off the network.
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'HEALTH_PROBE_TABLE', 'SHOPPERHUB_DB_URL'];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

function useFakeDatastore() {
    resetProbeCache();
    process.env.SUPABASE_URL = 'https://fake.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
}

function restoreDatastoreEnv() {
    resetProbeCache();
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
}

// ─── /health — liveness ────────────────────────────────────────────────────

check('/health answers 200 with the four liveness fields', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/health');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.match(res.body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
        assert.strictEqual(res.body.version, VERSION);
        assert.ok(Number.isFinite(res.body.uptimeSec) && res.body.uptimeSec >= 0);
        assert.deepStrictEqual(Object.keys(res.body).sort(), ['status', 'timestamp', 'uptimeSec', 'version']);
        assert.strictEqual(res.headers['cache-control'], 'no-store');
    } finally {
        await close(server);
    }
});

check('/health needs no credentials', async () => {
    const server = await listen(buildApp());
    try {
        assert.strictEqual((await requestOnce(server, '/health')).status, 200);
    } finally {
        await close(server);
    }
});

check('/health answers in under 20 ms with no datastore and no pool', async () => {
    // No SUPABASE_URL, no SHOPPERHUB_DB_URL, nothing reachable — the C3 gate's
    // "dead-pool instance still answers /health <20 ms".
    const server = await listen(buildApp());
    try {
        await requestOnce(server, '/health');
        const samples = [];
        for (let i = 0; i < 20; i++) samples.push((await requestOnce(server, '/health')).ms);
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        assert.ok(median < 20, `median ${median.toFixed(2)}ms is not under 20ms`);
    } finally {
        await close(server);
    }
});

check('polling /health 25x never touches the fallback pool', async () => {
    const before = getPoolStatus();
    const server = await listen(buildApp());
    try {
        for (let i = 0; i < 25; i++) await requestOnce(server, '/health');
    } finally {
        await close(server);
    }
    const after = getPoolStatus();
    assert.strictEqual(after.queryCount, before.queryCount, 'liveness ran a query');
    assert.strictEqual(after.total || 0, before.total || 0, 'liveness opened a connection');
});

check('no CORS header on /health or /ready — mounted before cors()', async () => {
    const server = await listen(buildApp());
    try {
        const health = await requestOnce(server, '/health', { headers: { origin: 'https://evil.example' } });
        const ready = await requestOnce(server, '/ready', { headers: { origin: 'https://evil.example', ...authedHeaders } });
        assert.ok(!health.headers['access-control-allow-origin'], 'liveness must not be CORS-readable');
        assert.ok(!ready.headers['access-control-allow-origin'], '/ready must not be CORS-readable');
    } finally {
        await close(server);
    }
});

// ─── /ready — authentication ───────────────────────────────────────────────

check('/ready 401s with no credentials', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready');
        assert.strictEqual(res.status, 401);
        assert.ok(!res.body.checks, 'an unauthenticated response must not contain checks');
    } finally {
        await close(server);
    }
});

check('/ready 401s on a wrong internal token', async () => {
    const server = await listen(buildApp());
    try {
        assert.strictEqual((await requestOnce(server, '/ready', { headers: { 'x-internal-token': 'nope' } })).status, 401);
    } finally {
        await close(server);
    }
});

check('/ready fails closed when no internal token is configured', async () => {
    const server = await listen(buildApp({ getInternalToken: () => undefined }));
    try {
        const res = await requestOnce(server, '/ready', { headers: { 'x-internal-token': '' } });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error, 'JWT path reached', 'must fall through to the JWT gate, never allow');
    } finally {
        await close(server);
    }
});

check('/ready takes the internal token ahead of authenticateAdmin', async () => {
    // authenticateAdmin resolves operators through the datastore, so an
    // internal caller must never depend on it: this app has no Supabase
    // configured at all and still answers with the internal token.
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        assert.notStrictEqual(res.body.error, 'JWT path reached');
        assert.ok(res.body.checks);
    } finally {
        await close(server);
    }
});

check('/ready hands browser sessions to authenticateAdmin', async () => {
    const server = await listen(buildApp({
        authenticate: (req, res, next) => res.status(401).json({ error: 'Invalid or expired token' })
    }));
    try {
        const res = await requestOnce(server, '/ready');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error, 'Invalid or expired token');
    } finally {
        await close(server);
    }
});

// ─── /ready — the datastore probe ──────────────────────────────────────────

check('/ready reports the six checks and no deep probe', async () => {
    useFakeDatastore();
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        for (const name of ['database', 'shoppersHubDb', 'backgroundSync', 'shopifySync', 'memory', 'eventLoop']) {
            assert.ok(res.body.checks[name], `missing check: ${name}`);
        }
        assert.ok(!res.body.checks.shoppersHubQuery, 'the deep probe must not run unasked');
        assert.strictEqual(res.body.deep, false);
        assert.strictEqual(res.body.status, 'healthy');
        assert.strictEqual(res.status, 200);
        for (const [name, entry] of Object.entries(res.body.checks)) {
            assert.ok(['healthy', 'degraded', 'unhealthy', 'skipped'].includes(entry.status), `${name}: bad status`);
            assert.ok(typeof entry.detail === 'string' && entry.detail.length > 0, `${name}: bad detail`);
        }
    } finally {
        restoreDatastoreEnv();
        await close(server);
    }
});

check('the probe is head + limit(1) — it must not fetch rows', async () => {
    useFakeDatastore();
    const client = fakeClient('ok');
    const out = await supabaseCheck({ supabaseClient: client, probeCacheMs: 0 });
    assert.strictEqual(out.status, 'healthy');
    assert.strictEqual(client.state.selectOpts.head, true, 'probe must ask for no body');
    assert.strictEqual(client.state.selectOpts.count, 'exact');
    assert.strictEqual(client.state.limit, 1, 'probe must be range-bounded');
    assert.strictEqual(client.state.table, 'requests', 'default probe table is this app\'s core table');
    restoreDatastoreEnv();
});

check('the probe table can be overridden without a code change', async () => {
    useFakeDatastore();
    process.env.HEALTH_PROBE_TABLE = 'influencer_orders';
    const client = fakeClient('ok');
    await supabaseCheck({ supabaseClient: client, probeCacheMs: 0 });
    assert.strictEqual(client.state.table, 'influencer_orders');
    restoreDatastoreEnv();
});

check('a stalled provider is bounded by the 2s ceiling, not by patience', async () => {
    useFakeDatastore();
    const client = fakeClient('stall');
    const startedAt = Date.now();
    const out = await supabaseCheck({ supabaseClient: client, probeCacheMs: 0, probeTimeoutMs: 150 });
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(out.status, 'unhealthy');
    assert.match(out.detail, /did not answer for requests within 150ms/);
    assert.ok(elapsed < 600, `probe gave up after ${elapsed}ms`);
    assert.strictEqual(client.state.calls, 1);
    restoreDatastoreEnv();
});

check('/ready answers 503 while the provider stalls', async () => {
    useFakeDatastore();
    const server = await listen(buildApp({
        supabaseClient: fakeClient('stall'),
        probeCacheMs: 0,
        probeTimeoutMs: 200
    }));
    const startedAt = Date.now();
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        assert.ok(Date.now() - startedAt < 1500, '/ready hung instead of reporting');
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.status, 'unhealthy');
        assert.strictEqual(res.body.checks.database.status, 'unhealthy');
        // The other checks must still be reported: one dead dependency is not
        // an excuse to stop answering the questions that were answerable.
        assert.ok(res.body.checks.memory && res.body.checks.eventLoop);
    } finally {
        restoreDatastoreEnv();
        await close(server);
    }
});

check('the probe is memoised so a poller cannot stampede the provider', async () => {
    useFakeDatastore();
    const client = fakeClient('ok');
    const deps = { supabaseClient: client, probeCacheMs: 2000 };
    await supabaseCheck(deps);
    const second = await supabaseCheck(deps);
    assert.strictEqual(client.state.calls, 1, 'two back-to-back readiness calls hit the provider twice');
    assert.strictEqual(second.cached, true);
    // ...and a zero budget disables it, which is what the other tests rely on.
    await supabaseCheck({ supabaseClient: client, probeCacheMs: 0 });
    assert.strictEqual(client.state.calls, 2);
    restoreDatastoreEnv();
});

check('missing credentials is unhealthy by definition, without a request', async () => {
    restoreDatastoreEnv();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    const client = fakeClient('ok');
    const out = await supabaseCheck({ supabaseClient: client, probeCacheMs: 0 });
    assert.strictEqual(out.status, 'unhealthy');
    assert.match(out.detail, /not configured/);
    assert.strictEqual(client.state.calls, 0, 'must not try the network when it already knows');
    restoreDatastoreEnv();
});

check('describeProbeOutcome: reachable-but-unexposed table degrades instead of failing', () => {
    const missing = describeProbeOutcome(
        { ok: false, ms: 40, error: 'relation "nope" does not exist', code: '42P01', timedOut: false }, 'nope', 2000);
    assert.strictEqual(missing.status, 'degraded');
    const schemaCache = describeProbeOutcome(
        { ok: false, ms: 40, error: 'Could not find the table in the schema cache', code: 'PGRST205', timedOut: false }, 'nope', 2000);
    assert.strictEqual(schemaCache.status, 'degraded');
    const auth = describeProbeOutcome(
        { ok: false, ms: 40, error: 'JWSError JWSInvalidSignature', code: 'PGRST301', timedOut: false }, 'requests', 2000);
    assert.strictEqual(auth.status, 'unhealthy', 'a rejected key is an outage, not a typo');
    const stalled = describeProbeOutcome({ ok: false, ms: 2000, error: 'timed out after 2000ms', timedOut: true }, 'requests', 2000);
    assert.strictEqual(stalled.status, 'unhealthy');
    assert.strictEqual(describeProbeOutcome({ ok: true, ms: 12, value: 5, timedOut: false }, 'requests', 2000).status, 'healthy');
});

check('a rest error is surfaced with its message, never its key', async () => {
    useFakeDatastore();
    const out = await supabaseCheck({ supabaseClient: fakeClient('rest-error'), probeCacheMs: 0 });
    assert.strictEqual(out.status, 'unhealthy');
    assert.match(out.detail, /JWSError JWSInvalidSignature/);
    assert.ok(!out.detail.includes('fake-service-role-key'));
    restoreDatastoreEnv();
});

check('/ready leaks no key, no token, no connection string, no stack', async () => {
    useFakeDatastore();
    const server = await listen(buildApp({ supabaseClient: fakeClient('throw'), probeCacheMs: 0 }));
    try {
        const res = await requestOnce(server, '/ready?deep=1', { headers: authedHeaders });
        assert.ok(!res.raw.includes(TEST_TOKEN));
        assert.ok(!res.raw.includes('fake-service-role-key'));
        assert.ok(!/postgres(ql)?:\/\//i.test(res.raw));
        assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(res.raw), 'a JWT appeared in the body');
    } finally {
        restoreDatastoreEnv();
        await close(server);
    }
});

// ─── /ready — the optional fallback pool ───────────────────────────────────

check('?deep=1 probes the fallback pool and says so when it is off', async () => {
    useFakeDatastore();
    const server = await listen(buildApp({
        supabaseClient: fakeClient('ok'),
        probeCacheMs: 0,
        shoppersHubQuery: () => Promise.reject(new Error('SHOPPERHUB_DB_URL is not configured'))
    }));
    try {
        const res = await requestOnce(server, '/ready?deep=1', { headers: authedHeaders });
        assert.strictEqual(res.body.deep, true);
        const probe = res.body.checks.shoppersHubQuery;
        assert.ok(probe, 'deep report must contain shoppersHubQuery');
        assert.strictEqual(probe.status, 'unhealthy');
        assert.match(probe.detail, /SHOPPERHUB_DB_URL is not configured/);
        assert.ok(probe.durationMs <= DEEP_QUERY_TIMEOUT_MS + 400, `probe took ${probe.durationMs}ms`);
    } finally {
        restoreDatastoreEnv();
        await close(server);
    }
});

check('deep probe timing out is reported, not hung', async () => {
    const startedAt = Date.now();
    const server = await listen(buildApp({
        supabaseClient: fakeClient('ok'),
        probeCacheMs: 0,
        shoppersHubQuery: () => new Promise(() => { })
    }));
    try {
        const res = await requestOnce(server, '/ready?deep=1', { headers: authedHeaders });
        assert.ok(Date.now() - startedAt < DEEP_QUERY_TIMEOUT_MS + 1200, 'the deep guard did not fire');
        assert.match(res.body.checks.shoppersHubQuery.detail, /exceeded 1500ms/);
    } finally {
        await close(server);
    }
});

const LIVE_HUB = {
    state: 'live', configured: true, total: 1, idle: 0, inUse: 1, waiting: 0, max: 2,
    queryCount: 9, queryErrorCount: 0, lastQueryAt: 1000, lastQueryAgeMs: 500, lastQueryMs: 22,
    lastQueryErrorAt: null, lastQueryErrorMessage: null, poolErrorCount: 0,
    lastPoolErrorAt: null, lastPoolErrorMessage: null, failureReason: null
};

check('shoppersHubCheck: an intentionally disabled fallback is skipped', () => {
    const off = shoppersHubCheck(Object.assign({}, LIVE_HUB, { state: 'disabled', configured: false }), 2000);
    assert.strictEqual(off.status, 'skipped');
    assert.strictEqual(report.worstStatus({ shoppersHubDb: off }), 'healthy', 'being off must not look like an outage');
    const untouched = shoppersHubCheck(Object.assign({}, LIVE_HUB, { state: 'uninitialised' }), 2000);
    assert.strictEqual(untouched.status, 'skipped');
});

check('shoppersHubCheck: a broken pool construction degrades, still not fatal', () => {
    const out = shoppersHubCheck(Object.assign({}, LIVE_HUB, { state: 'failed', failureReason: "Cannot find module 'pg'" }), 2000);
    assert.strictEqual(out.status, 'degraded');
    assert.match(out.detail, /pool could not be created/);
});

check('shoppersHubCheck: live pool states — healthy, queued, failing, recently dropped', () => {
    assert.strictEqual(shoppersHubCheck(LIVE_HUB, 2000).status, 'healthy');
    assert.strictEqual(shoppersHubCheck(Object.assign({}, LIVE_HUB, { waiting: 2 }), 2000).status, 'degraded');
    assert.strictEqual(shoppersHubCheck(Object.assign({}, LIVE_HUB, {
        lastQueryErrorAt: 1900, lastQueryErrorMessage: 'connection terminated'
    }), 2000).status, 'degraded');
    assert.strictEqual(shoppersHubCheck(Object.assign({}, LIVE_HUB, {
        lastPoolErrorAt: 1900, lastPoolErrorMessage: 'connection reset'
    }), 2000).status, 'degraded');
    // An error older than the window has stopped being news.
    assert.strictEqual(shoppersHubCheck(Object.assign({}, LIVE_HUB, {
        lastQueryErrorAt: 2000 - 10 * 60 * 1000, lastQueryErrorMessage: 'connection terminated'
    }), 2000).status, 'healthy');
});

// ─── sync staleness ────────────────────────────────────────────────────────

function minutesAgo(mins) {
    return new Date(Date.now() - mins * 60000).toISOString();
}

check('syncCheck: a recent completed run is healthy', () => {
    const out = syncCheck({ running: false, lastRunAt: minutesAgo(6) }, { label: 'background sync', staleMs: 90 * 60 * 1000 }, Date.now());
    assert.strictEqual(out.status, 'healthy');
    assert.match(out.detail, /last completed 6m ago/);
});

check('syncCheck: past the expected cadence is degraded, not down', () => {
    // The HTTP surface still works when a cron is stuck, so the instance stays
    // in rotation — but nobody should read this report as healthy.
    const out = syncCheck({ running: false, lastRunAt: minutesAgo(200) }, { label: 'background sync', staleMs: 90 * 60 * 1000 }, Date.now());
    assert.strictEqual(out.status, 'degraded');
    assert.match(out.detail, /3\.3h/);
    assert.strictEqual(report.statusToHttpStatus(report.worstStatus({ s: out })), 200);
});

check('syncCheck: a run in progress is healthy and says so', () => {
    const out = syncCheck({ running: true, lastRunAt: minutesAgo(61) }, { label: 'shopify sync', staleMs: 90 * 60 * 1000 }, Date.now());
    assert.strictEqual(out.status, 'healthy');
    assert.match(out.detail, /in progress/);
    assert.strictEqual(out.running, true);
});

check('syncCheck: never having run depends on how long we have been up', () => {
    const realUptime = process.uptime;
    try {
        process.uptime = () => 20; // inside the first-run grace window
        const fresh = syncCheck({ running: false, lastRunAt: null }, { label: 'background sync', staleMs: 90 * 60 * 1000 }, Date.now());
        assert.strictEqual(fresh.status, 'healthy');
        assert.match(fresh.detail, /has not needed to run yet/);

        process.uptime = () => 4 * 3600;
        const neglected = syncCheck({ running: false, lastRunAt: null }, { label: 'background sync', staleMs: 90 * 60 * 1000 }, Date.now());
        assert.strictEqual(neglected.status, 'degraded');
        assert.match(neglected.detail, /never run since boot/);
    } finally {
        process.uptime = realUptime;
    }
});

check('syncCheck: an unwired job is skipped and an unreadable one degrades', () => {
    assert.strictEqual(syncCheck(null, { label: 'background sync', staleMs: 1 }, Date.now()).status, 'skipped');
    const junk = syncCheck({ running: false, lastRunAt: 'yesterday' }, { label: 'background sync', staleMs: 1 }, Date.now());
    assert.strictEqual(junk.status, 'degraded');
    assert.match(junk.detail, /unreadable timestamp/);
});

// ─── report primitives (shared with whatsappbot) ───────────────────────────

check('worstStatus: the worst check wins and skipped never counts', () => {
    assert.strictEqual(report.worstStatus({}), 'healthy');
    assert.strictEqual(report.worstStatus({
        a: report.healthy('ok'), b: report.skipped('n/a'), c: report.degraded('meh')
    }), 'degraded');
    assert.strictEqual(report.worstStatus({
        a: report.healthy('ok'), b: report.unhealthy('down'), c: report.degraded('meh')
    }), 'unhealthy');
});

check('check: an unknown status degrades instead of disappearing', () => {
    const out = report.check('purple', 'x', { n: 1 });
    assert.strictEqual(out.status, 'degraded');
    assert.strictEqual(out.n, 1);
});

check('statusToHttpStatus: degraded stays in rotation, unhealthy does not', () => {
    assert.strictEqual(report.statusToHttpStatus('healthy'), 200);
    assert.strictEqual(report.statusToHttpStatus('degraded'), 200);
    assert.strictEqual(report.statusToHttpStatus('unhealthy'), 503);
});

check('memoryCheck: reports the native-memory fields and both ceilings', () => {
    const out = report.memoryCheck({ rssLimitMB: 512 });
    for (const key of ['rssMB', 'heapUsedMB', 'heapLimitMB', 'externalMB', 'arrayBuffersMB', 'nativeMB', 'usagePercent']) {
        assert.ok(key in out, `missing ${key}`);
    }
    assert.strictEqual(out.status, 'healthy', 'a fresh test process is not near its ceiling');
    const noRss = report.memoryCheck({});
    assert.strictEqual(noRss.rssLimitMB, null);
    assert.ok(noRss.heapLimitMB > 0);
});

check('heapLimitBytes: works on runtimes without v8.getHeapMemoryLimit()', () => {
    const v8 = require('v8');
    const bytes = report.heapLimitBytes();
    assert.ok(bytes > 0);
    if (typeof v8.getHeapMemoryLimit !== 'function') {
        assert.strictEqual(bytes, v8.getHeapStatistics().heap_size_limit);
    }
});

check('runWithTimeout: resolves, rejects and times out — always as a result', async () => {
    const good = await report.runWithTimeout(() => Promise.resolve('v'), 500);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.value, 'v');
    const bad = await report.runWithTimeout(() => Promise.reject(new Error('nope')), 500);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'nope');
    const slow = await report.runWithTimeout(() => new Promise(() => { }), 120);
    assert.strictEqual(slow.timedOut, true);
    assert.match(slow.error, /timed out after 120ms/);
    const thrown = await report.runWithTimeout(() => { throw new Error('sync boom'); }, 500);
    assert.strictEqual(thrown.error, 'sync boom');
});

check('the guard keeps a stalled probe alive to report it, not to exit quietly', async () => {
    // Regression, found by this suite exiting 0 halfway through: the guard
    // timer was originally unref()'d, so with nothing else holding the loop
    // open Node ended the process instead of firing the timeout. In the server
    // an in-flight request keeps a handle alive so it appeared to work; the
    // ceiling was still only as reliable as the traffic around it — and this
    // app's whole reason for having a ceiling is a Supabase call that stalls.
    const script = `
        const report = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'utils', 'healthReport.js'))});
        report.runWithTimeout(() => new Promise(() => { }), 150).then((out) => {
            process.stdout.write(out.timedOut ? 'REPORTED' : 'NOT_REPORTED');
        });
    `;
    const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
    let captured = '';
    child.stdout.on('data', (chunk) => { captured += chunk; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.strictEqual(code, 0, 'the guard process should finish cleanly');
    assert.strictEqual(captured, 'REPORTED', 'a stalled probe ended the process before it could be reported');
});

check('eventLoopCheck: healthy now, degraded then unhealthy as the tick ages', () => {
    report.startHeartbeat();
    assert.strictEqual(report.eventLoopCheck().status, 'healthy');
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 60000;
        assert.match(report.eventLoopCheck().detail, /event loop blocked/);
        Date.now = () => realNow() + 14000;
        assert.strictEqual(report.eventLoopCheck().status, 'degraded');
    } finally {
        Date.now = realNow;
    }
    assert.strictEqual(report.eventLoopCheck().status, 'healthy', 'Date.now must be restored');
});

check('tokenMatches: exact, constant-time, and closed when unconfigured', () => {
    assert.strictEqual(report.tokenMatches('abc', 'abc'), true);
    assert.strictEqual(report.tokenMatches('abd', 'abc'), false);
    assert.strictEqual(report.tokenMatches('abcdef', 'abc'), false, 'length must not leak');
    assert.strictEqual(report.tokenMatches(undefined, 'abc'), false);
    assert.strictEqual(report.tokenMatches('', ''), false, 'an unconfigured secret must not match anything');
    assert.strictEqual(report.tokenMatches(123, '123'), true);
});

check('createReadinessAuth: marks service callers and delegates everyone else', () => {
    const auth = report.createReadinessAuth({
        getInternalToken: () => 's3cret',
        authenticate: (req, res, next) => { req.viaJwt = true; next(); }
    });
    let reached = null;
    const res = { status() { return this; }, json() { return this; } };
    auth({ headers: { 'x-internal-token': 's3cret' } }, res, () => { reached = 'internal'; });
    assert.strictEqual(reached, 'internal');
    auth({ headers: { authorization: 'Bearer x' } }, res, () => { reached = 'jwt'; });
    assert.strictEqual(reached, 'jwt');
    let code = null;
    report.createReadinessAuth({ getInternalToken: () => 's3cret' })(
        { headers: {} },
        { status: (c) => { code = c; return { json: () => { } }; } },
        () => { reached = 'leak'; }
    );
    assert.strictEqual(code, 401);
    assert.strictEqual(reached, 'jwt', 'bare auth must not call next()');
});

check('buildEnvelope: same contract as the bot, so one reader fits both apps', () => {
    const out = report.buildEnvelope({ version: '1.2.3', checks: { a: report.healthy('x') } });
    assert.deepStrictEqual(Object.keys(out), ['status', 'version', 'node', 'uptimeSec', 'startedAt', 'checkedAt', 'checks']);
    assert.strictEqual(out.status, 'healthy');
    assert.ok(Math.abs((Date.now() - new Date(out.startedAt).getTime()) - out.uptimeSec * 1000) < 2000);
    assert.deepStrictEqual(Object.keys(report.livenessEnvelope({ version: 'x' })).sort(), ['status', 'timestamp', 'uptimeSec', 'version']);
});

check('the probe budget is the 2s the plan asks for', () => {
    assert.strictEqual(SUPABASE_PROBE_TIMEOUT_MS, 2000);
    assert.strictEqual(DEEP_QUERY_TIMEOUT_MS, 1500);
});

run();
