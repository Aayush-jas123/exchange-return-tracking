/**
 * healthReport.js — the /health and /ready response contract (Phase 1 §B6).
 * Kept byte-for-byte identical in whatsappbot-main and exchange-return-tracking-main.
 *
 * WHY THIS IS SHARED:
 * The two services are one system — the returns app calls the bot over
 * x-internal-token and vice versa. If each invents its own health payload then
 * every future probe, dashboard and runbook needs two dialects, and "is the
 * system up?" stops being answerable with one glance. Only the ENVELOPE and the
 * primitives are shared here; the checks themselves live in each app's router,
 * because the things worth probing are genuinely different (a pg pool over here,
 * a Supabase REST client over there).
 *
 * THE CONTRACT:
 *   /health   public, constant cost, never touches the network or the database.
 *             Keeps the fields the existing stub already returned (`status: 'ok'`,
 *             `timestamp`) so nothing already polling it has to change.
 *   /ready    authenticated, runs the app's checks, answers
 *               { status, version, node, uptimeSec, startedAt, checkedAt, checks }
 *             with status ∈ healthy | degraded | unhealthy and one entry per
 *             check. HTTP 200 for healthy/degraded, 503 for unhealthy — a
 *             degraded instance is still serving traffic and must not be pulled
 *             out of rotation, only an unhealthy one.
 *
 * ONE RULE THAT MAKES THIS SAFE TO POLL:
 * nothing in here may allocate, connect or block. Every check reads a counter
 * that already exists. The single exception is the opt-in deep database probe,
 * which is time-boxed by runWithTimeout() so a wedged connection pool cannot
 * turn a readiness check into a hung request.
 */

const crypto = require('crypto');
const v8 = require('v8');

// Ranking is what makes aggregation a one-liner: /ready reports the worst
// check it saw. `skipped` is below `healthy` on purpose — a check that does not
// apply to this deployment (an unconfigured optional database, say) must never
// make the report look worse than it is.
const SEVERITY = { skipped: -1, healthy: 0, degraded: 1, unhealthy: 2 };

// Liveness of the event loop, measured without touching Node's internals: a
// 5s timer can only fire when the loop is free, so the age of its last firing
// IS the "is this process wedged?" signal. Thresholds are multiples of the
// interval because a busy-but-healthy loop legitimately delays a timer by one
// or two ticks; several intervals of silence means the loop is blocked.
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_DEGRADED_TICKS = 2;
const HEARTBEAT_UNHEALTHY_TICKS = 6;

// Memory thresholds, as a fraction of whichever budget is tighter — the
// container's RSS ceiling or V8's heap limit. The bot has been OOM-killed at
// Render's 512MB ceiling repeatedly, so headroom is the number that matters.
const MEMORY_DEGRADED_RATIO = 0.75;
const MEMORY_UNHEALTHY_RATIO = 0.90;

function mb(bytes) {
    return Math.round((Number(bytes) || 0) / 1048576 * 10) / 10;
}

// One entry in the checks{} map: a status, a one-line human answer, and the
// raw numbers for whoever graphs this. Detail text must never contain a
// credential or a customer value — it is built from counters and err.message
// only, and the log shim redacts it again on the way out if it is ever echoed.
function check(status, detail, metrics) {
    const result = {
        status: Object.prototype.hasOwnProperty.call(SEVERITY, status) ? status : 'degraded',
        detail: String(detail == null ? '' : detail)
    };
    if (metrics && typeof metrics === 'object') Object.assign(result, metrics);
    return result;
}

function healthy(detail, metrics) { return check('healthy', detail, metrics); }
function degraded(detail, metrics) { return check('degraded', detail, metrics); }
function unhealthy(detail, metrics) { return check('unhealthy', detail, metrics); }
function skipped(detail, metrics) { return check('skipped', detail, metrics); }

// Worst status wins, and the empty case is healthy: an app that has registered
// no checks is not an app that is down.
function worstStatus(checks) {
    let worst = 'healthy';
    for (const entry of Object.values(checks || {})) {
        const status = entry && entry.status;
        if (SEVERITY[status] === undefined) continue;
        if (SEVERITY[status] > SEVERITY[worst]) worst = status;
    }
    return worst;
}

function statusToHttpStatus(status) {
    return status === 'unhealthy' ? 503 : 200;
}

// process.uptime() is the truth about when the process began; everything else
// (module load order, deferred listen) only shifts when we *notice*.
function uptimeSec() {
    return Math.round(process.uptime());
}

