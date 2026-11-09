/**
 * Shopper Hub (WhatsApp bot) database access.
 *
 * Some orders placed through the WhatsApp Shoppers Hub were shipped under
 * Shiprocket's "Custom" channel instead of the Shopify channel, so Shopify
 * never received a fulfillment for them. The returns portal would then treat
 * those orders as "not delivered" and block return/exchange requests.
 *
 * The WhatsApp bot's Supabase (store_shoppers + orders tables) is the source
 * of truth for how those orders actually shipped, so we read it here as a
 * fallback when a Shopify order looks unfulfilled.
 *
 * Env: SHOPPERHUB_DB_URL — the whatsappbot project's Supabase Postgres
 * connection string (its SUPABASE_DB_URL).
 */

let pool = null;
let poolFailed = false;
// 'not-configured' is a deliberate opt-out, anything else is a broken
// dependency — /ready has to tell them apart or every deployment that does not
// use the Shopper Hub fallback reports itself degraded forever.
let poolFailureReason = null;

// Readiness bookkeeping (Phase 1 §B3): scalars only, read without touching the
// pool, so answering /ready never acquires a connection of its own.
let queryCount = 0;
let queryErrorCount = 0;
let lastQueryAt = null;
let lastQueryMs = null;
let lastQueryErrorAt = null;
let lastQueryErrorMessage = null;
let poolErrorCount = 0;
let lastPoolErrorAt = null;
let lastPoolErrorMessage = null;

function noteQuerySuccess(durationMs) {
    queryCount++;
    lastQueryAt = Date.now();
    if (Number.isFinite(durationMs)) lastQueryMs = durationMs;
}

function noteQueryFailure(err) {
    queryErrorCount++;
    lastQueryErrorAt = Date.now();
    // Message only — never the parameters, which carry customer phones.
    lastQueryErrorMessage = err && err.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
}

function getPool() {
    if (pool || poolFailed) return pool;

    const connectionString = process.env.SHOPPERHUB_DB_URL;
    if (!connectionString) {
        poolFailed = true;
        poolFailureReason = 'not-configured';
        console.warn('⚠️  SHOPPERHUB_DB_URL not set — Shopper Hub order fallback disabled.');
        return null;
    }

    try {
        const { Pool } = require('pg');
        pool = new Pool({
            connectionString,
            max: 2,
            idleTimeoutMillis: 30 * 1000,
            connectionTimeoutMillis: 10 * 1000,
            ssl: { rejectUnauthorized: false }
        });
        // Don't crash the server if the pool hits a transient error
        pool.on('error', (err) => {
            poolErrorCount++;
            lastPoolErrorAt = Date.now();
            lastPoolErrorMessage = err && err.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
            console.warn('Shopper Hub DB pool error (non-fatal):', err.message);
        });
        // Both lookups below call pool.query() directly, so the bookkeeping is
        // wrapped around the pool method rather than repeated at each call site.
        const rawQuery = pool.query.bind(pool);
        pool.query = function trackedQuery(...args) {
            const startedAt = Date.now();
            const pending = rawQuery(...args);
            if (!pending || typeof pending.then !== 'function') return pending;
            return pending.then(
                (result) => { noteQuerySuccess(Date.now() - startedAt); return result; },
                (err) => { noteQueryFailure(err); throw err; }
            );
        };
        return pool;
    } catch (err) {
        poolFailed = true;
        poolFailureReason = err && err.message ? String(err.message).slice(0, 200) : 'pool construction failed';
        console.warn('⚠️  Shopper Hub DB unavailable (pg missing?):', err.message);
        return null;
    }
}

/**
 * Read-only view of this module's connection state for /ready. Never calls
 * getPool(), so it reports "uninitialised" instead of creating a pool as a
 * side effect of a health check.
 *   state: 'uninitialised' | 'disabled' | 'failed' | 'live'
 */