function buildEnvelope(opts = {}) {
    const checks = opts.checks || {};
    const status = opts.status || worstStatus(checks);
    const up = uptimeSec();
    return {
        status,
        version: opts.version || 'unknown',
        node: process.version,
        uptimeSec: up,
        startedAt: new Date(Date.now() - up * 1000).toISOString(),
        checkedAt: new Date().toISOString(),
        checks
    };
}

// /health body. `status: 'ok'` and `timestamp` are the fields the stub this
// replaces already returned — renamed or removed they would break any caller
// that is grepping for them today, and 'ok' vs 'healthy' carries no more
// information at this endpoint because nothing here is being judged.
function livenessEnvelope(opts = {}) {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: opts.version || 'unknown',
        uptimeSec: uptimeSec()
    };
}

// ------------------------------------------------------------ event loop ----

let heartbeatAt = Date.now();
let heartbeatTimer = null;

function startHeartbeat() {
    if (heartbeatTimer) return heartbeatTimer;
    heartbeatTimer = setInterval(() => { heartbeatAt = Date.now(); }, HEARTBEAT_INTERVAL_MS);
    // Never let the probe keep a process alive that is otherwise exiting.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    return heartbeatTimer;
}

function heartbeatAgeMs() {
    return Date.now() - heartbeatAt;
}

function eventLoopCheck() {
    startHeartbeat();
    const ageMs = heartbeatAgeMs();
    const metrics = { ageMs, intervalMs: HEARTBEAT_INTERVAL_MS };
    if (ageMs > HEARTBEAT_INTERVAL_MS * HEARTBEAT_UNHEALTHY_TICKS) {
        return check('unhealthy', `event loop blocked: last timer tick ${Math.round(ageMs / 1000)}s ago`, metrics);
    }
    if (ageMs > HEARTBEAT_INTERVAL_MS * HEARTBEAT_DEGRADED_TICKS) {
        return check('degraded', `event loop lagging: last timer tick ${Math.round(ageMs / 1000)}s ago`, metrics);
    }
    return check('healthy', `event loop responsive (tick ${ageMs}ms ago)`, metrics);
}

// ---------------------------------------------------------------- memory ----

// V8's own ceiling. getHeapMemoryLimit() is the intended API but is not present
// on every supported runtime (absent on Node 24), so heap_size_limit is the
// fallback and both paths are reported through the same shape.
function heapLimitBytes() {
    if (typeof v8.getHeapMemoryLimit === 'function') {
        try {
            const limit = v8.getHeapMemoryLimit();
            if (limit && Number.isFinite(limit.total) && limit.total > 0) return limit.total;
        } catch (e) { /* fall through to the statistic below */ }
    }
    return v8.getHeapStatistics().heap_size_limit || 0;
}

// rssLimitMB is the deploy's memory ceiling (Render's free plan / the watchdog's
// budget). Passing 0 or omitting it scores the report on heap alone.
function memoryCheck(opts = {}) {
    startHeartbeat();
    const used = process.memoryUsage();
    const stats = v8.getHeapStatistics();
    const heapLimit = heapLimitBytes();
    const rssLimitMB = Number(opts.rssLimitMB) > 0 ? Number(opts.rssLimitMB) : 0;

    const ratios = [];
    if (rssLimitMB > 0) ratios.push({ label: 'RSS', value: used.rss / (rssLimitMB * 1048576) });
    if (heapLimit > 0) ratios.push({ label: 'heap', value: used.heapUsed / heapLimit });
    const tightest = ratios.sort((a, b) => b.value - a.value)[0] || null;
    const percent = tightest ? Math.round(tightest.value * 100) : 0;

    const metrics = {
        rssMB: mb(used.rss),
        heapUsedMB: mb(used.heapUsed),
        heapTotalMB: mb(used.heapTotal),
        heapLimitMB: mb(heapLimit),
        externalMB: mb(used.external),
        arrayBuffersMB: mb(used.arrayBuffers),
        // The native-memory leak signature: RSS climbs while heapUsed is flat,
        // and external/arrayBuffers are where the difference becomes visible.
        nativeMB: mb(Math.max(0, used.rss - used.heapTotal)),
        detachedContexts: stats.number_of_detached_contexts || 0,
        rssLimitMB: rssLimitMB || null,
        usagePercent: percent,
        pressureFrom: tightest ? tightest.label : null
    };

    const detail = `RSS ${metrics.rssMB}MB${rssLimitMB ? '/' + rssLimitMB + 'MB' : ''}`
        + `, heap ${metrics.heapUsedMB}MB/${metrics.heapLimitMB}MB`
        + `, external ${metrics.externalMB}MB, arrayBuffers ${metrics.arrayBuffersMB}MB`
        + ` (${percent}% of ${metrics.pressureFrom || 'heap'})`;

    if (tightest && tightest.value >= MEMORY_UNHEALTHY_RATIO) {
        return check('unhealthy', `memory ${percent}% of ${tightest.label} budget — OOM imminent`, metrics);
    }
    if (tightest && tightest.value >= MEMORY_DEGRADED_RATIO) {
        return check('degraded', `memory ${percent}% of ${tightest.label} budget`, metrics);
    }
    // Detached contexts are a leak you can only see here; a nonzero count with
    // healthy memory is still worth surfacing before it becomes the OOM above.
    if (metrics.detachedContexts > 0) {
        return check('degraded', `${detail} — ${metrics.detachedContexts} detached context(s) retained`, metrics);
    }
    return check('healthy', detail, metrics);
}

// --------------------------------------------------------------- timing -----

// Runs an async probe with a hard ceiling. Resolves instead of rejecting on
// timeout, because a readiness handler must always answer: the difference
// between "slow" and "broken" belongs in the report body, not in an unhandled
// rejection. The timer is cleared in finally so a probe that finishes late
// cannot be attributed to the wrong call.
//
// The guard timer is deliberately NOT unref'd. Unref'ing it — which is the
// right call for the heartbeat below — lets Node exit instead of firing the
// timeout when nothing else holds the loop open, so the one situation the
// ceiling exists to survive (a probe that never settles) would silently end the
// process rather than be reported. It is cleared as soon as the probe settles,
// so it cannot keep anything alive past that moment.
async function runWithTimeout(fn, timeoutMs) {
    const startedAt = Date.now();
    let timer = null;
    try {
        const value = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
            Promise.resolve()
                .then(fn)
                .then(resolve)
                .catch(reject);
        });
        return { ok: true, ms: Date.now() - startedAt, value, timedOut: false };
    } catch (error) {
        const timedOut = error instanceof TimeoutError;
        return {
            ok: false,
            ms: Date.now() - startedAt,
            error: error && error.message ? error.message : String(error),
            timedOut
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

class TimeoutError extends Error {
    constructor(ms) {
        super(`timed out after ${ms}ms`);
        this.name = 'TimeoutError';
        this.timeoutMs = ms;
    }
}

// ------------------------------------------------------------------ auth ----

// Hashing both sides before timingSafeEqual normalises length, so the
// comparison does not leak how long the configured token is.
function tokenMatches(received, expected) {
    if (!expected) return false;
    const a = crypto.createHash('sha256').update(String(received == null ? '' : received)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

// /ready accepts EITHER the service-to-service secret or a normal admin
// session. Order matters: the secret is tried first because the JWT paths in
// both apps hit the database for operator roles, and readiness is exactly the
// moment when the database may be the thing that is down. A human operator with
// a live session still gets in through the fallback.
function createReadinessAuth(deps = {}) {
    const getToken = deps.getInternalToken || (() => process.env[deps.tokenEnvVar || 'WHATSAPP_INTERNAL_TOKEN']);
    const jwtMiddleware = deps.authenticate;

    return function readinessAuth(req, res, next) {
        if (tokenMatches(req.headers['x-internal-token'], getToken())) {
            req.internalService = true;
            return next();
        }
        if (typeof jwtMiddleware === 'function') return jwtMiddleware(req, res, next);
        return res.status(401).json({ error: 'Unauthorized' });
    };
}

module.exports = {
    SEVERITY,
    HEARTBEAT_INTERVAL_MS,
    MEMORY_DEGRADED_RATIO,
    MEMORY_UNHEALTHY_RATIO,
    mb,
    check,
    healthy,
    degraded,
    unhealthy,
    skipped,
    worstStatus,
    statusToHttpStatus,
    buildEnvelope,
    livenessEnvelope,
    startHeartbeat,
    heartbeatAgeMs,
    eventLoopCheck,
    heapLimitBytes,
    memoryCheck,
    runWithTimeout,
    TimeoutError,
    tokenMatches,
    createReadinessAuth
};