function getPoolStatus() {
    const base = {
        configured: Boolean(process.env.SHOPPERHUB_DB_URL),
        queryCount,
        queryErrorCount,
        lastQueryAt,
        lastQueryAgeMs: lastQueryAt === null ? null : Date.now() - lastQueryAt,
        lastQueryMs,
        lastQueryErrorAt,
        lastQueryErrorMessage,
        poolErrorCount,
        lastPoolErrorAt,
        lastPoolErrorMessage
    };
    if (!pool) {
        return Object.assign(base, {
            state: poolFailed ? (poolFailureReason === 'not-configured' ? 'disabled' : 'failed') : 'uninitialised',
            failureReason: poolFailureReason
        });
    }
    const total = pool.totalCount || 0;
    const idle = pool.idleCount || 0;
    return Object.assign(base, {
        state: 'live',
        total,
        idle,
        inUse: Math.max(0, total - idle),
        waiting: pool.waitingCount || 0,
        max: pool.options.max
    });
}

const BLOCKED_SHOPPER_STATUSES = ['cancelled', 'canceled', 'rejected'];
const BLOCKED_ORDER_STATUSES = ['rto', 'cancelled', 'canceled', 'returned'];

/**
 * Look up a Shoppers Hub order by its order number (with or without '#').
 * Returns shipping proof (AWB, carrier, delivery date) or null when the
 * order isn't a valid shipped shopper order.
 */
async function findShopperOrder(orderNumber) {
    const activePool = getPool();
    if (!activePool) return null;

    const bare = String(orderNumber || '').trim().replace(/^#/, '');
    if (!bare) return null;

    // store_shoppers.order_id may be stored with or without the '#' prefix
    const variants = [...new Set([`#${bare}`, bare])];

    try {
        const { rows } = await activePool.query(`
            SELECT s.order_id,
                   s.name        AS shopper_name,
                   s.phone,
                   s.email,
                   s.status      AS shopper_status,
                   s.order_total,
                   o.awb,
                   o.status      AS order_status,
                   o.courier_name,
                   o.delivered_at
            FROM store_shoppers s
            LEFT JOIN orders o ON o.order_id = s.order_id
            WHERE s.order_id = ANY($1::text[])
            ORDER BY s.updated_at DESC NULLS LAST
            LIMIT 1
        `, [variants]);

        const row = rows[0];
        if (!row) return null;

        const shopperStatus = String(row.shopper_status || '').toLowerCase();
        if (BLOCKED_SHOPPER_STATUSES.includes(shopperStatus)) return null;

        const orderStatus = String(row.order_status || '').toLowerCase();
        if (BLOCKED_ORDER_STATUSES.includes(orderStatus)) return null;

        // Without an AWB there's no proof the order shipped
        if (!row.awb) return null;

        return {
            orderId: row.order_id,
            awb: row.awb,
            courier: row.courier_name || null,
            orderStatus: row.order_status || null,
            deliveredAt: row.delivered_at || null,
            shopperName: row.shopper_name || null,
            phone: row.phone || null,
            email: row.email || null,
            orderTotal: row.order_total || null
        };
    } catch (err) {
        console.warn('Shopper Hub order lookup failed (non-fatal):', err.message);
        return null;
    }
}

/**
 * Resolve a shopper's email from their phone number (matched on the last
 * 10 digits so +91/91/10-digit formats all work). Used by the OTP login
 * flow to attach a real email to phone-only Shopify customers.
 * Returns the email string or null.
 */
async function findShopperEmailByPhone(phone) {
    const activePool = getPool();
    if (!activePool) return null;

    const digits = String(phone || '').replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return null;

    try {
        const { rows } = await activePool.query(`
            SELECT email
            FROM store_shoppers
            WHERE email IS NOT NULL AND email <> ''
              AND RIGHT(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = $1
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
        `, [digits]);
        return rows[0]?.email?.trim() || null;
    } catch (err) {
        console.warn('Shopper Hub email-by-phone lookup failed (non-fatal):', err.message);
        return null;
    }
}

/**
 * Deep readiness probe: one real round trip on the fallback pool. Only reached
 * from /ready?deep=1, so an ordinary poll can never spend a connection. Throws
 * when there is no pool rather than returning null, because "nothing happened"
 * and "this cannot work" are different answers.
 */
async function probeConnection() {
    const activePool = getPool();
    if (!activePool) {
        throw new Error(poolFailureReason === 'not-configured'
            ? 'SHOPPERHUB_DB_URL is not configured'
            : `pool unavailable: ${poolFailureReason || 'unknown reason'}`);
    }
    return activePool.query('SELECT 1');
}

module.exports = { findShopperOrder, findShopperEmailByPhone, getPoolStatus, probeConnection };
