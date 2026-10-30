const express = require('express');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');

// Environment check
const isProduction = process.env.NODE_ENV === 'production';

// Create the logger
const logger = winston.createLogger({
    level: isProduction ? 'error' : 'warn',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
    ]
});

// Rate limit event handler with logging
function rateLimitHandler(req, res, next, options) {
    const logData = {
        timestamp: new Date().toISOString(),
        ip: req.ip,
        method: req.method,
        url: req.originalUrl,
        userAgent: req.headers['user-agent']
    };
    logger.warn('Rate limit exceeded', logData);
    res.status(options.statusCode).json({ error: 'Too many requests, please try again later.' });
}

// Simple suspicious activity tracker (in-memory, reset every hour)
const suspiciousActivity = new Map();
const SUSPICIOUS_THRESHOLD = 10;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

function trackSuspicious(ip, action) {
    const now = Date.now();
    let record = suspiciousActivity.get(ip);

    if (!record) {
        record = { count: 0, lastAction: null, timestamps: [] };
        suspiciousActivity.set(ip, record);
    }

    record.timestamps = record.timestamps.filter(ts => now - ts < ATTEMPT_WINDOW_MS);
    record.timestamps.push(now);
    record.count = record.timestamps.length;
    record.lastAction = action;

    if (record.count >= SUSPICIOUS_THRESHOLD) {
        logger.warn(`Suspicious activity detected from IP ${ip}`, { count: record.count });
    }
}

// Periodically prune stale entries so the Map doesn't grow unbounded (memory leak fix).
// Without this, every distinct IP that ever triggers trackSuspicious leaves a permanent
// record, causing RSS to creep up over days. This drops IPs whose attempts have all
// aged out of the tracking window and trims expired timestamps from the rest.
const SUSPICIOUS_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of suspiciousActivity) {
        const recent = record.timestamps.filter(ts => now - ts < ATTEMPT_WINDOW_MS);
        if (recent.length === 0) {
            suspiciousActivity.delete(ip);
        } else {
            record.timestamps = recent;
            record.count = recent.length;
        }
    }
}, SUSPICIOUS_CLEANUP_INTERVAL_MS).unref();

const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
const multer = require('multer');
const cloudinary = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary-v2');
const Razorpay = require('razorpay');

// Gokwik webhook signature verification
function verifyGokwikWebhook(payload, signature, secret) {
    if (!signature || !secret) return false;
    const hmac = crypto.createHmac('sha256', secret);
    const digest = hmac.update(payload).digest('hex');
    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(digest, 'hex')
        );
    } catch {
        return false;
    }
}

// Build exchange/replacement product name in Zoho Books catalog format:
// "PRODUCT ( COLOR ) - SIZE" — the " - SIZE" suffix is required so the
// Zoho item resolver can match the line against the catalog and deduct
// stock for the correct size variant.
// If the title already carries a DIFFERENT size suffix (e.g. the original
// size baked into replacementProductTitle), strip it first so the correct
// replacement size is always appended.
function buildExchangeProductName(title, variant) {
    let base = title || 'Item';
    if (!variant || variant === 'Same') return base;
    // Strip any existing trailing " - SIZE" suffix from the title so we
    // never end up with the wrong size baked in (e.g. "HENLEY - M" → "HENLEY")
    base = base.replace(/\s-\s\S+\s*$/, '');
    return base + ' - ' + variant;
}

// In-memory cache for Shopify customer name lookups (avoids repeated API calls)
const _customerNameCache = new Map();
const CUSTOMER_NAME_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Resolve the best customer display name from cart data
// Tries: customer_name -> Shopify lookup by email (cached) -> email prefix -> 'there'
async function resolveCustomerDisplayName(cart) {
    // If we have a real name (has a space suggesting first+last, or is a single real name), use it
    if (cart.customer_name && cart.customer_name.includes(' ')) {
        return cart.customer_name;
    }
    // Single-word customer_name might be email-derived; try Shopify lookup for a real name
    if (cart.customer_email) {
        // Check cache first
        const cached = _customerNameCache.get(cart.customer_email);
        if (cached && (Date.now() - cached.ts < CUSTOMER_NAME_CACHE_TTL)) {
            return cached.name;
        }
        try {
            const shopifyCustomerData = await shopifyAPI(`customers.json?email=${encodeURIComponent(cart.customer_email)}&limit=1`);
            let resolvedName = null;
            if (shopifyCustomerData?.customers?.[0]) {
                const sc = shopifyCustomerData.customers[0];
                resolvedName = `${sc.first_name || ''} ${sc.last_name || ''}`.trim() || null;
                if (!resolvedName && sc.default_address?.name) resolvedName = sc.default_address.name;
                if (!resolvedName && (sc.default_address?.first_name || sc.default_address?.last_name)) {
                    resolvedName = `${sc.default_address.first_name || ''} ${sc.default_address.last_name || ''}`.trim();
                }
            }
            // Cache the result (even null so we don't re-lookup emails with no Shopify customer)
            _customerNameCache.set(cart.customer_email, { name: resolvedName, ts: Date.now() });
            // Evict stale entries if cache grows too large
            if (_customerNameCache.size > 500) {
                const cutoff = Date.now() - CUSTOMER_NAME_CACHE_TTL;
                for (const [key, val] of _customerNameCache) {
                    if (val.ts < cutoff) _customerNameCache.delete(key);
                }
            }
            if (resolvedName) return resolvedName;
        } catch (e) { /* ignore Shopify lookup errors */ }
    }
    // Fallback to existing customer_name if present
    if (cart.customer_name) return cart.customer_name;
    // Last resort: derive from email prefix
    if (cart.customer_email) {
        return cart.customer_email.split('@')[0].replace(/[^a-zA-Z0-9]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    }
    return 'there';
}

const app = express();

// Trust Render's proxy so express-rate-limit can read real client IPs
app.set('trust proxy', 1);

// Deploy timestamp: 2026-05-01 - Admin dashboard with permissive CSP
// Serve admin dashboard BEFORE helmet (to bypass CSP restrictions)
app.get('/admin', (req, res) => {
    // Custom CSP for admin - allows inline scripts and event handlers
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://exchange-return-tracking.onrender.com https://cdn.jsdelivr.net;");
    res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Marketing dashboard - same permissive CSP as admin dashboard
app.get('/admin/marketing', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://exchange-return-tracking.onrender.com https://cdn.jsdelivr.net;");
    res.sendFile(path.join(__dirname, 'public', 'admin', 'marketing', 'index.html'));
});

// Manufacture Studio admin review page - same permissive CSP as admin dashboard
// (the manufacturer-facing portal is a Shopify page template: public/page.manufacture.liquid)
app.get('/manufacture/admin', (req, res) => {
    const portalBaseUrl = process.env.MANUFACTURE_PORTAL_URL || 'https://offcomfrt.in/pages/manufactures-crm2026';
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://exchange-return-tracking.onrender.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com;");
    const html = require('fs').readFileSync(path.join(__dirname, 'public', 'manufacture', 'admin.html'), 'utf8');
    const injected = html.replace(
        '/* PORTAL_BASE_URL_INJECT */',
        `const PORTAL_BASE_URL = ${JSON.stringify(portalBaseUrl)};`
    );
    res.send(injected);
});

// Athlete training film is consumed by the Shopify-hosted athlete portal.
// Keep its cross-origin access narrowly scoped to this public video directory.
app.use('/videos', express.static(path.join(__dirname, 'public', 'videos'), {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Accept-Ranges', 'bytes');
    },
}));

// Athlete portal PWA manifest — the portal document lives on a Shopify origin
// (custom domain or *.myshopify.com) while this manifest is served from here,
// and browsers ignore start_url unless its origin matches the document's. The
// page passes its own host/path; both are whitelisted before use.
const MANIFEST_HOST_RE = /^([a-z0-9-]+\.)*(offcomfrt\.in|myshopify\.com)$/;
const MANIFEST_PATH_RE = /^\/pages\/[a-z0-9-]+$/;
app.get('/manifest.json', (req, res) => {
    const manifest = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'public', 'manifest.json'), 'utf8'));
    const host = String(req.query.host || '').toLowerCase();
    const pagePath = MANIFEST_PATH_RE.test(String(req.query.path || '')) ? String(req.query.path) : '/pages/athlete-portal';
    manifest.start_url = `${MANIFEST_HOST_RE.test(host) ? `https://${host}` : 'https://offcomfrt.in'}${pagePath}`;
    res.set('Content-Type', 'application/manifest+json');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    // This route sits before the app-wide cors() middleware, and the browser
    // fetches manifests in CORS mode — send the header explicitly like /videos.
    res.set('Access-Control-Allow-Origin', '*');
    res.json(manifest);
});

// Security middleware - Helmet for security headers (applied AFTER admin routes)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            connectSrc: ["'self'", "https://exchange-return-tracking.onrender.com", "wss://exchange-return-tracking.onrender.com", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: false,
    // Portal static assets under public/ (app icon, game thumbnails, sw.js) are
    // embedded by the Shopify-hosted athlete portal — Helmet's default CORP
    // same-origin makes those cross-origin reads fail with
    // ERR_BLOCKED_BY_RESPONSE.NotSameOrigin, so open them up like /videos above.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'offcomfrt-dev-jwt-secret-key-2026';
if (!process.env.JWT_SECRET && isProduction) {
    console.error('FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
}

// Token expiration time (24 hours)
const TOKEN_EXPIRY = '24h';

// CORS Configuration - Allow all origins for Shopify embedded app
// Note: In production, consider restricting to your Shopify domain
const corsOptions = {
    origin: true, // Allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Rate limiters
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 300, // limit each IP to 300 requests per windowMs (increased for admin dashboard usage)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: 'Too many requests from this IP, please try again after 15 minutes.',
    handler: rateLimitHandler,
    // Skip rate limiting for authenticated admin requests (they have their own auth)
    skip: (req) => {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return true; // Skip rate limit for authenticated requests
        }
        return false;
    }
});

const writeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 60, // Max 60 requests per IP per hour for write (increased from 20)
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many submissions from this IP, please try again after an hour.',
    handler: rateLimitHandler,
    // Skip rate limiting for authenticated admin requests
    skip: (req) => {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return true; // Skip rate limit for authenticated requests
        }
        return false;
    }
});




// Apply general API rate limiter
app.use('/api/', apiLimiter);

// Apply stricter limits on sensitive write endpoints
app.post('/api/submit-return', writeLimiter);
app.post('/api/submit-exchange', writeLimiter);
app.post('/api/admin/', writeLimiter);
app.post('/api/admin/*', writeLimiter);
app.post('/api/influencer/apply', writeLimiter);

// Request timeout protection - abort requests taking longer than 30 seconds
app.use((req, res, next) => {
    // Safety net: make res.json and res.send no-ops if headers already sent.
    // This prevents ERR_HTTP_HEADERS_SENT crashes when the timeout fires but
    // the async route handler is still running and later tries to respond.
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    res.json = function (body) {
        if (res.headersSent) return res;
        return origJson(body);
    };
    res.send = function (body) {
        if (res.headersSent) return res;
        return origSend(body);
    };

    res.setTimeout(30000, () => {
        console.warn(`[Timeout] Request aborted: ${req.method} ${req.originalUrl}`);
        if (!res.headersSent) {
            res.status(503).json({ error: 'Request timeout - operation took too long' });
        }
    });
    next();
});

const PORT = process.env.PORT || 3000;

// Force rebuild: Deployment verified 2026-04-30 20:00 IST
// Admin dashboard frontend hosted on Render with full backend connectivity

// JWT Token Generation Helper
function generateToken(payload) {
    if (!JWT_SECRET) {
        // Fallback for development only
        return crypto.randomBytes(32).toString('hex');
    }
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// JWT Token Verification Helper
function verifyToken(token) {
    if (!JWT_SECRET) {
        return null; // Development fallback
    }
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

// Supabase Database
const {
    createRequest,
    getRequestById,
    getRequestsByOrderNumber,
    getAllRequests,
    getAllRequestsForExport,
    getRequestStats,
    updateRequestData,
    updateRequestStatus,
    saveAgentNotes,
    deleteRequests,
    getSetting,
    updateSetting,
    getAllInfluencers,
    createInfluencer,
    updateInfluencer,
    deleteInfluencer,
    getInfluencerByToken,
    getInfluencerById,
    listPendingInfluencers,
    isReferralCodeTaken,
    isEmailTaken,
    isPhoneTaken,
    listPayouts,
    createPayout,
    updatePayoutStatus,
    getPayoutById,
    createShipment,
    listShipments,
    listShipmentsByInfluencer,
    updateShipment,
    deleteShipment,
    getShipmentById,
    listPayoutsByInfluencer,
    upsertPayout,
    createReelTarget,
    getReelTargetsByInfluencer,
    getReelTargetProgress,
    createProductRequest,
    getProductRequests,
    updateProductRequest,
    getProductRequestById,
    convertFromSnakeCase,
    createMessage,
    getAdminMessages,
    getInfluencerMessages,
    markMessageAsRead,
    getUnreadMessageCount,
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
} = require('./config/db-helpers');
const supabase = require('./config/supabase');

// Marketing Dashboard modules (isolated from return/exchange logic)
const marketingDB = require('./config/marketing-db-helpers');
const shopperHubDB = require('./config/shopper-hub-db');
const metaWhatsApp = require('./config/meta-whatsapp');

async function generateUniqueRequestId() {
    let isUnique = false;
    let requestId;
    let retryCount = 0;
    while (!isUnique && retryCount < 10) {
        requestId = 'REQ-' + Math.floor(10000 + Math.random() * 90000);
        const existing = await getRequestById(requestId);
        if (!existing) {
            isUnique = true;
        }
        retryCount++;
    }
    if (!isUnique) {
        requestId = 'REQ-' + Date.now().toString().slice(-5);
    }
    return requestId;
}

// Body parsing middleware
app.use(express.json({
    limit: '2mb', // Founder OS workspace state can exceed the default 100kb
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));
// ── Athlete game access gate ──
// A game the admin has locked (unlock flag explicitly false in program_settings,
// toggled from the athlete-admin "Game Management" panel) must not be reachable
// by athletes at all — not just hidden in the portal, but also via a direct URL
// to the game HTML. Registered before express.static so it can intercept the
// static game entry points. FAIL-OPEN: any require/read error or a missing flag
// leaves the game reachable; only an explicit `false` hides it.
const GAME_ENTRY_PATHS = [
    { match: '/athlete-game.html', exact: true, gameId: 'rooftop-racing' },
    { match: '/games/fruit-ninja', gameId: 'fruit-ninja' },
    { match: '/games/ping-pong', gameId: 'ping-pong' },
    { match: '/games/pac-man', gameId: 'pac-man' },
    { match: '/games/crossy-road', gameId: 'crossy-road' },
    { match: '/games/tower-blocks', gameId: 'tower-blocks' }
];
app.use((req, res, next) => {
    try {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const clean = (req.path || '').split('#')[0].replace(/\/index\.html$/, '/').replace(/\/$/, '');
        let gameId = null;
        for (const g of GAME_ENTRY_PATHS) {
            if (g.exact ? (clean === g.match) : (clean === g.match || clean.startsWith(g.match + '/'))) { gameId = g.gameId; break; }
        }
        if (!gameId) return next();
        const { GamificationService } = require('./services/athlete-program');
        GamificationService.getGameUnlocks()
            .then(unlocks => {
                if (unlocks && unlocks[gameId] === false) {
                    return res.status(403).type('html').send(
                        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
                        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                        '<title>Coming soon</title><style>html,body{margin:0;height:100%;background:#0a0a0a;color:#fff;' +
                        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;align-items:center;justify-content:center;text-align:center}' +
                        '.box{padding:24px;max-width:340px}.lock{width:34px;height:34px;stroke:#fff;fill:none;stroke-width:1.4;margin:0 auto 14px;display:block}' +
                        'h1{font-size:12px;letter-spacing:.2em;text-transform:uppercase;margin:0 0 8px}p{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:0;line-height:1.7}</style></head>' +
                        '<body><div class="box"><svg class="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' +
                        '<h1>Coming soon</h1><p>This cabinet is not open for athletes yet. Check back soon.</p></div></body></html>'
                    );
                }
                next();
            })
            .catch(() => next());
    } catch (e) { next(); }
});

app.use(express.static('public'));

// Serve favicon.ico to prevent 404
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // No content
});

// In-memory storage for OAuth tokens and payment processing
const storage = {
    accessToken: null,
    processingPayments: new Set() // Dedup guard: prevent double-processing same payment
};

// ==================== BACKGROUND SYNC JOB ====================
const cron = require('node-cron');

// Background sync job - runs 4 times per day (6AM, 12PM, 6PM, 12AM IST)
let isSyncRunning = false;
let lastSyncTimestamp = null;

// Helper function to sync a single request with retry logic
async function syncWithRetry(req, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const syncResult = await syncSingleRequest(req);
            
            // Update sync tracking fields (if they exist in DB)
            try {
                await supabase
                    .from('requests')
                    .update({
                        last_sync_attempt: new Date().toISOString(),
                        sync_retry_count: 0,
                        last_sync_error: null
                    })
                    .eq('request_id', req.requestId);
            } catch (dbError) {
                // Ignore if columns don't exist yet (migration not run)
            }
            
            return { success: true, attempts: attempt, changed: !!(syncResult && syncResult.changed) };
        } catch (error) {
            if (attempt === maxRetries) {
                // Final failure - log permanently
                try {
                    await supabase
                        .from('requests')
                        .update({
                            last_sync_attempt: new Date().toISOString(),
                            sync_retry_count: attempt,
                            last_sync_error: error.message
                        })
                        .eq('request_id', req.requestId);
                } catch (dbError) {
                    // Ignore if columns don't exist yet
                }
                
                console.error(`[${req.requestId}] Sync failed after ${maxRetries} attempts:`, error.message);
                return { success: false, attempts: attempt, error: error.message };
            } else {
                // Wait before retry (exponential backoff: 2s, 4s, 8s)
                const waitTime = 1000 * Math.pow(2, attempt);
                console.warn(`[${req.requestId}] Sync attempt ${attempt} failed, retrying in ${waitTime/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
}

async function performBackgroundSync() {
    if (isSyncRunning) {
        console.log('[Background Sync] Sync already running, skipping...');
        return { success: false, message: 'Sync already running' };
    }
    
    isSyncRunning = true;
    const syncStartTime = new Date();
    console.log('[Background Sync] Starting automated sync...');
    
    // Initialize metrics tracking
    const syncMetrics = {
        total: 0,
        success: 0,
        failed: 0,
        updated: 0,
        skipped: 0,
        carrierBreakdown: {
            shiprocket: { success: 0, failed: 0 },
            delhivery: { success: 0, failed: 0 },
            ekart: { success: 0, failed: 0 },
            unknown: { success: 0, failed: 0 }
        },
        errors: []
    };
    
    try {
        // Fetch only active requests (not all requests).
        // out_for_delivery MUST be included — it's the most common state for
        // carrier-side cancellations/RTOs to be missed if skipped.
        const { data: activeRequests, error } = await supabase
            .from('requests')
            .select('*')
            .or('status.eq.pending,status.eq.pickup_pending,status.eq.pickup_booked,status.eq.scheduled,status.eq.picked_up,status.eq.in_transit,status.eq.out_for_delivery')
            .not('awb_number', 'is', null)
            .order('created_at', { ascending: false });
        
        if (error || !activeRequests) {
            console.error('[Background Sync] Error fetching requests:', error);
            return { success: false, error: error?.message || 'No requests found' };
        }
        
        syncMetrics.total = activeRequests.length;
        console.log(`[Background Sync] Processing ${activeRequests.length} active requests...`);
        
        const BATCH_SIZE = 5; // Process 5 at a time to avoid overwhelming carrier APIs
        
        for (let i = 0; i < activeRequests.length; i += BATCH_SIZE) {
            const batch = activeRequests.slice(i, i + BATCH_SIZE);
            
            // Process batch in parallel
            const results = await Promise.allSettled(batch.map(async (rawReq) => {
                // Rows come back as raw snake_case; map to camelCase so the sync
                // logic (req.awbNumber, req.requestId, ...) works correctly.
                const req = convertFromSnakeCase(rawReq);
                const carrier = detectCarrier(req);
                const result = await syncWithRetry(req, 3);
                
                // Update metrics
                if (result.success) {
                    syncMetrics.success++;
                    if (result.changed) syncMetrics.updated++;
                    if (syncMetrics.carrierBreakdown[carrier]) {
                        syncMetrics.carrierBreakdown[carrier].success++;
                    }
                } else {
                    syncMetrics.failed++;
                    if (syncMetrics.carrierBreakdown[carrier]) {
                        syncMetrics.carrierBreakdown[carrier].failed++;
                    }
                    syncMetrics.errors.push({
                        requestId: req.requestId,
                        carrier: carrier,
                        error: result.error
                    });
                }
                
                return { requestId: req.requestId, ...result };
            }));
            
            // Log batch progress
            const batchSuccess = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const batchFailed = results.filter(r => r.status === 'rejected' || (r.value && !r.value.success)).length;
            console.log(`[Background Sync] Batch ${Math.floor(i/BATCH_SIZE) + 1} complete: ${batchSuccess} success, ${batchFailed} failed`);
        }
        
        lastSyncTimestamp = new Date().toISOString();
        const syncDuration = ((new Date() - syncStartTime) / 1000).toFixed(2);
        
        // Log detailed summary
        console.log(`\n[Background Sync] ========== SYNC SUMMARY ==========`);
        console.log(`[Background Sync] Duration: ${syncDuration}s`);
        console.log(`[Background Sync] Total: ${syncMetrics.total}, Success: ${syncMetrics.success}, Updated: ${syncMetrics.updated}, Failed: ${syncMetrics.failed}, Skipped: ${syncMetrics.skipped}`);
        console.log(`[Background Sync] Shiprocket: ${syncMetrics.carrierBreakdown.shiprocket.success} success, ${syncMetrics.carrierBreakdown.shiprocket.failed} failed`);
        console.log(`[Background Sync] Delhivery: ${syncMetrics.carrierBreakdown.delhivery.success} success, ${syncMetrics.carrierBreakdown.delhivery.failed} failed`);
        console.log(`[Background Sync] Ekart: ${syncMetrics.carrierBreakdown.ekart.success} success, ${syncMetrics.carrierBreakdown.ekart.failed} failed`);
        
        if (syncMetrics.errors.length > 0) {
            console.log(`[Background Sync] Errors:`);
            syncMetrics.errors.slice(0, 5).forEach(err => {
                console.log(`  - ${err.requestId} (${err.carrier}): ${err.error}`);
            });
            if (syncMetrics.errors.length > 5) {
                console.log(`  ... and ${syncMetrics.errors.length - 5} more errors`);
            }
        }
        console.log(`[Background Sync] ====================================\n`);
        
        return { success: true, metrics: syncMetrics };
    } catch (error) {
        console.error('[Background Sync] Fatal error:', error);
        return { success: false, error: error.message, metrics: syncMetrics };
    } finally {
        isSyncRunning = false;
    }
}

// Authoritative carrier detection from raw shipment fields (heuristics only).
// Used by both the return leg and the forward leg so detection logic is never
// re-implemented inline and cannot diverge between code paths.
function detectCarrierForAwb(awb, shipmentId, carrierField, fallbackReason) {
    const carrier = (carrierField || '').toString().trim().toLowerCase();
    const awbStr = awb ? awb.toString().trim() : '';
    const shipStr = shipmentId ? shipmentId.toString().trim() : '';

    // 1. Explicit, trusted carrier field
    if (carrier === 'delhivery' || carrier === 'shiprocket' || carrier === 'ekart') {
        return carrier;
    }

    // 2. Shiprocket shipment IDs are prefixed with 'SR'
    if (shipStr.toUpperCase().startsWith('SR')) {
        return 'shiprocket';
    }

    // 3. A fallback reason means the primary carrier was swapped for Delhivery
    //    (unless the shipment ID clearly marks it as Shiprocket, handled above)
    if (fallbackReason) {
        return 'delhivery';
    }

    // 4. AWB format: Delhivery waybills are all-digit and >= 12 chars
    if (awbStr) {
        if (/^\d{12,}$/.test(awbStr)) {
            return 'delhivery';
        }
        // Alphanumeric / SR-prefixed AWBs are Shiprocket
        if (/[a-zA-Z]/.test(awbStr)) {
            return 'shiprocket';
        }
    }

    // 5. Default to shiprocket for backward compatibility
    return 'shiprocket';
}

// Helper function to detect carrier based on request data.
// Backward compatible: existing detectCarrier(req) calls still work.
function detectCarrier(req) {
    return detectCarrierForAwb(
        req.awbNumber,
        req.shipmentId,
        req.carrier || req.forwardCarrier,
        req.carrierFallbackReason
    );
}

// Ordered progression of shipment statuses. Used to stop out-of-order or
// duplicate carrier scans from regressing a request (e.g. a late "in transit"
// scan arriving after "out for delivery"). Higher rank = further along.
const STATUS_RANK = {
    waiting_payment: 0,
    pending: 0,
    pickup_pending: 1,
    scheduled: 2,
    pickup_booked: 2,
    picked_up: 3,
    in_transit: 4,
    out_for_delivery: 5,
    delivered: 6,
    inspected: 7,
    approved: 8,
    rejected: 8,
    cancelled: 8,
    failed: 8
};

// Returns true only when `next` is strictly further along than `current`,
// so sync never moves a shipment backwards on a stale/duplicate scan.
function isForwardProgress(current, next) {
    const c = STATUS_RANK[current] ?? -1;
    const n = STATUS_RANK[next] ?? -1;
    return n > c;
}

// Map a carrier-specific status string (and Delhivery's optional StatusType code)
// to an internal status enum. Comprehensive across the full Shiprocket and
// Delhivery vocabularies. Order matters — more specific / terminal states first.
function mapCarrierStatus(carrierStatus, carrier = 'shiprocket', statusType = null) {
    if (!carrierStatus && !statusType) return null;

    const s = (carrierStatus || '').toString().toUpperCase().trim();
    const st = (statusType || '').toString().toUpperCase().trim();
    const isDelhivery = carrier === 'delhivery';
    const has = (...tokens) => tokens.some(t => s.includes(t));

    // 1. UNDELIVERED / FAILED ATTEMPT — must precede DELIVERED because the
    //    substring "DELIVERED" also appears inside "UNDELIVERED".
    if (has('UNDELIVERED', 'NOT DELIVERED', 'DELIVERY FAILED', 'FAILED DELIVERY',
            'DELIVERY ATTEMPTED', 'ATTEMPTED DELIVERY')) {
        return { status: 'exception', shouldUpdate: false, needsNote: true };
    }

    // 2a. RTO / RETURN TO ORIGIN — the carrier aborted the shipment and is
    //     sending the parcel back. Terminal failure in both directions: an
    //     exchange delivery going RTO failed, and a return pickup going RTO
    //     means the parcel is headed back to the customer. Mark 'failed' so
    //     the request is re-dispatchable and never stuck showing
    //     in-transit/out-for-delivery.
    //     RTO/RT stays failed even with StatusType DL (a forward shipment
    //     RTO-delivered back to origin is NOT a successful delivery).
    if (st === 'RT' || has('RTO', 'RETURN TO ORIGIN', 'RETURN INITIATED',
                           'RETURN ACCEPTED')) {
        return { status: 'failed', shouldUpdate: true, terminal: true, needsNote: true };
    }

    // 2b. Delhivery DTO (return pickup) flow in progress — note-only here.
    //     DTO is NOT a success case — it's still RTO/failed. Only catch
    //     in-progress DTO (not delivered yet) for admin review.
    if (isDelhivery && s.includes('DTO') && !s.includes('DELIVERED') && st !== 'DL') {
        return { status: 'exception', shouldUpdate: false, needsNote: true };
    }

    // 3a. CANCELLED — the carrier cancelled the shipment (e.g. pickup
    //     cancelled on the carrier dashboard). Terminal: the platform must
    //     never keep showing out-for-delivery/in-transit for a cancelled
    //     waybill. Delhivery also reports cancellations via StatusType 'CR'.
    if (st === 'CR' || has('CANCELLED', 'CANCELED')) {
        return { status: 'cancelled', shouldUpdate: true, terminal: true, needsNote: true };
    }

    // 3b. LOST / DAMAGED / PICKUP ERROR — hard terminal carrier failures.
    if (has('LOST', 'DAMAGED', 'DESTROYED',
            'PICKUP ERROR', 'PICKUP FAILED')) {
        return { status: 'failed', shouldUpdate: true, terminal: true, needsNote: true };
    }

    // 4. TERMINAL — DELIVERED / RECEIVED AT WAREHOUSE.
    //    Delhivery StatusType 'DL' is the authoritative delivered signal.
    if (st === 'DL' || has('DELIVERED', 'DTO DELIVERED', 'RETURN RECEIVED',
                           'RECEIVED AT WAREHOUSE', 'RECEIVED AT ORIGIN') ||
        s === 'CLOSED') {
        return { status: 'delivered', shouldUpdate: true };
    }

    // 5. OUT FOR DELIVERY — before generic in-transit. Delhivery reports the
    //    last-mile leg as "Dispatched".
    if (has('OUT FOR DELIVERY', 'OUT FOR DEL', 'OFD') ||
        (isDelhivery && has('DISPATCHED'))) {
        return { status: 'out_for_delivery', shouldUpdate: true };
    }

    // 6. IN TRANSIT / IN NETWORK / REACHED HUB.
    if (has('IN TRANSIT', 'IN-TRANSIT', 'INTRANSIT', 'SHIPPED', 'PENDING DELIVERY',
            'REACHED DESTINATION', 'REACHED AT DESTINATION', 'ARRIVED AT',
            'IN NETWORK') ||
        (!isDelhivery && has('DISPATCHED'))) {
        return { status: 'in_transit', shouldUpdate: true };
    }

    // 7. PICKED UP BY COURIER. Delhivery StatusType 'PU' == pickup done.
    if ((st === 'PU' && !has('NOT PICKED')) ||
        (has('PICKED UP', 'PICKUP DONE', 'PICKUP COMPLETE', 'SHIPMENT PICKED') &&
         !has('NOT PICKED', 'PICKUP GENERATED', 'PICKUP SCHEDULED',
              'PICKUP CREATED', 'AWAITING'))) {
        return { status: 'picked_up', shouldUpdate: true };
    }

    // 8. PICKUP SCHEDULED / BOOKED / MANIFESTED — booked, awaiting collection.
    if (has('OUT FOR PICKUP', 'PICKUP SCHEDULED', 'PICKUP RESCHEDULED',
            'PICKUP QUEUED', 'PICKUP ASSIGNED', 'PICKUP BOOKED', 'SCHEDULED') ||
        (isDelhivery && (has('MANIFESTED', 'NOT PICKED') || s === 'OPEN'))) {
        return { status: 'pickup_booked', shouldUpdate: true };
    }

    // 9. AWB / LABEL GENERATED, REGISTERED — created, awaiting carrier confirmation.
    if (has('PICKUP GENERATED', 'AWB ASSIGNED', 'LABEL GENERATED', 'PICKUP CREATED',
            'REGISTERED', 'MANIFEST GENERATED', 'MANIFEST UPLOADED', 'DATA RECEIVED',
            'DATA UPLOAD', 'INFORMATION RECEIVED', 'ORDER CREATED')) {
        return { status: 'pickup_pending', shouldUpdate: true };
    }

    // 10. Delhivery in-network fallback: StatusType 'UD' (undelivered = still en
    //     route) that did not match a more specific rule above.
    if (isDelhivery && st === 'UD') {
        return { status: 'in_transit', shouldUpdate: true };
    }

    // 11. Soft exceptions — flag for admin, but don't change the status.
    if (has('DELAYED', 'EXCEPTION', 'ON HOLD', 'HELD', 'ADDRESS ISSUE',
            'CONSIGNEE', 'NOT AVAILABLE', 'REFUSED', 'MISROUTED', 'REDIRECTED',
            'REJECTED')) {
        return { status: 'exception', shouldUpdate: false, needsNote: true };
    }

    // Unknown / unmapped — don't update.
    return { status: null, shouldUpdate: false };
}

// Extract sync logic into reusable function.
// Returns { changed, carrier } so callers can report accurate update counts.
async function syncSingleRequest(req) {
    let carrier = detectCarrier(req);
    let changed = false;

    // Self-heal: if the stored carrier disagrees with the smart detection,
    // correct it so the DB, dashboard filter and next sync are accurate.
    // Only heal when there is real evidence (AWB / shipment id / fallback reason)
    // so a signal-less pending request isn't locked to the default carrier.
    const hasCarrierEvidence = !!(req.awbNumber || req.shipmentId || req.carrierFallbackReason);
    if (carrier && hasCarrierEvidence && req.carrier !== carrier) {
        try {
            await updateRequestStatus(req.requestId, { carrier });
            console.log(`[${req.requestId}] Carrier self-healed: ${req.carrier || 'none'} → ${carrier}`);
            req.carrier = carrier;
        } catch (e) {
            console.warn(`[${req.requestId}] Carrier self-heal failed: ${e.message}`);
        }
    }

    // Return shipment sync
    if (['pending', 'pickup_pending', 'pickup_booked', 'scheduled', 'picked_up', 'in_transit', 'out_for_delivery'].includes(req.status)) {
        let trackingData = null;
        let currentStatus = null;
        let currentStatusType = null;
        let newAwb = null;
        let edd = null;
        
        // Fetch tracking based on carrier
        if (req.awbNumber) {
            try {
                if (carrier === 'delhivery') {
                    console.log(`[${req.requestId}] Fetching Delhivery tracking for AWB: ${req.awbNumber}`);
                    trackingData = await getDelhiveryTracking(req.awbNumber);
                    
                    if (trackingData && trackingData.shipments && trackingData.shipments.length > 0) {
                        const shipment = trackingData.shipments[0];
                        currentStatus = shipment.status || shipment.delivered_status;
                        currentStatusType = shipment.status_type || null;
                        newAwb = shipment.waybill_code || req.awbNumber;
                        edd = shipment.eta || null;
                    }
                } else if (carrier === 'ekart') {
                    console.log(`[${req.requestId}] Fetching Ekart tracking for AWB: ${req.awbNumber}`);
                    trackingData = await getEkartTracking(req.awbNumber);
                    
                    if (trackingData && trackingData.shipments && trackingData.shipments.length > 0) {
                        const shipment = trackingData.shipments[0];
                        currentStatus = shipment.status || shipment.delivered_status;
                        currentStatusType = shipment.status_type || null;
                        newAwb = shipment.waybill_code || req.awbNumber;
                        edd = shipment.edd || shipment.eta || null;
                    }
                } else {
                    // Shiprocket
                    trackingData = await shiprocketAPI(`/courier/track/awb/${req.awbNumber}`);
                    
                    if (trackingData && trackingData.tracking_data) {
                        const tracking = trackingData.tracking_data;
                        currentStatus = tracking.shipment_track?.[0]?.current_status || tracking.current_status;
                        newAwb = tracking.shipment_track?.[0]?.awb_code || tracking.awb_code;
                        edd = tracking.edd || tracking.etd || null;
                    }
                }
            } catch (e) {
                console.warn(`[Sync] ${carrier} AWB ${req.awbNumber} (${req.requestId}) fetch failed: ${e.message}`);
            }
        }
        
        // Fallback to shipment ID for Shiprocket
        if (!currentStatus && carrier === 'shiprocket' && req.shipmentId) {
            try { 
                trackingData = await shiprocketAPI(`/courier/track/shipment/${req.shipmentId}`);
                if (trackingData && trackingData.tracking_data) {
                    const tracking = trackingData.tracking_data;
                    currentStatus = tracking.shipment_track?.[0]?.current_status || tracking.current_status;
                }
            } catch (e) {
                console.warn(`[Sync] Shiprocket ShipmentID ${req.shipmentId} (${req.requestId}) fetch failed: ${e.message}`);
            }
        }
        
        // Cross-carrier rescue: a request mislabeled as Shiprocket but carrying a
        // Delhivery-format waybill (all digits, 12+ chars) can never be tracked via
        // Shiprocket. Try our Delhivery account and self-heal the stored carrier.
        if (!currentStatus && carrier === 'shiprocket' && req.awbNumber &&
            /^\d{12,}$/.test(req.awbNumber.toString().trim())) {
            try {
                const dlvData = await getDelhiveryTracking(req.awbNumber);
                if (dlvData && dlvData.shipments && dlvData.shipments.length > 0) {
                    const shipment = dlvData.shipments[0];
                    if (shipment.status || shipment.status_type) {
                        trackingData = dlvData;
                        currentStatus = shipment.status || shipment.delivered_status;
                        currentStatusType = shipment.status_type || null;
                        newAwb = shipment.waybill_code || req.awbNumber;
                        carrier = 'delhivery';
                        console.log(`[${req.requestId}] Cross-carrier rescue: AWB ${req.awbNumber} found on Delhivery (status: ${currentStatus})`);
                        try {
                            await updateRequestStatus(req.requestId, { carrier: 'delhivery' });
                            req.carrier = 'delhivery';
                        } catch (healErr) {
                            console.warn(`[${req.requestId}] Carrier heal to delhivery failed: ${healErr.message}`);
                        }
                    }
                }
            } catch (e) {
                console.warn(`[Sync] Cross-carrier Delhivery check for AWB ${req.awbNumber} (${req.requestId}) failed: ${e.message}`);
            }
        }
        
        // Process tracking data
        if (currentStatus) {
            const statusMapping = mapCarrierStatus(currentStatus, carrier, currentStatusType);
            
            if (statusMapping && statusMapping.shouldUpdate && statusMapping.status) {
                let newStatus = statusMapping.status;

                // Only advance forward — never regress on a stale/duplicate
                // scan. EXCEPTION: terminal carrier states (cancelled / lost /
                // RTO) always override, because the carrier is authoritative —
                // a request must never stay out_for_delivery/in_transit when
                // the carrier has cancelled the shipment.
                if (newStatus !== req.status &&
                    (statusMapping.terminal || isForwardProgress(req.status, newStatus))) {
                    // Build update object
                    const updates = { status: newStatus, lastSyncedAt: new Date().toISOString() };
                    if (newStatus === 'delivered') updates.deliveredAt = new Date().toISOString();
                    if (newStatus === 'picked_up') updates.pickedUpAt = new Date().toISOString();
                    if (newStatus === 'in_transit') updates.inTransitAt = new Date().toISOString();
                    if (newStatus === 'out_for_delivery') updates.outForDeliveryAt = new Date().toISOString();
                    if (newAwb && newAwb !== req.awbNumber) updates.awbNumber = newAwb;
                    // Persist EDD and carrier name from carrier API
                    if (edd) updates.expectedDeliveryDate = edd;
                    updates.carrierName = carrier.charAt(0).toUpperCase() + carrier.slice(1);

                    await updateRequestStatus(req.requestId, updates);
                    changed = true;
                    console.log(`[${req.requestId}] Status updated: ${req.status} → ${newStatus} (${carrier})${edd ? ' EDD=' + edd : ''}`);
                } else if (newAwb && newAwb !== req.awbNumber) {
                    // Status unchanged but AWB refreshed
                    const updates = { awbNumber: newAwb, lastSyncedAt: new Date().toISOString() };
                    if (edd) updates.expectedDeliveryDate = edd;
                    await updateRequestStatus(req.requestId, updates);
                } else if (edd && edd !== req.expectedDeliveryDate) {
                    // EDD updated even if status unchanged
                    await updateRequestStatus(req.requestId, { expectedDeliveryDate: edd, lastSyncedAt: new Date().toISOString() });
                }
            } else if (edd && edd !== req.expectedDeliveryDate) {
                // No status mapping but EDD available — persist it
                await updateRequestStatus(req.requestId, { expectedDeliveryDate: edd, lastSyncedAt: new Date().toISOString() });
            }
            
            // Add admin note for exception statuses
            if (statusMapping && statusMapping.needsNote) {
                const note = `\n[Sync Log ${new Date().toLocaleDateString('en-IN')}] ${carrier} status: ${currentStatus}`;
                if (!req.adminNotes || !req.adminNotes.includes(currentStatus)) {
                    await updateRequestStatus(req.requestId, { 
                        adminNotes: (req.adminNotes || '') + note 
                    });
                    console.log(`[${req.requestId}] Exception note added: ${currentStatus}`);
                }
            }
        } else if (edd && edd !== req.expectedDeliveryDate) {
            // No current status but EDD available
            await updateRequestStatus(req.requestId, { expectedDeliveryDate: edd, lastSyncedAt: new Date().toISOString() });
        }
    }
    
    // Forward shipment sync for exchanges
    if (req.type === 'exchange' && req.forwardAwbNumber && req.forwardStatus !== 'delivered') {
        try {
            const forwardCarrier = detectCarrierForAwb(
                req.forwardAwbNumber,
                req.forwardShipmentId,
                req.forwardCarrier,
                req.carrierFallbackReason
            );
            let forwardTrack = null;
            let forwardCurrentStatus = null;
            let forwardStatusType = null;
            let forwardEdd = null;
            
            if (forwardCarrier === 'delhivery') {
                console.log(`[${req.requestId}] Fetching Delhivery forward tracking for AWB: ${req.forwardAwbNumber}`);
                forwardTrack = await getDelhiveryTracking(req.forwardAwbNumber);
                
                if (forwardTrack && forwardTrack.shipments && forwardTrack.shipments.length > 0) {
                    const shipment = forwardTrack.shipments[0];
                    forwardCurrentStatus = shipment.status || shipment.delivered_status;
                    forwardStatusType = shipment.status_type || null;
                    forwardEdd = shipment.eta || null;
                }
            } else if (forwardCarrier === 'ekart') {
                console.log(`[${req.requestId}] Fetching Ekart forward tracking for AWB: ${req.forwardAwbNumber}`);
                forwardTrack = await getEkartTracking(req.forwardAwbNumber);
                
                if (forwardTrack && forwardTrack.shipments && forwardTrack.shipments.length > 0) {
                    const shipment = forwardTrack.shipments[0];
                    forwardCurrentStatus = shipment.status || shipment.delivered_status;
                    forwardStatusType = shipment.status_type || null;
                    forwardEdd = shipment.edd || shipment.eta || null;
                }
            } else {
                // Shiprocket
                forwardTrack = await shiprocketAPI(`/courier/track/awb/${req.forwardAwbNumber}`);
                
                if (forwardTrack && forwardTrack.tracking_data) {
                    const tracking = forwardTrack.tracking_data;
                    forwardCurrentStatus = tracking.shipment_track?.[0]?.current_status || tracking.current_status;
                    forwardEdd = tracking.edd || tracking.etd || null;
                }
            }
            
            if (forwardCurrentStatus) {
                const forwardStatusMapping = mapCarrierStatus(forwardCurrentStatus, forwardCarrier, forwardStatusType);
                
                if (forwardStatusMapping && forwardStatusMapping.shouldUpdate && forwardStatusMapping.status) {
                    const newForwardStatus = forwardStatusMapping.status;
                    
                    // Only advance forward — never regress on a stale/duplicate
                    // scan, EXCEPT terminal carrier states (cancelled / lost /
                    // RTO) which always override a stale forward status.
                    if (newForwardStatus !== req.forwardStatus &&
                        (forwardStatusMapping.terminal ||
                         isForwardProgress(req.forwardStatus, newForwardStatus))) {
                        console.log(`[${req.requestId}] Updating Forward Status: ${req.forwardStatus} → ${newForwardStatus} (${forwardCarrier})`);
                        const fwdUpdates = { forwardStatus: newForwardStatus, lastSyncedAt: new Date().toISOString() };
                        if (forwardEdd) fwdUpdates.forwardExpectedDeliveryDate = forwardEdd;
                        fwdUpdates.forwardCarrierName = forwardCarrier.charAt(0).toUpperCase() + forwardCarrier.slice(1);
                        await updateRequestStatus(req.requestId, fwdUpdates);
                        changed = true;
                    }
                }
                
                // Persist forward EDD even if status unchanged
                if (forwardEdd && forwardEdd !== req.forwardExpectedDeliveryDate) {
                    await updateRequestStatus(req.requestId, { forwardExpectedDeliveryDate: forwardEdd, lastSyncedAt: new Date().toISOString() });
                }
                
                // Add note for forward exceptions
                if (forwardStatusMapping && forwardStatusMapping.needsNote) {
                    const note = `\n[Forward Sync Log ${new Date().toLocaleDateString('en-IN')}] ${forwardCarrier} status: ${forwardCurrentStatus}`;
                    if (!req.adminNotes || !req.adminNotes.includes(forwardCurrentStatus)) {
                        await updateRequestStatus(req.requestId, { 
                            adminNotes: (req.adminNotes || '') + note 
                        });
                    }
                }
            } else if (forwardEdd && forwardEdd !== req.forwardExpectedDeliveryDate) {
                // No status but EDD available
                await updateRequestStatus(req.requestId, { forwardExpectedDeliveryDate: forwardEdd, lastSyncedAt: new Date().toISOString() });
            }
        } catch (e) {
            console.error(`[${req.requestId}] Forward Sync Failed:`, e.message);
        }
    }

    return { changed, carrier };
}

// Schedule sync to run hourly so carrier-side cancellations/RTOs surface
// quickly instead of lingering as stale out-for-delivery/in-transit.
// Cron format: minute hour * * *
cron.schedule('0 * * * *', () => {
    performBackgroundSync();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" // IST timezone
});

// Run initial sync on server startup (after 30 seconds to allow full initialization)
setTimeout(() => {
    console.log('[Background Sync] Running initial sync on startup...');
    performBackgroundSync();
}, 30000);

console.log('✅ Background sync scheduled: hourly (IST timezone)');

// ==================== SHOPIFY INFLUENCER USAGE SYNC ====================

// Background sync job for Shopify discount code usage - runs 4 times per day (6AM, 12PM, 6PM, 12AM IST)
let isShopifySyncRunning = false;
let lastShopifySyncTimestamp = null;

async function performShopifyUsageSync() {
    if (isShopifySyncRunning) {
        console.log('[Shopify Usage Sync] Sync already running, skipping...');
        return;
    }

    isShopifySyncRunning = true;
    lastShopifySyncTimestamp = new Date().toISOString();
    const syncStartedAt = new Date();

    console.log('[Shopify Usage Sync] Starting Shopify usage & stats sync (INCREMENTAL)...');

    try {

        // Fetch all active influencers and build a code -> influencer map
        const { data: influencers, error } = await supabase
            .from('influencers')
            .select('*')
            .eq('is_active', true);

        if (error) {
            console.error('[Shopify Usage Sync] Error fetching influencers:', error);
            return;
        }

        const codeToInfluencer = new Map();
        for (const inf of influencers) {
            if (inf.referral_code) {
                codeToInfluencer.set(inf.referral_code.toUpperCase(), inf);
            }
        }

        // Read last sync timestamp for incremental fetch
        let updatedAtMin = null;
        try {
            const { data: meta } = await supabase
                .from('sync_metadata')
                .select('value')
                .eq('key', 'last_shopify_order_sync')
                .single();
            if (meta && meta.value) {
                updatedAtMin = meta.value;
            }
        } catch (e) {
            // sync_metadata table may not exist yet; fall back to full scan
            console.log('[Shopify Usage Sync] sync_metadata missing, using 180-day fallback');
        }

        if (!updatedAtMin) {
            // First run: fetch last 180 days
            const d = new Date();
            d.setDate(d.getDate() - 180);
            updatedAtMin = d.toISOString();
            console.log(`[Shopify Usage Sync] First run - fetching last 180 days since ${updatedAtMin}`);
        } else {
            console.log(`[Shopify Usage Sync] Incremental fetch since ${updatedAtMin}`);
        }

        // Fetch orders from Shopify using updated_at_min so we catch both new and modified orders
        let nextUrl = `orders.json?status=any&limit=250&fields=id,name,total_price,discount_codes,created_at,updated_at,currency,financial_status,fulfillment_status,cancelled_at,customer&updated_at_min=${encodeURIComponent(updatedAtMin)}`;
        let pageCount = 0;
        let totalFetched = 0;
        let upsertedCount = 0;
        const affectedInfluencerIds = new Set();

        while (nextUrl && pageCount < 40) {
            pageCount++;

            const fullUrl = nextUrl.startsWith('http') ? nextUrl : `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/${nextUrl}`;
            const response = await fetch(fullUrl, {
                headers: {
                    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error(`[Shopify Usage Sync] ❌ Shopify API error ${response.status}`);
                break;
            }

            const data = await response.json();
            const batch = data.orders || [];
            totalFetched += batch.length;

            // Filter to orders that use a tracked influencer's code, then map to DB rows
            const rows = [];
            for (const order of batch) {
                if (!order.discount_codes || order.discount_codes.length === 0) continue;

                // Find the first matching influencer code on this order
                let matchedInfluencer = null;
                let matchedCode = null;
                for (const dc of order.discount_codes) {
                    const up = (dc.code || '').toUpperCase();
                    const inf = codeToInfluencer.get(up);
                    if (inf) {
                        matchedInfluencer = inf;
                        matchedCode = dc.code;
                        break;
                    }
                }
                if (!matchedInfluencer) continue;

                const customerName = order.customer
                    ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || 'Guest'
                    : 'Guest';

                rows.push({
                    shopify_order_id: order.id,
                    influencer_id: matchedInfluencer.id,
                    referral_code: matchedCode,
                    order_name: order.name,
                    total_price: parseFloat(order.total_price || 0),
                    currency: order.currency || 'INR',
                    financial_status: order.financial_status,
                    fulfillment_status: order.fulfillment_status,
                    customer_name: customerName,
                    cancelled_at: order.cancelled_at,
                    order_created_at: order.created_at,
                    order_updated_at: order.updated_at,
                    synced_at: new Date().toISOString()
                });
                affectedInfluencerIds.add(matchedInfluencer.id);
            }

            // Batch upsert to influencer_orders
            if (rows.length > 0) {
                const { error: upsertErr } = await supabase
                    .from('influencer_orders')
                    .upsert(rows, { onConflict: 'shopify_order_id' });
                if (upsertErr) {
                    console.error(`[Shopify Usage Sync] ❌ Upsert error:`, upsertErr.message);
                } else {
                    upsertedCount += rows.length;
                }
            }

            console.log(`[Shopify Usage Sync] Page ${pageCount}: ${batch.length} orders (matched: ${rows.length}, upserted total: ${upsertedCount})`);

            // Extract next URL from Link header (lowercase 'link')
            const linkHeader = response.headers.get('link');
            nextUrl = null;
            if (linkHeader) {
                const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (matches) {
                    nextUrl = matches[1];
                }
            }
        }

        console.log(`[Shopify Usage Sync] ✅ Fetched ${totalFetched} orders, upserted ${upsertedCount} attributed orders`);

        // Recalculate aggregate stats for affected influencers using the DB table
        let syncedCount = 0;
        let failedCount = 0;

        // Also recalculate for ALL influencers on first run (updatedAtMin was 180 days ago)
        const influencersToRefresh = affectedInfluencerIds.size > 0
            ? influencers.filter(i => affectedInfluencerIds.has(i.id))
            : influencers;

        for (const influencer of influencersToRefresh) {
            try {
                // Aggregate stats from influencer_orders table (paid, non-cancelled only)
                const { data: orderRows, error: aggErr } = await supabase
                    .from('influencer_orders')
                    .select('total_price, financial_status, cancelled_at, order_created_at, order_name, currency, customer_name, shopify_order_id')
                    .eq('influencer_id', influencer.id)
                    .is('cancelled_at', null)
                    .in('financial_status', ['paid', 'partially_paid', 'pending', 'authorized'])
                    .order('order_created_at', { ascending: false });

                if (aggErr) {
                    console.error(`[Shopify Usage Sync] ❌ ${influencer.name} - Aggregate error:`, aggErr.message);
                    failedCount++;
                    continue;
                }

                const usageCount = (orderRows || []).length;
                const totalRevenue = (orderRows || []).reduce((s, r) => s + parseFloat(r.total_price || 0), 0);
                const commissionRate = parseFloat(influencer.commission_rate || 7);
                const estimatedEarnings = totalRevenue * (commissionRate / 100);

                // Cache top 20 recent conversions as JSONB for zero-query admin rendering
                const recentCache = (orderRows || []).slice(0, 20).map(r => ({
                    id: r.shopify_order_id,
                    orderName: r.order_name,
                    total: parseFloat(r.total_price).toFixed(2),
                    currency: r.currency || 'INR',
                    date: r.order_created_at,
                    customerName: r.customer_name || 'Guest'
                }));

                const { error: updateError } = await supabase
                    .from('influencers')
                    .update({
                        usage_count: usageCount,
                        total_revenue: totalRevenue,
                        total_orders: usageCount,
                        estimated_earnings: estimatedEarnings,
                        stats_last_updated: new Date().toISOString(),
                        stats_date_range: 'all_time',
                        last_synced_at: new Date().toISOString(),
                        recent_conversions_cache: recentCache,
                        recent_conversions_updated_at: new Date().toISOString()
                    })
                    .eq('id', influencer.id);

                if (updateError) {
                    console.error(`[Shopify Usage Sync] ❌ ${influencer.name} - Error updating: ${updateError.message}`);
                    failedCount++;
                } else {
                    console.log(`[Shopify Usage Sync] ✅ ${influencer.name} (${influencer.referral_code}) - Orders: ${usageCount}, Revenue: ₹${totalRevenue.toFixed(2)}, Earnings: ₹${estimatedEarnings.toFixed(2)}`);
                    syncedCount++;
                }
            } catch (err) {
                console.error(`[Shopify Usage Sync] ❌ ${influencer.name} - Error: ${err.message}`);
                failedCount++;
            }
        }

        // Feed coupon orders into the athlete program (attributed_orders + order XP)
        // and re-check comfort levels for anyone whose XP moved.
        try {
            const { AttributionService, LevelEngine } = require('./services/athlete-program');
            const attribution = await AttributionService.syncFromInfluencerOrders();
            for (const influencerId of attribution.affectedInfluencerIds) {
                try {
                    await LevelEngine.evaluate(influencerId);
                } catch (e) {
                    console.error(`[Shopify Usage Sync] Level evaluation failed for ${influencerId}:`, e.message);
                }
            }
        } catch (e) {
            console.error('[Shopify Usage Sync] Athlete attribution sync failed:', e.message);
        }

        // Persist the sync watermark (use start time so we don't miss orders updated mid-sync)
        try {
            await supabase
                .from('sync_metadata')
                .upsert({
                    key: 'last_shopify_order_sync',
                    value: syncStartedAt.toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
        } catch (e) {
            console.error('[Shopify Usage Sync] Failed to update sync watermark:', e.message);
        }

        console.log(`\n[Shopify Usage Sync] ✅ Completed: ${syncedCount} synced, ${failedCount} failed, ${totalFetched} orders scanned, ${upsertedCount} upserted`);

    } catch (error) {
        console.error('[Shopify Usage Sync] Fatal error:', error);
    } finally {
        isShopifySyncRunning = false;
    }
}

// Schedule Shopify usage sync - 4 times daily (6AM, 12PM, 6PM, 12AM IST)
cron.schedule('0 0,6,12,18 * * *', () => {
    performShopifyUsageSync();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" // IST timezone
});

// Run initial Shopify usage sync on server startup (after 45 seconds)
setTimeout(() => {
    console.log('[Shopify Usage Sync] Running initial sync on startup...');
    performShopifyUsageSync();
}, 45000);

console.log('✅ Shopify influencer usage sync scheduled: 4 times daily (6AM, 12PM, 6PM, 12AM IST)');

// ==================== MARKETING CRON JOBS ====================
// Abandoned cart reminders - every 30 minutes
cron.schedule('*/30 * * * *', () => {
    processAbandonedCartReminders();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
console.log('✅ Marketing: Abandoned cart reminders scheduled (every 30 minutes)');

// Recovery scan - every 6 hours, check Shopify orders against abandoned carts
cron.schedule('0 */6 * * *', async () => {
    try {
        if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_STORE) return;
        console.log('[Marketing Cron] Running recovery scan...');
        const result = await scanShopifyOrdersForRecoveries();
        console.log(`[Marketing Cron] Recovery scan complete: ${result.recoveredCount} new recoveries from ${result.scannedOrders} orders`);
    } catch (err) {
        console.error('[Marketing Cron] Recovery scan error:', err.message);
    }
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
console.log('✅ Marketing: Recovery scan scheduled (every 6 hours)');

// Daily analytics aggregation - at 2AM IST
cron.schedule('0 2 * * *', () => {
    aggregateDailyMarketingAnalytics();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
console.log('✅ Marketing: Daily analytics aggregation scheduled (2AM IST)');

// ==================== CLOUDINARY CONFIG ====================

let uploadStorage;
try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        throw new Error('Missing Cloudinary Environment Variables');
    }

    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });

    uploadStorage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: 'returns',
            allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'heic', 'heif'],
        },
    });
    console.log('✅ Cloudinary storage configured successfully');
} catch (error) {
    console.error('⚠️ Cloudinary configuration failed:', error.message);
    console.warn('⚠️ Falling back to MemoryStorage (Warning: High RAM usage with multiple uploads)');
    uploadStorage = multer.memoryStorage();
}

// 20MB per file — phone photos/videos can exceed busboy's default limit
const MAX_UPLOAD_FILE_SIZE = 20 * 1024 * 1024;
const upload = multer({
    storage: uploadStorage,
    limits: {
        fileSize: MAX_UPLOAD_FILE_SIZE,
        files: 10,
        fieldSize: 2 * 1024 * 1024, // large items JSON payloads
    },
});

// ==================== RAZORPAY CONFIG ====================
let razorpay;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('✅ Razorpay initialized');
} else {
    console.warn('⚠️ Razorpay credentials missing - Payments may fail or be unverified');
}

// ==================== OAUTH ROUTES ====================

// Start OAuth installation
app.get('/auth/install', (req, res) => {
    const shop = process.env.SHOPIFY_STORE;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const redirectUri = process.env.SHOPIFY_REDIRECT_URI;
    // write_price_rules covers the classic price_rules.json calls already
    // in use (influencer/abandoned-cart codes, and previously bundle/
    // compensation too); write_discounts is separately required for the
    // newer GraphQL discountCodeBasicCreate mutation (bundle + compensation
    // coupons now use it so they can combine with each other) - Shopify
    // treats these as two distinct scopes, granting one doesn't imply the
    // other. This string was already missing write_price_rules despite it
    // being relied on elsewhere, meaning the actually-installed token's
    // real scopes come from whatever was granted at install time, not
    // necessarily this constant - a re-authorization is what actually
    // updates the live token if a scope here is missing from it.
    const scopes = 'read_orders,write_orders,read_products,read_customers,write_price_rules,write_discounts';

    const state = crypto.randomBytes(16).toString('hex');
    storage.oauthState = state;


    const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}&state=${state}`;

    res.redirect(authUrl);
});

// OAuth callback - Protected in production
app.get('/auth/callback', async (req, res) => {
    // Block OAuth callback in production if already configured
    if (isProduction && process.env.SHOPIFY_ACCESS_TOKEN) {
        return res.status(403).json({ error: 'OAuth callback is disabled in production. Shopify is already configured.' });
    }

    const { code, shop } = req.query;

    // Validate that we have the required parameters
    if (!code || !shop) {
        return res.status(400).json({ error: 'Invalid OAuth callback - missing code or shop parameter' });
    }

    // Verify shop matches our configured store
    if (shop !== process.env.SHOPIFY_STORE) {
        return res.status(400).json({ error: 'Invalid OAuth callback - shop mismatch' });
    }

    try {
        // Exchange code for access token
        const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.SHOPIFY_CLIENT_ID,
                client_secret: process.env.SHOPIFY_CLIENT_SECRET,
                code
            })
        });

        const data = await tokenResponse.json();
        storage.accessToken = data.access_token;

        // In production, don't expose the token in the response
        if (isProduction) {
            return res.json({ 
                success: true, 
                message: 'Authorization successful. Token has been stored securely.' 
            });
        }

        // Development only: Show token for setup
        res.send(`
      <h1>✅ Authorization Successful!</h1>
      <h2>Your Access Token:</h2>
      <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-wrap: break-word;">${data.access_token}</pre>
      <p><strong>IMPORTANT:</strong> Copy this token and add it to your Render environment variables as <code>SHOPIFY_ACCESS_TOKEN</code></p>
      <p>After adding the token, your service will be fully operational!</p>
    `);
    } catch (error) {
        res.status(500).send(`OAuth error: ${error.message}`);
    }
});

// ==================== API RETRY HELPER ====================

/**
 * A wrapper around fetch that retries on network errors (like ECONNRESET)
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {number} retries - Maximum number of retries
 * @param {number} backoff - Initial backoff delay in ms
 */
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            return response;
        } catch (error) {
            // If it's the last retry, throw the error
            if (i === retries - 1) throw error;

            console.warn(`[Network Retry] Attempt ${i + 1}/${retries} failed for ${url}. Error: ${error.message}. Retrying in ${backoff}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            backoff *= 2; // Exponential backoff
        }
    }
}

// ==================== SHOPIFY API HELPER ====================

async function shopifyAPI(endpoint, options = {}) {
    const token = process.env.SHOPIFY_ACCESS_TOKEN || storage.accessToken;
    const shop = process.env.SHOPIFY_STORE;

    if (!token) {
        throw new Error('Not authorized. Please complete OAuth flow first.');
    }

    // Check if endpoint is already a full URL (from pagination Link header)
    const isFullUrl = endpoint.startsWith('http');
    const url = isFullUrl ? endpoint : `https://${shop}/admin/api/2024-01/${endpoint}`;

    const response = await fetchWithRetry(url, {
        ...options,
        headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Extract FULL next URL from Link header (not just page_info)
    const linkHeader = response.headers.get('Link');
    if (linkHeader) {
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
            data.nextUrl = nextMatch[1]; // Store the full URL
        }
    }
    
    return data;
}

// Same auth/store as shopifyAPI, but for the GraphQL Admin API - needed for
// anything using Shopify's newer discount-combination system (combinesWith),
// which the classic price_rules.json REST resource has no field for at all.
async function shopifyGraphQL(query, variables = {}) {
    const token = process.env.SHOPIFY_ACCESS_TOKEN || storage.accessToken;
    const shop = process.env.SHOPIFY_STORE;

    if (!token) {
        throw new Error('Not authorized. Please complete OAuth flow first.');
    }

    const response = await fetchWithRetry(`https://${shop}/admin/api/2024-01/graphql.json`, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify GraphQL error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (data.errors) {
        throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
}

// ==================== FETCH ALL SHOPIFY PRODUCTS (CURSOR PAGINATION) ====================

// In-memory product cache (refreshes every 5 minutes)
let _shopifyProductCache = { data: null, timestamp: 0 };
const PRODUCT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAllShopifyProducts(forceRefresh = false) {
    // Return cached data if still fresh
    if (!forceRefresh && _shopifyProductCache.data && (Date.now() - _shopifyProductCache.timestamp < PRODUCT_CACHE_TTL)) {
        return _shopifyProductCache.data;
    }
    
    let allProducts = [];
    let endpoint = `products.json?limit=250&status=active&fields=id,title,handle,body_html,images,image,variants,product_type,vendor,tags`;
    let pageCount = 0;
    const MAX_PAGES = 20; // Safety limit (250 * 20 = 5000 products max)
    
    while (endpoint && pageCount < MAX_PAGES) {
        const data = await shopifyAPI(endpoint);
        const products = data.products || [];
        allProducts = allProducts.concat(products);
        pageCount++;
        
        // Follow cursor pagination via nextUrl from Link header
        if (data.nextUrl) {
            endpoint = data.nextUrl; // shopifyAPI handles full URLs
        } else {
            break;
        }
    }
    
    console.log(`[Shopify] Fetched ${allProducts.length} total active products across ${pageCount} page(s)`);
    
    // Cache the results
    _shopifyProductCache = { data: allProducts, timestamp: Date.now() };
    return allProducts;
}

// Filter products to only those with inventory > 0
function filterProductsWithInventory(products) {
    return products
        .map(p => {
            const availableVariants = (p.variants || []).filter(v => v.inventory_quantity > 0);
            if (availableVariants.length === 0) return null;
            return { ...p, variants: availableVariants };
        })
        .filter(Boolean);
}

// ==================== SHOPIFY DISCOUNT CODE HELPERS ====================

async function createShopifyDiscountCode(code, value, valueType, usageLimit, title) {
    try {
        // Backward compatibility: if valueType is a number, shift arguments
        let finalValueType, finalUsageLimit, finalTitle, finalValue;
        
        if (typeof valueType === 'number') {
            // Old signature: createShopifyDiscountCode(code, percentage, usageLimit, title)
            finalValueType = 'percentage';
            finalUsageLimit = valueType;
            finalTitle = usageLimit;
            finalValue = `-${value}`;
        } else {
            // New signature: createShopifyDiscountCode(code, value, valueType, usageLimit, title)
            finalValueType = valueType || 'percentage';
            finalUsageLimit = usageLimit;
            finalTitle = title;
            finalValue = typeof value === 'string' ? value : `-${value}`;
        }

        // --- DUPLICATE CHECK: search for existing discount code before creating ---
        const upperCode = code.toUpperCase();
        try {
            // Use Shopify's direct discount code search (single API call, no pagination)
            const searchResp = await shopifyAPI(`discount_codes.json?code=${encodeURIComponent(upperCode)}`);
            const existingCodes = searchResp.discount_codes || [];
            const match = existingCodes.find(c => c.code && c.code.toUpperCase() === upperCode);
            if (match) {
                console.log(`♻️  Discount code ${upperCode} already exists (Price Rule: ${match.price_rule_id}, Code ID: ${match.id}), updating value to ${finalValue} (${finalValueType})`);
                // UPDATE the existing price rule with the admin's new value — never silently skip
                try {
                    await shopifyAPI(`price_rules/${match.price_rule_id}.json`, {
                        method: 'PUT',
                        body: JSON.stringify({
                            price_rule: {
                                value: finalValue,
                                value_type: finalValueType
                            }
                        })
                    });
                    console.log(`✅ Updated existing price rule ${match.price_rule_id} value to ${finalValue}`);
                } catch (updateErr) {
                    console.warn(`⚠️ Could not update existing price rule ${match.price_rule_id}:`, updateErr.message);
                }
                return { priceRuleId: match.price_rule_id, discountCodeId: match.id, code: upperCode };
            }
        } catch (searchErr) {
            console.warn('⚠️ Could not search existing discount codes, proceeding with creation:', searchErr.message);
        }
        // --- END DUPLICATE CHECK ---

        // Step 1: Create Price Rule
        console.log(`[createShopifyDiscount] Creating price rule for ${code.toUpperCase()}: value_type=${finalValueType}, value=${finalValue}, usage_limit=${finalUsageLimit || 'unlimited'}`);
        const priceRulePayload = {
            price_rule: {
                title: finalTitle || `Influencer: ${code}`,
                target_type: 'line_item',
                target_selection: 'all',
                allocation_method: 'across',
                value_type: finalValueType,
                value: finalValue,
                customer_selection: 'all',
                once_per_customer: finalValueType === 'fixed_amount' ? true : false,
                starts_at: new Date().toISOString()
            }
        };

        // Set usage_limit on price_rule itself (total uses across all customers)
        if (finalUsageLimit && finalUsageLimit > 0) {
            priceRulePayload.price_rule.usage_limit = finalUsageLimit;
        }

        const priceRuleResponse = await shopifyAPI('price_rules.json', {
            method: 'POST',
            body: JSON.stringify(priceRulePayload)
        });

        const priceRuleId = priceRuleResponse.price_rule.id;

        // Step 2: Create Discount Code attached to Price Rule
        const discountCodePayload = {
            discount_code: {
                code: code.toUpperCase()
            }
        };

        const discountCodeResponse = await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`, {
            method: 'POST',
            body: JSON.stringify(discountCodePayload)
        });

        const discountCodeId = discountCodeResponse.discount_code.id;

        console.log(`✅ Created Shopify discount code: ${code.toUpperCase()} | type=${finalValueType} value=${finalValue} usage_limit=${finalUsageLimit || 'unlimited'} (Price Rule ID: ${priceRuleId}, Discount Code ID: ${discountCodeId})`);

        return { priceRuleId, discountCodeId, code: code.toUpperCase() };
    } catch (error) {
        console.error('❌ Failed to create Shopify discount code:', error.message);
        throw error;
    }
}

// Return-compensation / store-credit coupons only. Deliberately separate
// from createShopifyDiscountCode() above (which stays on the classic
// price_rules.json REST resource for influencer/abandoned-cart codes) -
// the classic resource has no combinesWith field at all, so a code created
// through it can never combine with anything, no matter what settings are
// passed. This one goes through the newer GraphQL discount API instead,
// specifically so a compensation coupon can combine with a "Build Your
// Combo" bundle coupon (see createBundleDiscountCode, which is on the same
// GraphQL system for the same reason) - each must explicitly declare it
// accepts the other's discount class, or Shopify won't combine them even
// if both support combining in general.
async function createCompensationDiscountCode(code, value, valueType, usageLimit, title) {
    const upperCode = code.toUpperCase();
    const finalValueType = valueType || 'percentage';
    const customerGetsValue = finalValueType === 'fixed_amount'
        ? { discountAmount: { amount: String(value), appliesOnEachItem: false } }
        : { percentage: value / 100 };

    // Same duplicate-safety createShopifyDiscountCode() has: if this exact
    // code already exists (e.g. an admin re-approving the same request, or
    // a retry after a network blip), UPDATE its value instead of trying to
    // create a second discount with the same code - never silently skip.
    // codeDiscountNodeByCode is a first-party exact-code lookup that finds
    // a discount regardless of which API (classic REST or this one) created
    // it, unlike the classic discount_codes.json search this replaces,
    // which wasn't guaranteed to see a discount created through this newer
    // API at all.
    try {
        const lookup = await shopifyGraphQL(
            `query FindDiscountByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`,
            { code: upperCode }
        );
        const existingId = lookup.codeDiscountNodeByCode && lookup.codeDiscountNodeByCode.id;
        if (existingId) {
            console.log(`♻️  Discount code ${upperCode} already exists (${existingId}), updating value to ${JSON.stringify(customerGetsValue)}`);
            const updateResult = await shopifyGraphQL(
                `mutation UpdateCompensationDiscount($id: ID!, $input: DiscountCodeBasicInput!) {
                    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $input) {
                        codeDiscountNode { id }
                        userErrors { field message }
                    }
                }`,
                { id: existingId, input: { customerGets: { value: customerGetsValue } } }
            );
            const updatePayload = updateResult.discountCodeBasicUpdate;
            if (updatePayload.userErrors && updatePayload.userErrors.length > 0) {
                console.warn(`⚠️ Could not update existing discount ${existingId}:`, updatePayload.userErrors.map(e => e.message).join(', '));
            } else {
                console.log(`✅ Updated existing discount code ${upperCode} (${existingId})`);
            }
            return { priceRuleId: existingId, discountCodeId: existingId, code: upperCode };
        }
    } catch (searchErr) {
        console.warn('⚠️ Could not search existing discount codes, proceeding with creation:', searchErr.message);
    }

    const input = {
        title: title || `Compensation: ${code}`,
        code: upperCode,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
            value: customerGetsValue,
            items: { all: true }
        },
        // Matches createShopifyDiscountCode()'s own rule: only fixed-amount
        // compensation is capped to one use per customer; percentage-based
        // codes are left reusable, same as they've always been.
        appliesOncePerCustomer: finalValueType === 'fixed_amount',
        // Order-level discount, explicitly willing to combine with a
        // product-level one (the bundle/combo coupon) - not with another
        // order-level discount or a shipping discount, since that wasn't
        // asked for and stacking two order-wide coupons unintentionally is
        // a real margin risk.
        combinesWith: {
            orderDiscounts: false,
            productDiscounts: true,
            shippingDiscounts: false
        }
    };
    // Matches createShopifyDiscountCode()'s own guard: only a positive
    // usage limit is applied; zero/negative/absent means unlimited.
    if (usageLimit && usageLimit > 0) {
        input.usageLimit = usageLimit;
    }

    const mutation = `
        mutation CreateCompensationDiscount($input: DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount: $input) {
                codeDiscountNode {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const result = await shopifyGraphQL(mutation, { input });
    const payload = result.discountCodeBasicCreate;
    if (payload.userErrors && payload.userErrors.length > 0) {
        throw new Error(`Shopify discount create failed: ${payload.userErrors.map(e => e.message).join(', ')}`);
    }

    const nodeId = payload.codeDiscountNode.id;
    console.log(`✅ Created compensation discount code: ${upperCode} | type=${finalValueType} value=${value} usage_limit=${usageLimit || 'unlimited'} (${nodeId})`);

    return { priceRuleId: nodeId, discountCodeId: nodeId, code: upperCode };
}

// ==================== SHOPIFY REFUND HELPER ====================

/**
 * Create a Shopify refund for an order back to the customer's original payment method.
 * Fetches the order to get transaction ID and line item IDs, then creates a full refund.
 *
 * @param {string} orderNumber  - Shopify order name (e.g. "#1234" or "1234")
 * @param {number} refundAmount - Amount to refund in ₹ (rupees)
 * @param {string} reason       - 'customer' | 'declined' | 'changed_order' | 'merchant'
 * @param {string} note         - Internal note for the refund
 * @returns {Promise<{success, refundId?, refundAmount?, error?}>}
 */
async function createShopifyRefund(orderNumber, refundAmount, reason, note) {
    try {
        // Step 1: Find the Shopify order
        const orderName = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
        const orderData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

        if (!orderData.orders || orderData.orders.length === 0) {
            // Try without '#' prefix
            const bare = orderNumber.replace(/^#/, '');
            const altData = await shopifyAPI(`orders.json?name=${encodeURIComponent(bare)}&status=any&limit=1`);
            if (!altData.orders || altData.orders.length === 0) {
                return { success: false, error: `Shopify order not found: ${orderNumber}` };
            }
            orderData.orders = altData.orders;
        }

        const order = orderData.orders[0];
        const orderId = order.id;

        // Step 2: Find the successful financial transaction (capture/sale)
        const transactions = order.transactions || [];
        const saleTransaction = transactions.find(t =>
            t.kind === 'capture' || t.kind === 'sale'
        ) || transactions.find(t => t.kind === 'authorization');

        if (!saleTransaction) {
            return { success: false, error: `No refundable transaction found for order ${orderNumber}` };
        }

        // Step 3: Build refund line items from order line items
        const refundLineItems = (order.line_items || []).map(li => ({
            line_item_id: li.id,
            quantity: li.quantity,
            restock_type: 'no_restock'
        }));

        // Step 4: Create the refund
        const refundPayload = {
            refund: {
                notify: true,
                note: note || 'Return/Exchange resolution: Refund',
                reason: reason || 'customer',
                refund_line_items: refundLineItems,
                transactions: [{
                    parent_id: saleTransaction.id,
                    amount: refundAmount,
                    kind: 'refund'
                }]
            }
        };

        console.log(`[Shopify Refund] Creating refund of ₹${refundAmount} for order ${orderNumber} (order_id: ${orderId}, parent_tx: ${saleTransaction.id})`);

        const refundResult = await shopifyAPI(`orders/${orderId}/refunds.json`, {
            method: 'POST',
            body: JSON.stringify(refundPayload)
        });

        const refund = refundResult.refund;
        console.log(`[Shopify Refund] ✅ Success: Refund ID ${refund.id}, status: ${refund.status}`);

        return {
            success: true,
            refundId: refund.id,
            refundAmount: refundAmount,
            orderId: orderId,
            status: refund.status
        };
    } catch (error) {
        console.error('[Shopify Refund] ❌ Failed:', error.message);
        return { success: false, error: error.message };
    }
}

// ── Build Your Combo bundle discount ──
// Separate from createShopifyDiscountCode() above: that function uses
// target_selection: 'all' (correct for store-wide return-compensation
// codes), which would let a bundle code discount an unrelated item in the
// customer's cart instead of the actual combo pair. This one scopes
// strictly to the given variant IDs via target_selection: 'entitled'.
// variantIds holds 2 IDs for a normal combo, 3 for a TRIPLE bundle - the
// price rule itself doesn't care how many, entitled_variant_ids is just
// an array.
async function createBundleDiscountCode(variantIds, discountAmount, bundleId, combinedSubtotal) {
    const randomSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `COMBO-${randomSuffix}`;

    // Short expiry: this discount gets auto-applied to the shopper's session
    // the instant the combo is added, so it only needs to survive a normal
    // checkout, not sit around for days. Shortened from an earlier 48h,
    // which left too wide a window where the code (if not yet used) could
    // still apply to a later, unrelated cart containing one of the two
    // entitled variants.
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Anti-gaming/anti-leak floor: requires the cart to total at least the
    // combo group's own combined price, not just the discount amount. This
    // is the actual fix for a real incident: the floor was previously set
    // to discountAmount alone (e.g. 399), so a single unrelated ₹1,199 item
    // cleared it easily and got discounted by itself. Flooring at the
    // group's real combined price (e.g. ~2,498) means a lone item from the
    // group can no longer trigger it - the cart would need to independently
    // total at least the full group price on its own. Still not airtight
    // against a large unrelated cart that happens to clear this floor while
    // containing one entitled variant, but this closes the specific failure
    // mode that was actually observed in production testing.
    const subtotalFloor = combinedSubtotal && combinedSubtotal > discountAmount ? combinedSubtotal : discountAmount;

    // On the newer GraphQL discount API (not classic price_rules.json)
    // specifically so this can combine with a return-compensation coupon -
    // see createCompensationDiscountCode for the other half of that pairing
    // and why classic-API discounts can never combine with anything.
    const input = {
        title: `Build Your Combo (bundle ${bundleId})`,
        code,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt,
        customerSelection: { all: true },
        customerGets: {
            value: {
                discountAmount: { amount: String(discountAmount), appliesOnEachItem: false }
            },
            items: {
                products: {
                    productVariantsToAdd: variantIds.map(id => `gid://shopify/ProductVariant/${id}`)
                }
            }
        },
        appliesOncePerCustomer: true,
        usageLimit: 1,
        minimumRequirement: {
            subtotal: {
                greaterThanOrEqualToSubtotal: String(subtotalFloor)
            }
        },
        // Product-level discount, explicitly willing to combine with an
        // order-level one (the compensation/store-credit coupon) - not with
        // another product-level discount or a shipping discount.
        combinesWith: {
            orderDiscounts: true,
            productDiscounts: false,
            shippingDiscounts: false
        }
    };

    const mutation = `
        mutation CreateBundleDiscount($input: DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount: $input) {
                codeDiscountNode {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const result = await shopifyGraphQL(mutation, { input });
    const payload = result.discountCodeBasicCreate;
    if (payload.userErrors && payload.userErrors.length > 0) {
        throw new Error(`Bundle discount create failed: ${payload.userErrors.map(e => e.message).join(', ')}`);
    }

    const nodeId = payload.codeDiscountNode.id;
    console.log(`[bundle-discount] Created ${code} for bundle ${bundleId} (variants ${variantIds.join('+')}, -₹${discountAmount}, expires ${expiresAt})`);

    return { priceRuleId: nodeId, discountCodeId: nodeId, code };
}

// Family name comes from the product title, same convention the theme uses
// in offcomfrt-bundle-builder-content.liquid: everything before the first
// "(", lowercased, spaces/dashes/slashes stripped. Kept in sync manually -
// if that theme-side parsing convention ever changes, this must change too.
function bundleFamilyKey(productTitle) {
    const family = (productTitle || '').split('(')[0].trim();
    return family.toLowerCase().replace(/[\s\-\/]/g, '');
}

// Fetches a variant's real price and its parent product's real title
// straight from Shopify - never trusts whatever a request claims either
// value is.
async function getVariantForBundle(variantId) {
    const variantResp = await shopifyAPI(`variants/${variantId}.json`);
    const variant = variantResp.variant;
    if (!variant) throw new Error(`Variant ${variantId} not found`);
    const productResp = await shopifyAPI(`products/${variant.product_id}.json`);
    const product = productResp.product;
    if (!product) throw new Error(`Product for variant ${variantId} not found`);
    return {
        price: parseFloat(variant.price),
        familyKey: bundleFamilyKey(product.title),
        productTitle: product.title
    };
}

// Public endpoint — called by the storefront after every bundle-cart change.
// It creates one code for all active bundle groups so Shopify never needs to
// keep multiple per-bundle codes active in the same cart.
app.post('/api/bundle/create-discount', writeLimiter, async (req, res) => {
    try {
        const { variantIds, discountAmount, bundleId } = req.body;
        const requestedBundles = Array.isArray(req.body.bundles) && req.body.bundles.length
            ? req.body.bundles
            : [{ variantIds, discountAmount, bundleId }];

        if (requestedBundles.length > 12) {
            return res.status(400).json({ error: 'A maximum of 12 bundle groups is allowed' });
        }

        const bundles = await Promise.all(requestedBundles.map(async (bundle) => {
            const ids = bundle && bundle.variantIds;
            const amount = parseFloat(bundle && bundle.discountAmount);
            if (!Array.isArray(ids) || ids.length < 2 || ids.length > 3 || !bundle.bundleId) {
                throw new Error('Each bundle requires 2-3 variantIds, discountAmount, and bundleId');
            }
            if (!ids.every(id => /^\d+$/.test(String(id)))) {
                throw new Error('variantIds must all be positive integers');
            }
            const normalizedIds = ids.map(id => String(Number(id)));
            if (new Set(normalizedIds).size !== normalizedIds.length) {
                throw new Error('Each bundle must contain different variants');
            }
            if (!amount || amount <= 0) {
                throw new Error('discountAmount must be a positive number');
            }

            const variants = await Promise.all(normalizedIds.map(getVariantForBundle));
            const familyKey = variants[0].familyKey;
            if (variants.some(variant => variant.familyKey !== familyKey)) {
                throw new Error('All items in each bundle must be from the same product family');
            }

            const subtotal = variants.reduce((sum, variant) => sum + variant.price, 0);
            if (amount >= subtotal) {
                throw new Error('discountAmount cannot exceed the combined price of a bundle');
            }
            return { bundleId: String(bundle.bundleId).slice(0, 64), variantIds: normalizedIds, amount, subtotal };
        }));

        const compositeVariantIds = [...new Set(bundles.flatMap(bundle => bundle.variantIds))];
        const totalDiscount = bundles.reduce((sum, bundle) => sum + bundle.amount, 0);
        const combinedSubtotal = bundles.reduce((sum, bundle) => sum + bundle.subtotal, 0);
        const compositeBundleId = bundles.map(bundle => bundle.bundleId).join('-').slice(0, 64);
        const result = await createBundleDiscountCode(compositeVariantIds, totalDiscount, compositeBundleId, combinedSubtotal);

        res.json({ success: true, code: result.code });
    } catch (error) {
        console.error('[bundle-discount] create-discount error:', error.message);
        // TEMPORARY: surfacing the real error to diagnose the GraphQL
        // discount migration live, since Render logs aren't reachable
        // right now - revert this once the root cause is confirmed.
        res.status(500).json({ error: 'Failed to create bundle discount code', debug: error.message });
    }
});

async function updateShopifyDiscountCode(priceRuleId, newCode, newPercentage, newUsageLimit) {
    try {
        // Update percentage on Price Rule
        if (newPercentage !== undefined) {
            await shopifyAPI(`price_rules/${priceRuleId}.json`, {
                method: 'PUT',
                body: JSON.stringify({
                    price_rule: {
                        value: `-${newPercentage}`
                    }
                })
            });
        }

        // Update usage limit on Price Rule
        if (newUsageLimit !== undefined) {
            await shopifyAPI(`price_rules/${priceRuleId}.json`, {
                method: 'PUT',
                body: JSON.stringify({
                    price_rule: {
                        allocation_limit: newUsageLimit || null  // null = unlimited
                    }
                })
            });
        }

        // If code changed, create new discount code and remove old one
        if (newCode) {
            // Get existing discount codes
            const existingCodes = await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`);
            const oldCodeId = existingCodes.discount_codes?.[0]?.id;

            // Create new code
            const newCodePayload = {
                discount_code: {
                    code: newCode.toUpperCase()
                }
            };
            await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`, {
                method: 'POST',
                body: JSON.stringify(newCodePayload)
            });

            // Remove old code if exists
            if (oldCodeId) {
                await shopifyAPI(`price_rules/${priceRuleId}/discount_codes/${oldCodeId}.json`, {
                    method: 'DELETE'
                });
            }

            // Get new discount code ID
            const updatedCodes = await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`);
            const newDiscountCodeId = updatedCodes.discount_codes?.[0]?.id;

            console.log(`✅ Updated Shopify discount code to: ${newCode} (Discount Code ID: ${newDiscountCodeId})`);
            return { priceRuleId, discountCodeId: newDiscountCodeId };
        }

        console.log(`✅ Updated Shopify discount code (Price Rule ID: ${priceRuleId})`);
        return { priceRuleId };
    } catch (error) {
        console.error('❌ Failed to update Shopify discount code:', error.message);
        throw error;
    }
}

async function disableShopifyDiscountCode(priceRuleId) {
    try {
        await shopifyAPI(`price_rules/${priceRuleId}.json`, {
            method: 'PUT',
            body: JSON.stringify({
                price_rule: {
                    ends_at: new Date().toISOString()
                }
            })
        });
        console.log(`✅ Disabled Shopify discount code (Price Rule ID: ${priceRuleId})`);
    } catch (error) {
        console.error('❌ Failed to disable Shopify discount code:', error.message);
        // Don't throw - we still want to proceed with deletion even if Shopify fails
    }
}

/**
 * Create a DRAFT Shopify price rule without attaching a discount code.
 * The code is effectively unusable in Shopify until activateShopifyDiscountCode() is called.
 * Used by the influencer self-signup flow (hybrid auto-approve).
 */
async function createShopifyDiscountDraft(code, percentage, usageLimit, title) {
    try {
        const priceRulePayload = {
            price_rule: {
                title: title || `Influencer (Pending): ${code}`,
                target_type: 'line_item',
                target_selection: 'all',
                allocation_method: 'across',
                value_type: 'percentage',
                value: `-${percentage}`,
                customer_selection: 'all',
                starts_at: new Date().toISOString()
            }
        };

        const priceRuleResponse = await shopifyAPI('price_rules.json', {
            method: 'POST',
            body: JSON.stringify(priceRulePayload)
        });

        const priceRuleId = priceRuleResponse.price_rule.id;

        if (usageLimit && usageLimit > 0) {
            await shopifyAPI(`price_rules/${priceRuleId}.json`, {
                method: 'PUT',
                body: JSON.stringify({
                    price_rule: { allocation_limit: usageLimit }
                })
            });
        }

        console.log(`📝 Created DRAFT Shopify price rule for ${code} (Price Rule ID: ${priceRuleId}, no discount_code attached)`);
        return { priceRuleId };
    } catch (error) {
        console.error('❌ Failed to create Shopify discount draft:', error.message);
        throw error;
    }
}

/**
 * Activate a draft price rule by attaching the actual discount_code entry.
 * Called from the admin Approve action.
 */
async function activateShopifyDiscountCode(priceRuleId, code) {
    try {
        // Check if a discount code already exists on this price rule
        const existing = await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`);
        const existingCodes = existing.discount_codes || [];
        const upperCode = code.toUpperCase();

        // Look for an exact match
        const match = existingCodes.find(c => c.code && c.code.toUpperCase() === upperCode);
        if (match) {
            console.log(`✅ Shopify discount code ${code} already exists (Discount Code ID: ${match.id}), skipping duplicate creation`);
            return { discountCodeId: match.id };
        }

        // If other codes exist but don't match, remove them first (stale codes)
        for (const old of existingCodes) {
            try {
                await shopifyAPI(`price_rules/${priceRuleId}/discount_codes/${old.id}.json`, { method: 'DELETE' });
                console.log(`🗑️ Removed stale discount code "${old.code}" (ID: ${old.id}) from price rule ${priceRuleId}`);
            } catch (e) {
                console.warn(`⚠️ Could not remove stale code ${old.id}:`, e.message);
            }
        }

        const discountCodePayload = {
            discount_code: { code: upperCode }
        };

        const discountCodeResponse = await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`, {
            method: 'POST',
            body: JSON.stringify(discountCodePayload)
        });

        const discountCodeId = discountCodeResponse.discount_code.id;
        console.log(`✅ Activated Shopify discount code ${code} (Discount Code ID: ${discountCodeId})`);
        return { discountCodeId };
    } catch (error) {
        console.error('❌ Failed to activate Shopify discount code:', error.message);
        throw error;
    }
}

/**
 * Resolve which carrier to use based on settings and optional override
 * @param {string} carrierMode - The carrier mode setting (e.g., 'shiprocket_only', 'delhivery_only', 'ekart_only', 'shiprocket_with_fallback', 'delhivery_with_fallback', 'ekart_with_fallback')
 * @param {string} carrierOverride - Optional per-request override ('shiprocket', 'delhivery' or 'ekart')
 * @param {string} operationType - 'pickup' or 'dispatch' for logging
 * @returns {object} - { primary: 'shiprocket'|'delhivery'|'ekart', useFallback: boolean }
 */
function resolveCarrier(carrierMode, carrierOverride = null, operationType = 'pickup') {
    // Parse carrier mode to extract primary and fallback carriers
    // Format: "primary_with_fallback" (legacy) or "primary_with_secondary" (new)
    // Examples: "delhivery_with_ekart", "shiprocket_with_delhivery", "delhivery_only"
    function parseCarrierMode(mode) {
        if (mode.endsWith('_only')) {
            const primary = mode.replace('_only', '');
            return { primary, fallback: null, useFallback: false };
        }
        
        // Check for new format: "primary_with_secondary"
        const withMatch = mode.match(/^(shiprocket|delhivery|ekart)_with_(shiprocket|delhivery|ekart)$/);
        if (withMatch) {
            return { primary: withMatch[1], fallback: withMatch[2], useFallback: true };
        }
        
        // Legacy format: "primary_with_fallback" - use hardcoded fallback map
        const legacyMatch = mode.match(/^(shiprocket|delhivery|ekart)_with_fallback$/);
        if (legacyMatch) {
            const primary = legacyMatch[1];
            const fallbackMap = {
                'shiprocket': 'delhivery',
                'delhivery': 'shiprocket',
                'ekart': 'shiprocket'
            };
            return { primary, fallback: fallbackMap[primary] || 'shiprocket', useFallback: true };
        }
        
        // Invalid mode - default
        return { primary: 'shiprocket', fallback: 'delhivery', useFallback: true };
    }

    // If admin overrides on a per-request basis, use that as primary but still allow fallback
    if (carrierOverride === 'shiprocket' || carrierOverride === 'delhivery' || carrierOverride === 'ekart') {
        console.log(`[${operationType}] Carrier override: ${carrierOverride.charAt(0).toUpperCase() + carrierOverride.slice(1)} (with fallback if enabled)`);
        const parsed = parseCarrierMode(carrierMode);
        // When overriding, use the override as primary but keep the configured fallback
        const fallback = parsed.fallback && parsed.fallback !== carrierOverride ? parsed.fallback : getFallbackCarrier(carrierOverride);
        return { primary: carrierOverride, fallback, useFallback: parsed.useFallback };
    }

    // Resolve based on carrier mode setting
    const validModes = ['shiprocket_only', 'delhivery_only', 'ekart_only', 'shiprocket_with_fallback', 'delhivery_with_fallback', 'ekart_with_fallback'];
    const isValidNewFormat = /^(shiprocket|delhivery|ekart)_(only|with_(shiprocket|delhivery|ekart))$/.test(carrierMode);
    
    if (!validModes.includes(carrierMode) && !isValidNewFormat) {
        console.warn(`[${operationType}] Invalid carrier mode '${carrierMode}', defaulting to shiprocket_with_fallback`);
        carrierMode = 'shiprocket_with_fallback';
    }

    const parsed = parseCarrierMode(carrierMode);
    console.log(`[${operationType}] Resolved carrier: primary=${parsed.primary}, fallback=${parsed.fallback || 'none'}, useFallback=${parsed.useFallback}`);
    return { primary: parsed.primary, fallback: parsed.fallback, useFallback: parsed.useFallback };
}

// Fallback partner for a failed primary. Used when resolveCarrier doesn't provide a fallback
// (e.g., during carrier override when the configured fallback matches the override).
// Shiprocket falls back to Delhivery; Delhivery and Ekart fall back to Shiprocket.
function getFallbackCarrier(primaryCarrier) {
    return primaryCarrier === 'shiprocket' ? 'delhivery' : 'shiprocket';
}

// ── Unified per-carrier return pickup booking ──
// Normalizes every carrier response to { carrierUsed, awbNumber, shipmentId, pickupDate }.
// Throws with a carrier-specific message when the carrier is unconfigured or
// returns no usable shipment data (callers decide whether to fall back).
async function returnBookingAttempt(carrier, requestData, shopifyOrder) {
    if (carrier === 'shiprocket') {
        if (!process.env.SHIPROCKET_EMAIL) throw new Error('Shiprocket not configured on server');
        const d = await createShiprocketReturnOrder(requestData, shopifyOrder);
        if (!d || !d.shipment_id) throw new Error('Shiprocket did not return shipment data');
        return { carrierUsed: 'shiprocket', awbNumber: d.awb_code, shipmentId: d.shipment_id, pickupDate: d.pickup_scheduled_date };
    }
    if (carrier === 'ekart') {
        if (!ekartConfigured()) throw new Error('Ekart not configured on server');
        const d = await createEkartReturnOrder(requestData, shopifyOrder);
        if (!d || !d.waybill) throw new Error('Ekart did not return waybill data');
        return { carrierUsed: 'ekart', awbNumber: d.waybill, shipmentId: d.shipment_id, pickupDate: new Date().toISOString() };
    }
    // delhivery
    if (!process.env.DELHIVERY_API_KEY) throw new Error('Delhivery not configured on server');
    const d = await createDelhiveryReturnOrder(requestData, shopifyOrder);
    if (!d || !d.waybill) throw new Error('Delhivery did not return waybill data');
    return { carrierUsed: 'delhivery', awbNumber: d.waybill, shipmentId: d.shipment_id, pickupDate: new Date().toISOString() };
}

// Same normalization for forward (exchange dispatch) orders.
// Returns { carrierUsed, forwardOrder } or throws.
async function forwardBookingAttempt(carrier, requestData) {
    if (carrier === 'shiprocket') {
        if (!process.env.SHIPROCKET_EMAIL) throw new Error('Shiprocket not configured');
        const d = await createShiprocketForwardOrder(requestData);
        if (!d || !d.shipment_id) throw new Error('Shiprocket returned empty response');
        return { carrierUsed: 'shiprocket', forwardOrder: d };
    }
    if (carrier === 'ekart') {
        if (!ekartConfigured()) throw new Error('Ekart not configured');
        const d = await createEkartForwardOrder(requestData);
        if (!d || !d.waybill) throw new Error('Ekart returned empty response');
        return { carrierUsed: 'ekart', forwardOrder: d };
    }
    // delhivery
    if (!process.env.DELHIVERY_API_KEY) throw new Error('Delhivery not configured');
    const d = await createDelhiveryForwardOrder(requestData);
    if (!d || !d.waybill) throw new Error('Delhivery returned empty response');
    return { carrierUsed: 'delhivery', forwardOrder: d };
}

/**
 * Get the appropriate carrier mode setting based on operation type
 * @param {string} operationType - 'pickup' or 'dispatch'
 * @returns {Promise<string>} - The carrier mode setting
 */
async function getCarrierMode(operationType = 'pickup') {
    const settingKey = operationType === 'dispatch' ? 'carrier_mode_dispatch' : 'carrier_mode_pickup';
    const fallbackKey = 'carrier_mode'; // Legacy single setting for backward compatibility
    
    let carrierMode = await getSetting(settingKey, null);
    
    // Fallback to legacy carrier_mode if new setting doesn't exist
    if (!carrierMode) {
        carrierMode = await getSetting(fallbackKey, 'shiprocket_with_fallback');
    }
    
    console.log(`[${operationType}] Carrier mode setting (${settingKey}): ${carrierMode}`);
    return carrierMode;
}

// ==================== SHIPROCKET API HELPER ====================

let shiprocketToken = null;
let shiprocketTokenExpiry = null;

async function getShiprocketToken(signal) {
    // Return cached token if still valid
    if (shiprocketToken && shiprocketTokenExpiry && Date.now() < shiprocketTokenExpiry) {
        return shiprocketToken;
    }

    // Get new token
    try {
        const response = await (signal ? fetch : fetchWithRetry)('https://apiv2.shiprocket.in/v1/external/auth/login', {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: process.env.SHIPROCKET_EMAIL,
                password: process.env.SHIPROCKET_PASSWORD
            })
        });

        if (!response.ok) {
            throw new Error(`Shiprocket auth failed: ${response.status}`);
        }

        const data = await response.json();
        shiprocketToken = data.token;
        shiprocketTokenExpiry = Date.now() + (24 * 60 * 60 * 1000); // Reduce to 24 hours for safety

        return shiprocketToken;
    } catch (error) {
        console.error('Shiprocket authentication error:', error);
        throw error;
    }
}

async function shiprocketAPI(endpoint, options = {}, retries = 2) {
    let token = await getShiprocketToken();

    for (let i = 0; i <= retries; i++) {
        try {
            const response = await fetchWithRetry(`https://apiv2.shiprocket.in/v1/external${endpoint}`, {
                ...options,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                // On 401, invalidate token and retry with a fresh one
                if (response.status === 401) {
                    console.warn(`[Shiprocket 401] Token expired for ${endpoint}. Refreshing token...`);
                    shiprocketToken = null;
                    shiprocketTokenExpiry = null;
                    token = await getShiprocketToken();
                    if (i < retries) continue;
                }
                // Retry on 5xx errors
                if (response.status >= 500 && i < retries) {
                    console.warn(`[Shiprocket Retry] Status ${response.status} for ${endpoint}. Attempt ${i + 1}/${retries + 1}.`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                    continue;
                }
                throw new Error(`Shiprocket API error: ${response.status} - ${errorText}`);
            }

            return response.json();
        } catch (error) {
            if (i === retries) throw error;
            console.warn(`[Shiprocket Exception Retry] Attempt ${i + 1}/${retries + 1}. Error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}


// ==================== SHIPROCKET HELPERS ====================

/**
 * Ensures an email is valid for Shiprocket, with fallbacks.
 */
function getValidEmail(inputEmail, shopifyOrder) {
    const isValid = (email) => {
        if (!email || typeof email !== 'string') return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    };

    if (isValid(inputEmail)) return inputEmail;

    if (shopifyOrder) {
        if (isValid(shopifyOrder.email)) return shopifyOrder.email;
        if (shopifyOrder.customer && isValid(shopifyOrder.customer.email)) return shopifyOrder.customer.email;
    }

    // Default placeholder email to ensure label creation doesn't fail
    return 'returns@offcomfort.com';
}

async function createShiprocketReturnOrder(requestData, shopifyOrder) {
    try {
        const token = getShiprocketToken ? await getShiprocketToken() : null; // Ensure token function exists

        // Fetch Shopify Order if missing with robust name matching
        if (!shopifyOrder) {
            try {
                let orderName = requestData.orderNumber;
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
                    console.log(`[${requestData.requestId}] Order not found by "${orderName}", retrying with "${altName}"...`);
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                }

                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
                if (!shopifyOrder) console.warn(`[${requestData.requestId}] ⚠️ Shopify order not found even with fuzzy lookup for: ${orderName}`);
            } catch (e) {
                console.error(`[${requestData.requestId}] Failed to fetch original order:`, e);
            }
        }

        const address = shopifyOrder ? (shopifyOrder.shipping_address || (shopifyOrder.customer && shopifyOrder.customer.default_address)) : null;

        if (!address) {
            console.error(`[${requestData.requestId}] ❌ Shiprocket Error: No address found. ShopifyOrder fetched: ${!!shopifyOrder}`);
            return null;
        }

        const orderDate = new Date().toISOString().split('T')[0] + ' ' + new Date().toTimeString().split(' ')[0];

        // Fetch dynamic warehouse location settings
        const warehouseLocation = await getSetting('warehouse_location', null);

        let shippingCustomerName = 'BURB MANUFACTURES PVT LTD';
        let shippingAddress = 'VILLAGE - BAIRAWAS, NEAR GOVT. SCHOOL';
        let shippingAddress2 = '';
        let shippingCity = 'MAHENDERGARH';
        let shippingState = 'Haryana';
        let shippingCountry = 'IN';
        let shippingPincode = '123028';
        let shippingEmail = 'returns@offcomfort.com';
        let shippingPhone = '9138514222';

        if (warehouseLocation) {
            shippingCustomerName = warehouseLocation.name || shippingCustomerName;
            shippingAddress = warehouseLocation.address || warehouseLocation.address_line_1 || shippingAddress;
            shippingAddress2 = warehouseLocation.address_2 || warehouseLocation.address_line_2 || shippingAddress2;
            shippingCity = warehouseLocation.city || shippingCity;
            shippingState = warehouseLocation.state || shippingState;
            shippingCountry = warehouseLocation.country || shippingCountry;
            shippingPincode = warehouseLocation.pin_code || warehouseLocation.pincode || shippingPincode;
            shippingEmail = warehouseLocation.email || shippingEmail;
            shippingPhone = warehouseLocation.phone || shippingPhone;
        }

        const returnItems = requestData.items.map(item => ({
            name: item.name,
            sku: item.sku || String(item.variantId || item.id), // Fallback SKU
            units: parseInt(item.quantity) || 1,
            selling_price: parseFloat(item.price) || 0,
            discount: 0,
            tax: 0
        }));

        const payload = {
            order_id: requestData.requestId,
            order_date: orderDate,
            channel_id: '', // Optional

            // Pickup Details (Customer Address)
            pickup_customer_name: address.first_name,
            pickup_last_name: address.last_name || '',
            pickup_address: ((address.address1 || '') + ' ' + (address.address2 || '')).trim().substring(0, 190),
            pickup_address_2: '',
            pickup_city: address.city,
            pickup_state: address.province,
            pickup_country: address.country_code || 'IN',
            pickup_pincode: address.zip,
            pickup_email: getValidEmail(shopifyOrder?.email, shopifyOrder),
            pickup_phone: (() => {
                let rawPhone = requestData.customerPhone || address.phone || shopifyOrder?.phone || '9999999999';
                let digits = String(rawPhone).replace(/\D/g, '');
                return digits.length >= 10 ? digits.slice(-10) : '9999999999';
            })(),

            // Shipping Details (Warehouse - Destination)
            shipping_customer_name: shippingCustomerName,
            shipping_last_name: '',
            shipping_address: ((shippingAddress || '') + ' ' + (shippingAddress2 || '')).trim().substring(0, 190),
            shipping_address_2: '',
            shipping_city: shippingCity,
            shipping_state: shippingState,
            shipping_country: shippingCountry,
            shipping_pincode: shippingPincode,
            shipping_email: shippingEmail,
            shipping_phone: shippingPhone,

            order_items: returnItems,
            payment_method: 'Prepaid',
            total_discount: 0,
            sub_total: returnItems.reduce((sum, item) => sum + (item.selling_price * item.units), 0),
            length: 10,
            breadth: 10,
            height: 10,
            weight: 0.5
        };

        console.log('🚀 Creating Shiprocket Return. Payload:', JSON.stringify(payload, null, 2));

        // POST helper so we can transparently refresh an expired token and retry once.
        const postReturn = async (authToken) => {
            const response = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/return', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            return response.json();
        };

        let activeToken = token;
        let data = await postReturn(activeToken);

        // The cached token can be stale (Shiprocket returns 401/token_expired even though our
        // local 24h expiry hasn't elapsed). Invalidate it, fetch a fresh one, and retry once.
        if (data && (data.status_code === 401 || data.message === 'token_expired')) {
            console.warn('[Shiprocket 401] Return token expired. Refreshing token and retrying...');
            shiprocketToken = null;
            shiprocketTokenExpiry = null;
            activeToken = await getShiprocketToken();
            data = await postReturn(activeToken);
        }

        console.log('📦 Shiprocket Response:', JSON.stringify(data, null, 2));

        if (
            data.status_code === 400 ||
            data.status_code === 401 ||
            data.status_code === 422 ||
            data.message === 'token_expired' ||
            (data.errors && Object.keys(data.errors).length > 0)
        ) {
            console.error('❌ Shiprocket Error/Validation:', JSON.stringify(data));
            return null;
        }

        return data;
    } catch (error) {
        console.error('❌ Failed to create Shiprocket return:', error);
        return null;
    }
}

async function createShiprocketForwardOrder(requestData) {
    try {
        const token = await getShiprocketToken();

        // 1. Fetch Shopify Order if we need ANY missing data (Address or Customer)
        let shopifyOrder = null;
        const needsAddress = !requestData.newAddress;
        const needsCustomer = !requestData.customerName || requestData.customerName === 'Customer' || !requestData.customerPhone || requestData.customerPhone === 'null';

        if (needsAddress || needsCustomer) {
            try {
                let orderName = requestData.orderNumber;
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

                // Robust lookup: try with/without '#'
                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                }

                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
            } catch (e) {
                console.error('Failed to fetch original order for forward creation:', e);
            }
        }

        // 2. Determine Address
        let billingAddress = requestData.newAddress;
        let billingCity = requestData.newCity;
        let billingPincode = requestData.newPincode;
        let billingState = requestData.newState;

        // If any modified address field is missing, fall back to original shipping address
        if (!billingAddress || !billingState || !billingCity || !billingPincode) {
            if (requestData.shippingAddress && (!billingAddress || !billingCity)) {
                // Use stored original address components first
                billingAddress = billingAddress || requestData.shippingAddress;
                billingCity = billingCity || requestData.shippingCity || '';
                billingState = billingState || requestData.shippingState || '';
                billingPincode = billingPincode || requestData.shippingPincode || '';
            }
            if (!billingAddress && shopifyOrder && shopifyOrder.shipping_address) {
                billingAddress = shopifyOrder.shipping_address.address1;
                billingCity = billingCity || shopifyOrder.shipping_address.city;
                billingPincode = billingPincode || shopifyOrder.shipping_address.zip;
                billingState = billingState || shopifyOrder.shipping_address.province;
            } else if (!billingAddress && requestData.shippingAddress) {
                // FALLBACK: Parse from concatenated string: "Addr1, Addr2, City, State, Pincode, Country"
                const parts = requestData.shippingAddress.split(',').map(p => p.trim());
                billingAddress = parts.slice(0, -4).join(', ') || parts[0];
                billingCity = billingCity || parts[parts.length - 4] || '';
                billingState = billingState || parts[parts.length - 3] || '';
                billingPincode = billingPincode || parts[parts.length - 2] || '';

                // Last ditch: regex for pincode if not found
                if (!billingPincode.match(/^\d{6}$/)) {
                    const pinMatch = requestData.shippingAddress.match(/\b\d{6}\b/);
                    if (pinMatch) billingPincode = pinMatch[0];
                }
            }
        }
        // Final fallback: ensure no field is undefined
        billingState = billingState || '';
        billingCity = billingCity || '';
        billingPincode = billingPincode || '';

        // 3. Determine Customer Details
        let customerName = requestData.customerName;
        if (!customerName || customerName === 'Customer' || customerName === 'null') {
            if (shopifyOrder) {
                customerName = `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim();
                if (!customerName) customerName = shopifyOrder.shipping_address?.name || 'Customer';
            } else {
                customerName = 'Customer';
            }
        }

        let customerPhone = requestData.customerPhone;
        // Check for null string or placeholder
        if (!customerPhone || customerPhone === 'null' || customerPhone === '9999999999') {
            if (shopifyOrder) {
                customerPhone = shopifyOrder.shipping_address?.phone || shopifyOrder.customer?.phone || '';
            }
        }

        // Sanitize to exactly 10 digits for Shiprocket rules
        let cleanPhone = String(customerPhone).replace(/\D/g, '');
        customerPhone = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : '9999999999';


        // Sanitize Phone (Shiprocket requires 10 digits for India)
        // Remove all non-digits
        customerPhone = (customerPhone || '').replace(/\D/g, '');
        // If it starts with 91 and is 12 digits, remove 91
        if (customerPhone.length === 12 && customerPhone.startsWith('91')) {
            customerPhone = customerPhone.substring(2);
        }
        // If still > 10 digits, take last 10 (risky but often correct for mobile)
        if (customerPhone.length > 10) {
            customerPhone = customerPhone.slice(-10);
        }
        // If invalid/empty, fallback to dummy but log warning
        if (customerPhone.length < 10) {
            console.warn(`⚠️ Invalid phone number for ${requestData.requestId}: ${customerPhone}. Using fallback.`);
            customerPhone = '9999999999';
        }

        // Forward Order Items (Replacement Items)
        const items = Array.isArray(requestData.items) ? requestData.items : [];
        console.log(`[${requestData.requestId}] 📦 Processing ${items.length} replacement item(s) for forward order`);
        
        const orderItems = [];
        
        for (const item of items) {
            const isDifferentProduct = item.replacementProductId && item.replacementProductId !== item.productId;
            const title = item.replacementProductTitle || item.name;
            let resolvedVariant = item.replacementVariant || '';
            let finalVariantId = (item.replacementVariantId && item.replacementVariantId !== 'Same') ? item.replacementVariantId : (item.variantId || item.id);

            // Validate variant exists in Shopify if we have a product ID
            if (item.replacementProductId && finalVariantId && finalVariantId !== 'Same') {
                try {
                    console.log(`[${requestData.requestId}] 🔍 Validating variant ${finalVariantId} in Shopify...`);
                    const variantsData = await shopifyAPI(`products/${item.replacementProductId}/variants.json`);
                    const variants = variantsData.variants || [];
                    const variantExists = variants.find(v => v.id.toString() === finalVariantId.toString());
                    
                    if (variantExists) {
                        console.log(`[${requestData.requestId}] ✅ Variant confirmed: ${variantExists.title} (ID: ${variantExists.id})`);
                        console.log(`[${requestData.requestId}]    Inventory: ${variantExists.inventory_quantity} units`);
                        // If replacementVariant was missing, recover it from Shopify
                        if (!resolvedVariant || resolvedVariant === 'Same') {
                            resolvedVariant = variantExists.title;
                            console.log(`[${requestData.requestId}] ✅ Recovered missing replacementVariant from Shopify: "${resolvedVariant}"`);
                        }
                    } else {
                        console.warn(`[${requestData.requestId}] ⚠️ Variant ${finalVariantId} NOT FOUND in product ${item.replacementProductId}!`);
                        console.warn(`[${requestData.requestId}]    Available variants:`, variants.map(v => ({ id: v.id, title: v.title })));
                        
                        // Try to find matching variant by title
                        if (resolvedVariant) {
                            const matchingVariant = variants.find(v => 
                                v.title === resolvedVariant ||
                                v.option1 === resolvedVariant ||
                                v.option2 === resolvedVariant
                            );
                            if (matchingVariant) {
                                console.log(`[${requestData.requestId}] ✅ Found matching variant by title: ${matchingVariant.title} (ID: ${matchingVariant.id})`);
                                finalVariantId = matchingVariant.id;
                            }
                        }
                    }
                } catch (e) {
                    console.error(`[${requestData.requestId}] ❌ Failed to validate variant:`, e.message);
                }
            }

            const finalName = buildExchangeProductName(title, resolvedVariant);

            console.log(`[${requestData.requestId}] Item: ${title}`);
            console.log(`  - Original: ${item.name} (Variant: ${item.variant})`);
            console.log(`  - Replacement: ${finalName}`);
            console.log(`  - replacementVariant (raw): "${item.replacementVariant || ''}" → resolved: "${resolvedVariant}"`);
            console.log(`  - Variant ID: ${finalVariantId}`);
            console.log(`  - Price: ₹${item.replacementPrice || item.price}`);
            console.log(`  - Quantity: ${item.quantity}`);

            orderItems.push({
                name: finalName,
                sku: String(finalVariantId) + '-EXCH',
                units: parseInt(item.quantity) || 1,
                selling_price: parseFloat(item.replacementPrice || item.price) || 0,
                discount: 0,
                tax: 0
            });
        }

        // Fetch dynamic warehouse location settings
        const warehouseLocation = await getSetting('warehouse_location', null);
        const pickupLocationNickname = warehouseLocation && warehouseLocation.pickup_location
            ? warehouseLocation.pickup_location
            : 'Primary';

        const payload = {
            // Optional suffix (e.g. -R1) keeps duplicate forward orders unique — Shiprocket rejects re-used order ids
            order_id: requestData.requestId + '-FWD' + (requestData.forwardOrderIdSuffix || ''),
            order_date: new Date().toISOString().split('T')[0] + ' ' + new Date().toTimeString().split(' ')[0],
            pickup_location: pickupLocationNickname, // Dynamically set from Shiprocket settings
            billing_customer_name: customerName,
            billing_last_name: '',
            billing_address: (billingAddress || 'Address not available').substring(0, 190),
            billing_city: billingCity || billingState || 'City',
            billing_pincode: billingPincode || '110001',
            billing_state: billingState || billingCity || 'State', // Shiprocket requires state
            billing_country: 'India',
            billing_email: getValidEmail(requestData.email, shopifyOrder),
            billing_phone: customerPhone,
            shipping_is_billing: true,
            order_items: orderItems,
            payment_method: 'Prepaid',
            sub_total: orderItems.reduce((sum, item) => sum + (item.selling_price * item.units), 0),
            length: 10, breadth: 10, height: 10, weight: 0.5
        };

        console.log('🚀 Creating Shiprocket Forward Order:', JSON.stringify(payload, null, 2));

        // POST helper so we can transparently refresh an expired token and retry once.
        const postForward = async (authToken) => {
            const response = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const body = await response.json();
            return { response, body };
        };

        let activeToken = token;
        let { response, body: data } = await postForward(activeToken);

        // The cached token can be stale (Shiprocket returns 401/token_expired even though our
        // local 24h expiry hasn't elapsed). Invalidate it, fetch a fresh one, and retry once.
        if (response.status === 401 || (data && data.message === 'token_expired')) {
            console.warn('[Shiprocket 401] Forward token expired. Refreshing token and retrying...');
            shiprocketToken = null;
            shiprocketTokenExpiry = null;
            activeToken = await getShiprocketToken();
            ({ response, body: data } = await postForward(activeToken));
        }

        console.log('📦 Shiprocket Forward Response:', JSON.stringify(data, null, 2));

        if (
            data.status_code === 400 ||
            data.status_code === 401 ||
            data.status_code === 422 ||
            data.message === 'token_expired' ||
            (data.errors && Object.keys(data.errors).length > 0)
        ) {
            console.error('❌ Shiprocket Validation Error (Forward):', JSON.stringify(data));
            console.error('❌ Payload that caused error:', JSON.stringify(payload, null, 2));
            console.error('❌ Items being sent:', JSON.stringify(orderItems, null, 2));
            return null;
        }

        if (!response.ok) {
            console.error(`❌ Shiprocket API Error (HTTP ${response.status}):`, JSON.stringify(data));
            console.error('❌ Payload that caused error:', JSON.stringify(payload, null, 2));
            return null;
        }

        return data;
    } catch (error) {
        console.error('❌ Failed to create forward order:', error);
        return null;
    }
}

// ==================== DELHIVERY API HELPER ====================

/**
 * Delhivery API wrapper with retry logic
 */
async function delhiveryAPI(endpoint, options = {}, retries = 2) {
    const apiKey = process.env.DELHIVERY_API_KEY;
    if (!apiKey) {
        throw new Error('Delhivery API key not configured');
    }

    for (let i = 0; i <= retries; i++) {
        try {
            const response = await fetchWithRetry(`https://track.delhivery.com/api${endpoint}`, {
                ...options,
                headers: {
                    'Authorization': `Token ${apiKey}`,
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                // Retry on 5xx errors
                if (response.status >= 500 && i < retries) {
                    console.warn(`[Delhivery Retry] Status ${response.status} for ${endpoint}. Attempt ${i + 1}/${retries + 1}.`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                    continue;
                }
                throw new Error(`Delhivery API error: ${response.status} - ${errorText}`);
            }

            return response.json();
        } catch (error) {
            if (i === retries) throw error;
            console.warn(`[Delhivery Exception Retry] Attempt ${i + 1}/${retries + 1}. Error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

/**
 * Check if an error message indicates an unserviceable pincode/location.
 * Used to distinguish between "area not serviceable" (→ self-ship) and
 * other failures like "insufficient balance" (→ admin intervention).
 */
function isUnserviceableError(message) {
    if (!message) return false;
    const lower = message.toLowerCase();
    return lower.includes('unserviceable') ||
           lower.includes('not serviceable') ||
           lower.includes('serviceability');
}

/**
 * Create return pickup order via Delhivery
 */
async function createDelhiveryReturnOrder(requestData, shopifyOrder) {
    try {
        // Fetch Shopify Order if missing
        if (!shopifyOrder) {
            try {
                let orderName = requestData.orderNumber;
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
                    console.log(`[${requestData.requestId}] Order not found by "${orderName}", retrying with "${altName}"...`);
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                }

                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
                if (!shopifyOrder) console.warn(`[${requestData.requestId}] ⚠️ Shopify order not found even with fuzzy lookup for: ${orderName}`);
            } catch (e) {
                console.error(`[${requestData.requestId}] Failed to fetch original order:`, e);
            }
        }

        const address = shopifyOrder ? (shopifyOrder.shipping_address || (shopifyOrder.customer && shopifyOrder.customer.default_address)) : null;

        if (!address) {
            console.error(`[${requestData.requestId}] ❌ Delhivery Error: No address found. ShopifyOrder fetched: ${!!shopifyOrder}`);
            return null;
        }

        // Fetch dynamic warehouse location settings
        const warehouseLocation = await getSetting('warehouse_location', null);

        // Customer (pickup) details
        const customerName = `${address.first_name || ''} ${address.last_name || ''}`.trim() || 'Customer';
        const customerAddress = ((address.address1 || '') + ' ' + (address.address2 || '')).trim().substring(0, 190);
        const customerCity = address.city || 'City';
        const customerState = address.province || 'State';
        const customerPincode = address.zip;
        const customerCountry = address.country_code || 'IN';
        
        let customerPhone = requestData.customerPhone || address.phone || shopifyOrder?.phone || '9999999999';
        let digits = String(customerPhone).replace(/\D/g, '');
        customerPhone = digits.length >= 10 ? digits.slice(-10) : '9999999999';

        // Warehouse (return) details
        let returnName = 'BURB MANUFACTURES PVT LTD';
        let returnAddress = 'VILLAGE - BAIRAWAS, NEAR GOVT. SCHOOL';
        let returnCity = 'MAHENDERGARH';
        let returnState = 'Haryana';
        let returnCountry = 'IN';
        let returnPincode = '123028';
        let returnEmail = 'returns@offcomfort.com';
        let returnPhone = '9138514222';

        if (warehouseLocation) {
            returnName = warehouseLocation.name || returnName;
            returnAddress = warehouseLocation.address || warehouseLocation.address_line_1 || returnAddress;
            returnCity = warehouseLocation.city || returnCity;
            returnState = warehouseLocation.state || returnState;
            returnCountry = warehouseLocation.country || returnCountry;
            returnPincode = warehouseLocation.pin_code || warehouseLocation.pincode || returnPincode;
            returnEmail = warehouseLocation.email || returnEmail;
            returnPhone = warehouseLocation.phone || returnPhone;
        }

        // Sanitize addresses - Delhivery doesn't accept: &, #, %, ;, \
        const sanitizeAddress = (str) => {
            if (!str) return '';
            return str.replace(/[&#%;\\]/g, '').trim();
        };

        // Get Delhivery pickup location nickname
        // Priority: 1. Delhivery-specific setting, 2. Warehouse pickup_location, 3. Env variable, 4. Default
        const delhiveryPickupLocationSetting = await getSetting('delhivery_pickup_location', null);
        const pickupLocationNickname = delhiveryPickupLocationSetting 
            || (warehouseLocation && warehouseLocation.pickup_location)
            || process.env.DELHIVERY_PICKUP_LOCATION 
            || 'Primary';

        console.log(`📍 Using Delhivery pickup location: ${pickupLocationNickname}`);

        // Process items/products for Delhivery
        // NOTE: This is the REVERSE PICKUP (collecting the original item from the customer).
        // The label must show the ORIGINAL item details — not the replacement — since
        // the pickup person is collecting what the customer is returning/ exchanging.
        const items = Array.isArray(requestData.items) ? requestData.items : [];
        console.log(`📦 Processing ${items.length} item(s) for Delhivery return/pickup order`);
        
        const products = [];
        let totalQuantity = 0;
        let totalAmount = 0;
        let productsDesc = [];
        for (const item of items) {
            // Use ORIGINAL item details for the pickup label (not replacement)
            const title = item.name || 'Item';
            const variant = item.variant || '';
            const productName = buildExchangeProductName(title, variant);
            const quantity = parseInt(item.quantity) || 1;
            const price = parseFloat(item.price) || 0;
            
            console.log(`  - Product: ${productName}`);
            console.log(`    Original variant: ${variant}`);
            console.log(`    Quantity: ${quantity}`);
            console.log(`    Price: ₹${price}`);
            
            totalQuantity += quantity;
            totalAmount += (price * quantity);
            productsDesc.push(productName);
            
            products.push({
                name: sanitizeAddress(productName),
                quantity: quantity,
                price: price,
                selling_price: price,
                sku: String(item.variantId || item.id || '') + '-RET',
                hsn_code: '9965'  // Default HSN for apparel/general goods
            });
        }

        // Get GST TIN for Delhivery (mandatory per Delhivery docs)
        const sellerGstTin = process.env.DELHIVERY_SELLER_GST || '06AAKFO0351L1Z7';
        const pkgWeight = parseFloat(process.env.DELHIVERY_DEFAULT_WEIGHT) || 500;
        const pkgLength = parseFloat(process.env.DELHIVERY_DEFAULT_LENGTH) || 30;
        const pkgWidth = parseFloat(process.env.DELHIVERY_DEFAULT_WIDTH) || 40;
        const pkgHeight = parseFloat(process.env.DELHIVERY_DEFAULT_HEIGHT) || 2;

        console.log(`✅ Prepared ${products.length} product(s) for Delhivery`);
        console.log(`📊 Total Quantity: ${totalQuantity}, Total Amount: ₹${totalAmount}`);
        console.log(`🔢 Seller GST: ${sellerGstTin}`);

        // Build payload for Delhivery CMU API
        // For forward dispatch (exchange), use 'fws' prefix to avoid duplicate order errors.
        // When re-booking a fresh pickup (e.g. a previous booking was cancelled), a unique
        // suffix (e.g. '-R1') must be appended so Delhivery treats it as a NEW order instead
        // of rejecting it as a "Duplicate order id" and echoing back the stale waybill.
        const orderIdPrefix = requestData.type === 'exchange' ? 'fws-' : '';
        const orderIdSuffix = requestData.delhiveryOrderIdSuffix || '';
        const delhiveryOrderId = `${orderIdPrefix}${requestData.requestId}${orderIdSuffix}`;
        
        console.log(` Delhivery Order Type: ${requestData.type || 'return'}, Order ID: ${delhiveryOrderId}`);
        
        const payload = {
            shipments: [{
                name: sanitizeAddress(customerName),
                add: sanitizeAddress(customerAddress),
                pin: customerPincode,
                city: sanitizeAddress(customerCity),
                state: sanitizeAddress(customerState),
                country: customerCountry,
                phone: customerPhone,
                payment_mode: 'Pickup', // For reverse pickup
                order: delhiveryOrderId,
                cod_amount: 0,
                order_date: new Date().toISOString().split('T')[0],
                total_amount: totalAmount,
                quantity: totalQuantity,
                weight: pkgWeight,
                shipment_width: pkgWidth,
                shipment_height: pkgHeight,
                shipment_length: pkgLength,
                products_desc: productsDesc.join(', '),
                hsn_code: '9965',
                return_pin: returnPincode,
                return_add: sanitizeAddress(returnAddress),
                return_city: sanitizeAddress(returnCity),
                return_state: sanitizeAddress(returnState),
                return_country: returnCountry,
                return_phone: returnPhone,
                seller_gst_tin: sellerGstTin,  // Mandatory for GST compliance
                products: products  // Include product details
            }],
            pickup_location: {
                name: pickupLocationNickname,
                add: sanitizeAddress(returnAddress),
                pin: returnPincode,
                city: sanitizeAddress(returnCity),
                state: sanitizeAddress(returnState),
                country: returnCountry,
                phone: returnPhone
            }
        };

        console.log(`🚀 Creating Delhivery Return Order. Payload:`, JSON.stringify(payload, null, 2));

        // Delhivery requires format=json&data=<json_string> in the body
        const bodyString = `format=json&data=${JSON.stringify(payload)}`;

        const response = await fetch('https://track.delhivery.com/api/cmu/create.json', {
            method: 'POST',
            headers: {
                'Authorization': `Token ${process.env.DELHIVERY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: bodyString
        });

        const data = await response.json();
        console.log(`📦 Delhivery Response:`, JSON.stringify(data, null, 2));

        // First, check if we have packages data - even with errors, packages might contain useful data
        if (data && data.packages && data.packages.length > 0) {
            const pkg = data.packages[0];
            
            // If we have a waybill but status is Fail with duplicate error, recover it
            if (pkg.waybill && pkg.status === 'Fail' && pkg.remarks && pkg.remarks.some(r => r.toLowerCase().includes('duplicate'))) {
                console.warn(`⚠️ Delhivery duplicate order detected for ${requestData.requestId}. Using existing waybill: ${pkg.waybill}`);
                return {
                    waybill: pkg.waybill,
                    shipment_id: pkg.refnum || requestData.requestId,
                    success: true,
                    data: { ...data, recovered: true, duplicateOrder: true }
                };
            }
            
            // Handle duplicate order error without waybill - try to retrieve existing waybill
            if (pkg.status === 'Fail' && pkg.remarks && pkg.remarks.some(r => r.toLowerCase().includes('duplicate'))) {
                console.warn(`⚠️ Delhivery duplicate order detected for ${requestData.requestId}. Attempting to retrieve existing waybill...`);
                
                // Try to get tracking info using the order reference
                try {
                    const trackingData = await delhiveryAPI(`/v1/packages/json/?refnos=${requestData.requestId}`);
                    if (trackingData && trackingData.packages && trackingData.packages.length > 0) {
                        const existingPkg = trackingData.packages[0];
                        if (existingPkg.waybill_code || existingPkg.awb) {
                            const existingWaybill = existingPkg.waybill_code || existingPkg.awb;
                            console.log(`✅ Retrieved existing waybill for duplicate order: ${existingWaybill}`);
                            return {
                                waybill: existingWaybill,
                                shipment_id: existingPkg.refnum || requestData.requestId,
                                success: true,
                                data: { ...data, recovered: true, existingWaybill }
                            };
                        }
                    }
                } catch (recoverError) {
                    console.error(`❌ Failed to recover existing waybill:`, recoverError.message);
                }
                
                // If recovery failed, throw error with specific message
                throw new Error(`Delhivery duplicate order: ${requestData.requestId} already exists. ${pkg.remarks.join(', ')}`);
            }
            
            // Check for success
            if (pkg.status === 'Success' && pkg.waybill) {
                return {
                    waybill: pkg.waybill,
                    shipment_id: pkg.refnum || null,
                    success: true,
                    data: data
                };
            } else if (pkg.status && pkg.status !== 'Success') {
                console.error(`❌ Delhivery package status: ${pkg.status}`);
                const errorMsg = pkg.remarks && pkg.remarks.length > 0 ? pkg.remarks.join(', ') : pkg.status;
                // Tag unserviceable errors so upstream can distinguish from other failures
                if (isUnserviceableError(errorMsg)) {
                    const err = new Error(`UNSERVICEABLE_PINCODE: Delhivery package error: ${errorMsg}`);
                    err.isUnserviceable = true;
                    throw err;
                }
                throw new Error(`Delhivery package error: ${errorMsg}`);
            }
        }

        // Check for error responses (only if no packages data was processed)
        if (data && data.rmk) {
            console.error(`❌ Delhivery Error: ${data.rmk}`);
            throw new Error(`Delhivery API Error: ${data.rmk}`);
        }

        if (data && data.message) {
            console.error(`❌ Delhivery Message: ${data.message}`);
            throw new Error(`Delhivery API Error: ${data.message}`);
        }

        // Check alternative response formats
        if (data && data.shipments && data.shipments.length > 0) {
            const shipment = data.shipments[0];
            return {
                waybill: shipment.waybill_code || shipment.awb_code || null,
                shipment_id: shipment.shipment_id || null,
                success: true,
                data: data
            };
        } else if (data.status === 'success' || data.success) {
            // Alternative success response format
            return {
                waybill: data.waybill_code || data.awb_code || data.waybill || null,
                shipment_id: data.shipment_id || null,
                success: true,
                data: data
            };
        } else {
            console.error('❌ Delhivery Error: Unexpected response format', JSON.stringify(data));
            throw new Error(`Delhivery unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
        }
    } catch (error) {
        // Re-throw unserviceable errors so upstream can handle them differently
        if (error.isUnserviceable || isUnserviceableError(error.message)) {
            console.error('❌ Delhivery unserviceable pincode error:', error.message);
            const err = new Error(error.message);
            err.isUnserviceable = true;
            throw err;
        }
        console.error('❌ Failed to create Delhivery return:', error);
        return null;
    }
}

/**
 * Create Delhivery Forward Order (for exchange/replacement dispatch)
 * This sends item FROM warehouse TO customer (opposite of return pickup)
 */
async function createDelhiveryForwardOrder(requestData, shopifyOrder) {
    try {
        console.log(`\n📦 Creating Delhivery Forward Order for ${requestData.requestId}...`);
        
        // Fetch Shopify Order if we need customer address
        if (!shopifyOrder && requestData.orderNumber) {
            try {
                let orderName = requestData.orderNumber;
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                }

                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
            } catch (e) {
                console.error(`[${requestData.requestId}] Failed to fetch Shopify order:`, e.message);
            }
        }

        // Get warehouse location for pickup (FROM warehouse)
        const warehouseLocation = await getSetting('warehouse_location', null);
        
        if (!warehouseLocation) {
            console.error(`[${requestData.requestId}] ❌ No warehouse location configured`);
            return null;
        }

        console.log('✅ Using warehouse from settings:', warehouseLocation.nickname || warehouseLocation.name);
        console.log('📦 Warehouse Details:');
        console.log(`   Name: ${warehouseLocation.name}`);
        console.log(`   Address: ${warehouseLocation.address}`);
        console.log(`   City: ${warehouseLocation.city}, ${warehouseLocation.state} ${warehouseLocation.pin_code || warehouseLocation.pincode}`);
        console.log(`   Phone: ${warehouseLocation.phone}`);

        // Customer details (TO customer) - use new_* fields for exchange address, fall back to original
        // Note: Influencer flows pass customerAddress/customerCity/etc, exchange flows use shippingAddress/newAddress
        let customerName = requestData.newName || requestData.customerName || 'Customer';
        let customerAddress = requestData.newAddress || requestData.shippingAddress || requestData.customerAddress || '';
        let customerCity = requestData.newCity || requestData.shippingCity || requestData.customerCity || '';
        let customerState = requestData.newState || requestData.shippingState || requestData.customerState || '';
        let customerPincode = requestData.newPincode || requestData.shippingPincode || requestData.customerPincode || '';
        let customerPhone = requestData.customerPhone || requestData.newPhone || '9999999999';

        // Parser: extract city/state/pincode from combined address string if missing
        // Indian address format: "street, area, CITY, STATE, PINCODE, Country"
        if (customerAddress && (!customerPincode || !customerCity || !customerState)) {
            const addrParts = customerAddress.split(',').map(s => s.trim()).filter(Boolean);
            if (addrParts.length >= 3) {
                // Try to find pincode (6-digit number) in the address parts
                const pincodeIdx = addrParts.findIndex(p => /^\d{6}$/.test(p));
                if (pincodeIdx > 0) {
                    if (!customerPincode) customerPincode = addrParts[pincodeIdx];
                    if (!customerState && pincodeIdx >= 2) customerState = addrParts[pincodeIdx - 1];
                    if (!customerCity && pincodeIdx >= 3) customerCity = addrParts[pincodeIdx - 2];
                } else {
                    // No 6-digit pincode found, try to extract from end: ..., City, State, Country
                    const lastPart = addrParts[addrParts.length - 1];
                    const isCountry = /^(india|IN)$/i.test(lastPart);
                    const endIdx = isCountry ? addrParts.length - 2 : addrParts.length - 1;
                    if (!customerState && endIdx >= 1) customerState = addrParts[endIdx];
                    if (!customerCity && endIdx >= 2) customerCity = addrParts[endIdx - 1];
                }
            }
            console.log(`[Address Parser] Parsed from combined address: city=${customerCity}, state=${customerState}, pin=${customerPincode}`);
        }

        // Shopify fallback: if still missing city/state/pincode, fetch from Shopify order
        if (shopifyOrder && (!customerPincode || !customerCity || !customerState)) {
            const address = shopifyOrder.shipping_address || (shopifyOrder.customer && shopifyOrder.customer.default_address);
            if (address) {
                customerName = `${address.first_name || ''} ${address.last_name || ''}`.trim() || customerName;
                if (!customerAddress) customerAddress = ((address.address1 || '') + ' ' + (address.address2 || '')).trim().substring(0, 190);
                customerCity = customerCity || address.city || '';
                customerState = customerState || address.province || '';
                customerPincode = customerPincode || address.zip || '';
                customerPhone = customerPhone || address.phone || shopifyOrder?.phone || '9999999999';
                console.log(`[Shopify Fallback] Filled from Shopify: city=${customerCity}, state=${customerState}, pin=${customerPincode}`);
            }
        }

        // Deep fallback: if address is STILL empty, try to fetch Shopify order using order_number from DB
        if (!customerAddress) {
            const orderNum = requestData.orderNumber || requestData.order_number;
            if (orderNum && !shopifyOrder) {
                console.log(`[Address Recovery] Address empty, attempting Shopify fetch for order: ${orderNum}`);
                try {
                    let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderNum)}&status=any&limit=1`);
                    if (!shopifyData.orders || shopifyData.orders.length === 0) {
                        const altName = orderNum.startsWith('#') ? orderNum.substring(1) : `#${orderNum}`;
                        shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                    }
                    const fetchedOrder = shopifyData.orders && shopifyData.orders[0];
                    if (fetchedOrder) {
                        const addr = fetchedOrder.shipping_address || (fetchedOrder.customer && fetchedOrder.customer.default_address);
                        if (addr) {
                            customerName = `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || customerName;
                            customerAddress = ((addr.address1 || '') + ' ' + (addr.address2 || '')).trim().substring(0, 190);
                            customerCity = customerCity || addr.city || '';
                            customerState = customerState || addr.province || '';
                            customerPincode = customerPincode || addr.zip || '';
                            customerPhone = (customerPhone && customerPhone !== '9999999999') ? customerPhone : (addr.phone || fetchedOrder.phone || '9999999999');
                            console.log(`[Address Recovery] ✅ Recovered from Shopify: ${customerAddress}, ${customerCity}, ${customerState} ${customerPincode}`);
                        }
                    } else {
                        console.warn(`[Address Recovery] ⚠️ Order ${orderNum} not found in Shopify`);
                    }
                } catch (shopifyErr) {
                    console.error(`[Address Recovery] ❌ Shopify fetch failed:`, shopifyErr.message);
                }
            }
        }

        // Final validation: ensure address is not empty before sending to Delhivery
        if (!customerAddress) {
            console.error(`[${requestData.requestId}] ❌ Customer address is EMPTY after all resolution attempts`);
            console.error(`   requestData keys: ${Object.keys(requestData).join(', ')}`);
            console.error(`   orderNumber: ${requestData.orderNumber || requestData.order_number || 'N/A'}`);
            console.error(`   newAddress: ${requestData.newAddress || 'N/A'}`);
            console.error(`   shippingAddress: ${requestData.shippingAddress || 'N/A'}`);
            return null;
        }

        // Validate phone number
        let digits = String(customerPhone).replace(/\D/g, '');
        customerPhone = digits.length >= 10 ? digits.slice(-10) : '9999999999';

        // Sanitize addresses - Delhivery doesn't accept: &, #, %, ;, \
        const sanitizeAddress = (str) => {
            if (!str) return '';
            return str.replace(/[&#%;\\]/g, '').trim();
        };

        // Build forward order ID with fws- prefix (required by Delhivery for forward shipments)
        // Optional suffix (e.g. -R1) keeps duplicate forward orders unique — Delhivery rejects re-used order ids
        const forwardOrderId = `fws-${requestData.requestId}${requestData.forwardOrderIdSuffix || ''}`;

        // Get Delhivery pickup location nickname
        const delhiveryPickupLocationSetting = await getSetting('delhivery_pickup_location', null);
        const pickupLocationNickname = delhiveryPickupLocationSetting 
            || (warehouseLocation && warehouseLocation.pickup_location)
            || process.env.DELHIVERY_PICKUP_LOCATION 
            || 'Primary';

        console.log(` Using Delhivery pickup location: ${pickupLocationNickname}`);
        console.log(`📦 Forward Order: FROM warehouse TO customer`);
        console.log(`   Order ID: ${forwardOrderId}`);
        console.log(`   From: ${warehouseLocation.city}, ${warehouseLocation.state}`);
        console.log(`   To: ${customerCity}, ${customerState}`);

        // Process items/products for Delhivery
        const items = Array.isArray(requestData.items) ? requestData.items : [];
        console.log(`📦 Processing ${items.length} item(s) for Delhivery forward order`);
        
        const products = [];
        let totalQuantity = 0;
        let totalAmount = 0;
        let productsDesc = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const isDifferentProduct = item.replacementProductId && item.replacementProductId !== item.productId;
            const title = item.replacementProductTitle || item.name;

            // ── Resolve replacement variant (size) ──────────────────────────────
            // If replacementVariant is missing from stored items, look it up from
            // Shopify using replacementVariantId so the label always shows the
            // correct replacement size.
            let resolvedVariant = item.replacementVariant || '';
            if (!resolvedVariant || resolvedVariant === 'Same') {
                const variantId = item.replacementVariantId || item.variantId || item.id;
                const productId = item.replacementProductId || item.productId;
                if (variantId && variantId !== 'Same' && productId) {
                    try {
                        console.log(`[${requestData.requestId}] 🔍 replacementVariant missing, resolving from Shopify variant ${variantId}...`);
                        const variantsData = await shopifyAPI(`products/${productId}/variants.json`);
                        const match = (variantsData.variants || []).find(v => v.id.toString() === variantId.toString());
                        if (match) {
                            resolvedVariant = match.title;
                            console.log(`[${requestData.requestId}] ✅ Resolved variant from Shopify: "${resolvedVariant}"`);
                        } else {
                            console.warn(`[${requestData.requestId}] ⚠️ Variant ${variantId} not found in product ${productId}`);
                        }
                    } catch (e) {
                        console.error(`[${requestData.requestId}] ❌ Shopify variant lookup failed:`, e.message);
                    }
                }
            }
            // ─────────────────────────────────────────────────────────────────────

            const productName = buildExchangeProductName(title, resolvedVariant);
            const quantity = parseInt(item.quantity) || 1;
            const price = parseFloat(item.replacementPrice || item.price) || 0;
            
            console.log(`  - Product: ${productName}`);
            console.log(`    replacementVariant (raw): "${item.replacementVariant || ''}" → resolved: "${resolvedVariant}"`);
            console.log(`    replacementProductTitle: "${item.replacementProductTitle || ''}" | fallback title: "${item.name || ''}"`);
            console.log(`    Quantity: ${quantity}`);
            console.log(`    Price: ₹${price}`);
            
            totalQuantity += quantity;
            totalAmount += (price * quantity);
            productsDesc.push(productName);

            // Generate unique SKU - use product ID first, fallback to sanitized product name
            // This prevents Delhivery from merging different products with the same SKU
            const rawSku = item.replacementVariantId || item.variantId || item.id || '';
            const sku = rawSku
                ? String(rawSku) + '-EXCH'
                : productName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 30).toUpperCase() + '-EXCH';
            
            products.push({
                name: sanitizeAddress(productName),
                quantity: quantity,
                price: price,
                selling_price: price,
                sku: sku,
                hsn_code: '9965'  // Default HSN for apparel/general goods
            });
        }

        // Get GST TIN for Delhivery (mandatory per Delhivery docs)
        const sellerGstTin = process.env.DELHIVERY_SELLER_GST || '06AAKFO0351L1Z7';

        // Default package dimensions and weight (configurable via env)
        const pkgWeight = parseFloat(process.env.DELHIVERY_DEFAULT_WEIGHT) || 500;  // grams
        const pkgLength = parseFloat(process.env.DELHIVERY_DEFAULT_LENGTH) || 30;   // cm
        const pkgWidth = parseFloat(process.env.DELHIVERY_DEFAULT_WIDTH) || 40;     // cm
        const pkgHeight = parseFloat(process.env.DELHIVERY_DEFAULT_HEIGHT) || 2;    // cm

        console.log(`✅ Prepared ${products.length} product(s) for Delhivery`);
        console.log(`📊 Total Quantity: ${totalQuantity}, Total Amount: ₹${totalAmount}`);
        console.log(`📦 Package: ${pkgWeight}g, ${pkgLength}x${pkgWidth}x${pkgHeight}cm`);
        console.log(`🔢 Seller GST: ${sellerGstTin}`);

        // Build payload for Delhivery CMU API - FORWARD direction
        // Single shipment with all products listed individually
        const payload = {
            shipments: [{
                order: forwardOrderId,
                name: sanitizeAddress(customerName),
                add: sanitizeAddress(customerAddress),
                pin: customerPincode,
                city: sanitizeAddress(customerCity),
                state: sanitizeAddress(customerState),
                country: "India",
                phone: customerPhone,
                payment_mode: "Prepaid",
                cod_amount: 0,
                order_date: new Date().toISOString().split('T')[0],
                total_amount: totalAmount,
                quantity: totalQuantity,
                weight: pkgWeight,
                shipment_width: pkgWidth,
                shipment_height: pkgHeight,
                shipment_length: pkgLength,
                products_desc: productsDesc.join(', '),
                hsn_code: '9965',
                pickup_location: pickupLocationNickname,
                seller_gst_tin: sellerGstTin,
                products: products
            }],
            pickup_location: {
                name: pickupLocationNickname,
                add: sanitizeAddress(warehouseLocation.address || warehouseLocation.address_line_1),
                pin: warehouseLocation.pin_code || warehouseLocation.pincode,
                city: sanitizeAddress(warehouseLocation.city),
                state: sanitizeAddress(warehouseLocation.state || 'Haryana'),
                country: 'IN',
                phone: warehouseLocation.phone
            }
        };

        console.log('🚀 Sending to Delhivery CMU API...');
        console.log('📦 Payload:', JSON.stringify(payload, null, 2));

        const response = await fetch('https://track.delhivery.com/api/cmu/create.json', {
            method: 'POST',
            headers: {
                'Authorization': `Token ${process.env.DELHIVERY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: `format=json&data=${JSON.stringify(payload)}`
        });

        const data = await response.json();
        console.log('📦 Delhivery Response:', JSON.stringify(data, null, 2));

        if (data.error || data.status === "Error") {
            console.error('❌ Delhivery Error:', data.error || data.message);
            return null;
        }

        // ── Duplicate order id detection (mirrors createDelhiveryReturnOrder recovery) ──
        // Delhivery rejects re-used order ids with packages[0].remarks = ['Duplicate order id']
        // and echoes back the existing waybill. Recover it instead of returning null.
        if (data && data.packages && data.packages.length > 0) {
            const firstPkg = data.packages[0];
            if (firstPkg.status === 'Fail' && Array.isArray(firstPkg.remarks) &&
                firstPkg.remarks.some(r => r.toLowerCase().includes('duplicate'))) {
                console.warn(`⚠️ [Delhivery Forward] Duplicate order id detected for ${forwardOrderId}. Recovering existing waybill...`);
                if (firstPkg.waybill) {
                    return {
                        waybill: firstPkg.waybill,
                        waybills: [firstPkg.waybill],
                        shipment_id: firstPkg.refnum || firstPkg.shipment_id || forwardOrderId,
                        shipment_ids: [firstPkg.refnum || firstPkg.shipment_id || forwardOrderId],
                        order_id: forwardOrderId,
                        package_count: 1,
                        recovered: true,
                        duplicateOrder: true
                    };
                }
                // No waybill in response — try to retrieve via tracking API
                try {
                    const trackingData = await delhiveryAPI(`/v1/packages/json/?refnos=${forwardOrderId}`);
                    if (trackingData && trackingData.packages && trackingData.packages.length > 0) {
                        const existingPkg = trackingData.packages[0];
                        const existingWaybill = existingPkg.waybill_code || existingPkg.awb || existingPkg.waybill;
                        if (existingWaybill) {
                            console.log(`✅ [Delhivery Forward] Recovered existing waybill: ${existingWaybill}`);
                            return {
                                waybill: existingWaybill,
                                waybills: [existingWaybill],
                                shipment_id: existingPkg.refnum || existingPkg.shipment_id || forwardOrderId,
                                shipment_ids: [existingPkg.refnum || existingPkg.shipment_id || forwardOrderId],
                                order_id: forwardOrderId,
                                package_count: 1,
                                recovered: true,
                                existingWaybill: true
                            };
                        }
                    }
                } catch (recoverError) {
                    console.error(`❌ [Delhivery Forward] Failed to recover existing waybill:`, recoverError.message);
                }
                throw new Error(`Delhivery duplicate order: ${forwardOrderId} already exists. ${firstPkg.remarks.join(', ')}`);
            }
        }

        // Extract waybill(s) and shipment details - support multiple packages for multi-product orders
        const packages = data.packages || [];
        const waybills = packages.map(pkg => pkg.waybill).filter(Boolean);
        const shipmentIds = packages.map(pkg => pkg.shipment_id || forwardOrderId);
        
        if (waybills.length > 0) {
            console.log(`✅ Delhivery Forward Success!`);
            waybills.forEach((wb, i) => {
                console.log(`   Package ${i + 1} - Waybill: ${wb}, Order: ${packages[i]?.refnum || forwardOrderId}`);
            });
                    
            return {
                waybill: waybills[0],  // Primary waybill (first package)
                waybills: waybills,    // All waybills for multi-product orders
                shipment_id: shipmentIds[0],
                shipment_ids: shipmentIds,
                order_id: forwardOrderId,
                package_count: packages.length
            };
        } else {
            console.error('❌ Delhivery did not return waybill');
            console.error('   Error:', data.rmk || data.error);
            return null;
        }

    } catch (error) {
        console.error(`❌ Error creating Delhivery forward order:`, error.message);
        return null;
    }
}

/**
 * Get Delhivery tracking details
 */
async function getDelhiveryTracking(waybill) {
    if (!waybill || !process.env.DELHIVERY_API_KEY) return null;
    try {
        const raw = await delhiveryAPI(`/v1/packages/json/?waybill=${waybill}`);

        // Delhivery's live tracking endpoint returns:
        //   { ShipmentData: [ { Shipment: { Status: { Status, StatusType, StatusDateTime },
        //                                   Scans: [ { ScanDetail } ], Waybill, ExpectedDeliveryDate, ... } } ] }
        // There is NO lowercase `shipments` key and `Status` is a nested object, so we normalize
        // it once here into the { shipments: [ { status, status_type, eta, tracking_data, ... } ] }
        // shape that every downstream consumer (sync + enrichWithTracking) already expects.
        if (raw && Array.isArray(raw.ShipmentData) && raw.ShipmentData.length > 0) {
            const shipments = raw.ShipmentData.map(entry => {
                const s = (entry && entry.Shipment) || {};
                const st = s.Status || {};
                const statusType = (st.StatusType || '').toString().toUpperCase();
                const scans = Array.isArray(s.Scans)
                    ? s.Scans.map(sc => (sc && sc.ScanDetail) ? sc.ScanDetail : sc)
                    : [];
                const isDelivered = statusType === 'DL';
                return {
                    status: st.Status || null,
                    status_type: statusType || null,
                    status_datetime: st.StatusDateTime || null,
                    status_location: st.StatusLocation || null,
                    delivered_status: isDelivered ? (st.Status || 'Delivered') : null,
                    delivered_date: isDelivered ? (st.StatusDateTime || null) : null,
                    waybill_code: s.Waybill || s.AWB || waybill,
                    eta: s.ExpectedDeliveryDate || s.PromisedDeliveryDate || null,
                    pickup_date: s.PickUpDate || null,
                    origin: s.Origin || null,
                    destination: s.Destination || null,
                    tracking_data: scans,
                    scans: scans
                };
            });
            return { shipments, ShipmentData: raw.ShipmentData };
        }

        // Some responses may already be normalized – pass them through unchanged.
        if (raw && Array.isArray(raw.shipments) && raw.shipments.length > 0) {
            return raw;
        }
    } catch (error) {
        console.error('Delhivery tracking fetch error:', error.message);
    }
    return null;
}

// ==================== EKART API HELPERS ====================
// Ekart Elite API (app.elite.ekartlogistics.in) — same integration as the
// WhatsApp bot's ekartAdapter, built from the official OpenAPI spec v3.8.9.
//
// Endpoints used:
//   Auth token      : POST /integrations/v2/auth/token/{client_id}  ({username, password})
//   Create shipment : PUT  /api/v1/package/create  (forward + reverse via payment_mode)
//   Track           : GET  /api/v1/track/{awb}

const EKART_BASE_URL = () => (process.env.EKART_BASE_URL || 'https://app.elite.ekartlogistics.in').replace(/\/+$/, '');

function ekartConfigured() {
    return !!(process.env.EKART_CLIENT_ID && process.env.EKART_USERNAME && process.env.EKART_PASSWORD);
}

let ekartToken = null;
let ekartTokenExpiry = null;

async function getEkartToken(signal) {
    // Return cached token if still valid
    if (ekartToken && ekartTokenExpiry && Date.now() < ekartTokenExpiry) {
        return ekartToken;
    }
    if (!ekartConfigured()) {
        throw new Error('Ekart not configured (EKART_CLIENT_ID / EKART_USERNAME / EKART_PASSWORD missing)');
    }

    const response = await fetch(
        `${EKART_BASE_URL()}/integrations/v2/auth/token/${encodeURIComponent(process.env.EKART_CLIENT_ID)}`,
        {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: process.env.EKART_USERNAME,
                password: process.env.EKART_PASSWORD
            })
        }
    );

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }

    if (!response.ok || !data || !data.access_token) {
        throw new Error(`Ekart auth failed: ${response.status} - ${(text || '').substring(0, 300)}`);
    }

    console.log('✅ Ekart authenticated (Elite API)');
    ekartToken = data.access_token;
    // Refresh 5 min before expiry (expires_in is in seconds)
    const expiresInSec = Math.max(parseInt(data.expires_in, 10) || 3600, 600) - 300;
    ekartTokenExpiry = Date.now() + expiresInSec * 1000;
    return ekartToken;
}

async function ekartAPI(endpoint, options = {}) {
    const token = await getEkartToken();

    const response = await fetchWithRetry(`${EKART_BASE_URL()}${endpoint}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        // Token expired mid-session — retry once with a fresh token
        if (response.status === 401 && !options._ekartRetried) {
            ekartToken = null;
            ekartTokenExpiry = null;
            return ekartAPI(endpoint, { ...options, _ekartRetried: true });
        }
        throw new Error(`Ekart API error: ${response.status} - ${errorText.substring(0, 300)}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

// Today / tomorrow in IST as YYYY-MM-DD (invoice date = today, dispatch date
// must be tomorrow or later per Ekart's rules)
function ekartIstDates() {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return {
        today: fmt.format(new Date()),
        tomorrow: fmt.format(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
    };
}

// Fields shared by forward & reverse shipments (seller identity, package size).
// Ekart rejects the request when any of the required seller fields is missing.
function ekartCommonShipmentFields(orderNumber, totalAmount, totalQuantity) {
    const amount = Math.max(1, totalAmount || 0); // API minimum is 1
    return {
        seller_name: process.env.EKART_SELLER_NAME || 'Offcomfrt',
        seller_address: process.env.EKART_SELLER_ADDRESS || '',
        seller_gst_tin: process.env.EKART_SELLER_GST_TIN || '',
        seller_gst_amount: 0,
        consignee_gst_amount: 0,
        integrated_gst_amount: 0,
        order_number: String(orderNumber),
        invoice_number: String(orderNumber),
        invoice_date: ekartIstDates().today,
        category_of_goods: process.env.EKART_CATEGORY_OF_GOODS || 'Apparel',
        total_amount: amount,
        tax_value: 0,
        taxable_amount: amount,
        commodity_value: String(amount),
        quantity: totalQuantity || 1,
        weight: Math.max(1, Math.round(parseFloat(process.env.EKART_DEFAULT_WEIGHT) || 500)), // grams
        length: Math.max(1, Math.round(parseFloat(process.env.EKART_DEFAULT_LENGTH) || 30)),
        width: Math.max(1, Math.round(parseFloat(process.env.EKART_DEFAULT_WIDTH) || 40)),
        height: Math.max(1, Math.round(parseFloat(process.env.EKART_DEFAULT_HEIGHT) || 2)),
        preferred_dispatch_date: ekartIstDates().tomorrow
    };
}

// Pickup/RTO addresses are registered with Ekart beforehand; we reference them
// by alias. Ekart requires an explicit pickup_location in the payload.
function ekartPickupLocationFields() {
    return {
        pickup_location: { name: process.env.EKART_PICKUP_ALIAS || 'Warehouse' },
        return_location: { name: process.env.EKART_RETURN_ALIAS || process.env.EKART_PICKUP_ALIAS || 'Warehouse' }
    };
}

// Customer drop-location block (used as drop_location for BOTH directions —
// for reverse shipments Ekart's naming is semantically opposite to the ground
// flow: drop = customer address, pickup = seller alias)
function ekartDropLocation(name, address, city, state, pincode, phone) {
    return {
        name: (name || 'Customer').substring(0, 100),
        address: [address, city, state].filter(Boolean).join(', ').substring(0, 500),
        city: city || '',
        state: state || '',
        country: 'India',
        phone: Number(String(phone || '').replace(/\D/g, '').slice(-10)) || 9999999999,
        pin: Number(pincode)
    };
}

// Backfill city/state from Ekart's own pincode master when the order lacks
// them — Swift validation rejects blank drop city/state.
async function ekartBackfillCityState(pincode, city, state) {
    if (city && state) return { city, state };
    try {
        const svc = await ekartAPI(`/api/v2/serviceability/${encodeURIComponent(pincode)}`);
        return {
            city: city || svc?.details?.city || '',
            state: state || svc?.details?.state || ''
        };
    } catch (e) {
        console.warn(`⚠️ Ekart city/state backfill unavailable: ${e.message}`);
        return { city, state };
    }
}

// PUT /api/v1/package/create — shared submit + response handling for both
// directions. Returns { waybill, shipment_id, data } or throws.
async function ekartCreateShipment(payload, requestId) {
    console.log(`[${requestId}] 🚀 Creating Ekart shipment. Payload:`, JSON.stringify(payload, null, 2));
    const data = await ekartAPI('/api/v1/package/create', {
        method: 'PUT',
        body: JSON.stringify(payload)
    });
    console.log(`[${requestId}] 📦 Ekart Response:`, JSON.stringify(data, null, 2));

    if (data && data.status === true && data.tracking_id) {
        return { waybill: data.tracking_id, shipment_id: data.tracking_id, data };
    }

    // A bare exception code as remark hides the real reason — dump the body
    const remark = data && data.remark && !/^[A-Z0-9_]{6,}$/.test(data.remark)
        ? data.remark
        : `${(data && data.remark) || 'rejected'} — ${JSON.stringify(data || {}).substring(0, 300)}`;
    throw new Error(`Ekart API Error: ${remark}`);
}

/**
 * Create Ekart Return Order (reverse pickup from customer to warehouse)
 * Returns { waybill, shipment_id } or null on failure.
 */
async function createEkartReturnOrder(requestData, shopifyOrder) {
    try {
        // Fetch Shopify Order if missing
        if (!shopifyOrder && requestData.orderNumber) {
            try {
                let orderName = requestData.orderNumber;
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                }

                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
                if (!shopifyOrder) console.warn(`[${requestData.requestId}] ⚠️ Ekart: Shopify order not found for ${orderName}`);
            } catch (e) {
                console.error(`[${requestData.requestId}] Ekart: Failed to fetch original order:`, e.message);
            }
        }

        const address = shopifyOrder ? (shopifyOrder.shipping_address || (shopifyOrder.customer && shopifyOrder.customer.default_address)) : null;
        if (!address) {
            throw new Error(`Ekart: No customer address found (ShopifyOrder fetched: ${!!shopifyOrder}, orderNumber: ${requestData.orderNumber})`);
        }

        // Customer (pickup) details
        const customerName = `${address.first_name || ''} ${address.last_name || ''}`.trim() || 'Customer';
        const customerAddress = ((address.address1 || '') + ' ' + (address.address2 || '')).trim().substring(0, 200);
        let customerCity = address.city || '';
        let customerState = address.province || '';
        const customerPincode = address.zip;

        let customerPhone = requestData.customerPhone || address.phone || shopifyOrder?.phone || '9999999999';
        const digits = String(customerPhone).replace(/\D/g, '');
        customerPhone = digits.length >= 10 ? digits.slice(-10) : '9999999999';

        // Swift validation rejects blank drop city/state — backfill from Ekart's pincode master
        ({ city: customerCity, state: customerState } = await ekartBackfillCityState(customerPincode, customerCity, customerState));

        // Items summary
        // NOTE: This is the REVERSE PICKUP (collecting the original item from the customer).
        // The label must show the ORIGINAL item details — not the replacement.
        const items = Array.isArray(requestData.items) ? requestData.items : [];
        let totalQuantity = 0;
        let totalAmount = 0;
        const productsDesc = [];
        for (const item of items) {
            const title = item.name || 'Item';
            const variant = item.variant || '';
            const quantity = parseInt(item.quantity) || 1;
            const price = parseFloat(item.price) || 0;
            totalQuantity += quantity;
            totalAmount += price * quantity;
            productsDesc.push(buildExchangeProductName(title, variant));
        }

        const orderIdSuffix = requestData.delhiveryOrderIdSuffix || requestData.ekartOrderIdSuffix || '';
        const ekartOrderId = `${requestData.requestId}${orderIdSuffix}`;

        // Reverse shipment: payment_mode 'Pickup', drop_location = customer
        // address, pickup_location = registered warehouse alias (Ekart's naming
        // is semantically opposite to the ground flow).
        const payload = {
            ...ekartCommonShipmentFields(ekartOrderId, totalAmount, totalQuantity),
            consignee_name: customerName,
            consignee_phone: customerPhone,
            payment_mode: 'Pickup',
            products_desc: productsDesc.join(', ').substring(0, 250) || 'Return shipment',
            cod_amount: 0,
            return_reason: requestData.reason || requestData.returnReason || 'Customer return request',
            drop_location: ekartDropLocation(customerName, customerAddress, customerCity, customerState, customerPincode, customerPhone),
            ...ekartPickupLocationFields()
        };

        const { waybill, shipment_id, data } = await ekartCreateShipment(payload, requestData.requestId);
        return { waybill, shipment_id, success: true, data };
    } catch (error) {
        console.error(`[${requestData.requestId}] ❌ Failed to create Ekart return:`, error.message);
        throw error;
    }
}

/**
 * Create Ekart Forward Order (for exchange/replacement dispatch)
 * This sends item FROM warehouse TO customer (opposite of return pickup)
 */
async function createEkartForwardOrder(requestData, shopifyOrder) {
    try {
        console.log(`\n📦 Creating Ekart Forward Order for ${requestData.requestId}...`);

        // Fetch Shopify Order if we need customer address
        if (!shopifyOrder && requestData.orderNumber) {
            try {
                let orderName = requestData.orderNumber;
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
                }

                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
            } catch (e) {
                console.error(`[${requestData.requestId}] Ekart: Failed to fetch Shopify order:`, e.message);
            }
        }

        // Customer details (TO customer) - use new_* fields for exchange address, fall back to original
        let customerName = requestData.newName || requestData.customerName || 'Customer';
        let customerAddress = requestData.newAddress || requestData.shippingAddress || requestData.customerAddress || '';
        let customerCity = requestData.newCity || requestData.shippingCity || requestData.customerCity || '';
        let customerState = requestData.newState || requestData.shippingState || requestData.customerState || '';
        let customerPincode = requestData.newPincode || requestData.shippingPincode || requestData.customerPincode || '';
        let customerPhone = requestData.customerPhone || requestData.newPhone || '9999999999';

        // Parser: extract city/state/pincode from combined address string if missing
        // Indian address format: "street, area, CITY, STATE, PINCODE, Country"
        if (customerAddress && (!customerPincode || !customerCity || !customerState)) {
            const addrParts = customerAddress.split(',').map(s => s.trim()).filter(Boolean);
            if (addrParts.length >= 3) {
                const pincodeIdx = addrParts.findIndex(p => /^\d{6}$/.test(p));
                if (pincodeIdx > 0) {
                    if (!customerPincode) customerPincode = addrParts[pincodeIdx];
                    if (!customerState && pincodeIdx >= 2) customerState = addrParts[pincodeIdx - 1];
                    if (!customerCity && pincodeIdx >= 3) customerCity = addrParts[pincodeIdx - 2];
                } else {
                    const lastPart = addrParts[addrParts.length - 1];
                    const isCountry = /^(india|IN)$/i.test(lastPart);
                    const endIdx = isCountry ? addrParts.length - 2 : addrParts.length - 1;
                    if (!customerState && endIdx >= 1) customerState = addrParts[endIdx];
                    if (!customerCity && endIdx >= 2) customerCity = addrParts[endIdx - 1];
                }
            }
        }

        // Shopify fallback: if still missing city/state/pincode, use the original order address
        if (shopifyOrder && (!customerPincode || !customerCity || !customerState || !customerAddress)) {
            const address = shopifyOrder.shipping_address || (shopifyOrder.customer && shopifyOrder.customer.default_address);
            if (address) {
                customerName = customerName && customerName !== 'Customer' ? customerName : (`${address.first_name || ''} ${address.last_name || ''}`.trim() || customerName);
                if (!customerAddress) customerAddress = ((address.address1 || '') + ' ' + (address.address2 || '')).trim().substring(0, 200);
                customerCity = customerCity || address.city || '';
                customerState = customerState || address.province || '';
                customerPincode = customerPincode || address.zip || '';
                customerPhone = (customerPhone && customerPhone !== '9999999999') ? customerPhone : (address.phone || shopifyOrder?.phone || '9999999999');
            }
        }

        if (!customerAddress || !customerPincode) {
            throw new Error(`Ekart forward: customer address/pincode empty after all resolution attempts (address: '${!!customerAddress}', pincode: '${customerPincode}')`);
        }

        const phoneDigits = String(customerPhone).replace(/\D/g, '');
        customerPhone = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '9999999999';

        // Swift validation rejects blank drop city/state — backfill from Ekart's pincode master
        ({ city: customerCity, state: customerState } = await ekartBackfillCityState(customerPincode, customerCity, customerState));

        // Items summary
        const items = Array.isArray(requestData.items) ? requestData.items : [];
        let totalQuantity = 0;
        let totalAmount = 0;
        const productsDesc = [];
        for (const item of items) {
            const title = item.replacementProductTitle || item.name || 'Item';
            const quantity = parseInt(item.quantity) || 1;
            const price = parseFloat(item.replacementPrice || item.price) || 0;

            // Resolve replacement variant from Shopify if missing from stored items
            let resolvedVariant = item.replacementVariant || '';
            if (!resolvedVariant || resolvedVariant === 'Same') {
                const variantId = item.replacementVariantId || item.variantId || item.id;
                const productId = item.replacementProductId || item.productId;
                if (variantId && variantId !== 'Same' && productId) {
                    try {
                        const vData = await shopifyAPI(`products/${productId}/variants.json`);
                        const match = (vData.variants || []).find(v => v.id.toString() === variantId.toString());
                        if (match) {
                            resolvedVariant = match.title;
                            console.log(`[${requestData.requestId}] ✅ Ekart forward: recovered missing replacementVariant from Shopify: "${resolvedVariant}"`);
                        }
                    } catch (e) {
                        console.error(`[${requestData.requestId}] ❌ Ekart forward: Shopify variant lookup failed:`, e.message);
                    }
                }
            }

            totalQuantity += quantity;
            totalAmount += price * quantity;
            productsDesc.push(buildExchangeProductName(title, resolvedVariant));
        }

        // 'fws-' prefix keeps forward order ids distinct from return pickups of the same request;
        // suffix (e.g. -R1) keeps duplicate forward orders unique
        const ekartOrderId = `fws-${requestData.requestId}${requestData.forwardOrderIdSuffix || requestData.ekartOrderIdSuffix || ''}`;

        // Forward shipment: Prepaid, drop_location = customer address,
        // pickup_location = registered warehouse alias
        const payload = {
            ...ekartCommonShipmentFields(ekartOrderId, totalAmount, totalQuantity),
            consignee_name: customerName,
            consignee_phone: customerPhone,
            payment_mode: 'Prepaid',
            products_desc: productsDesc.join(', ').substring(0, 250) || 'Exchange shipment',
            cod_amount: 0,
            return_reason: '',
            drop_location: ekartDropLocation(customerName, customerAddress, customerCity, customerState, customerPincode, customerPhone),
            ...ekartPickupLocationFields()
        };

        const { waybill, shipment_id, data } = await ekartCreateShipment(payload, requestData.requestId);
        return { waybill, shipment_id, order_id: ekartOrderId, success: true, data };
    } catch (error) {
        console.error(`[${requestData.requestId}] ❌ Error creating Ekart forward order:`, error.message);
        throw error;
    }
}

/**
 * Get Ekart tracking details via GET /api/v1/track/{awb}, normalized to the
 * same { shipments: [...] } shape that getDelhiveryTracking returns so sync
 * consumers stay identical. Ekart returns:
 *   { track: { status, ctime, desc, location, details: [...] }, edd }
 */
async function getEkartTracking(waybill) {
    if (!waybill || !ekartConfigured()) return null;
    try {
        const raw = await ekartAPI(`/api/v1/track/${encodeURIComponent(waybill)}`);
        if (!raw || !raw.track) return null;

        const toIso = ms => {
            const n = Number(ms);
            return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
        };

        const currentStatus = raw.track.status || null;
        const isDelivered = /^delivered$/i.test(currentStatus || '');
        const isRtoDelivered = /^rto delivered$/i.test(currentStatus || '');
        // Status history, newest first (Ekart returns chronological)
        const events = (Array.isArray(raw.track.details) ? raw.track.details : [])
            .map(d => ({ status: d.status || '', desc: d.desc || '', location: d.location || '', datetime: toIso(d.ctime) }))
            .reverse();

        return {
            shipments: [{
                status: currentStatus,
                status_type: currentStatus,
                status_datetime: toIso(raw.track.ctime),
                delivered_status: (isDelivered || isRtoDelivered) ? currentStatus : null,
                delivered_date: (isDelivered || isRtoDelivered) ? toIso(raw.track.ctime) : null,
                waybill_code: waybill,
                eta: toIso(raw.edd),
                origin: null,
                destination: null,
                tracking_data: events,
                scans: events
            }]
        };
    } catch (error) {
        console.error('Ekart tracking fetch error:', error.message);
    }
    return null;
}

/**
 * Schedule pickup via Shiprocket with Delhivery fallback
 * This function is used by admin create-request endpoint
 */
async function schedulePickup(token, requestId, order, items, type, carrierOverride = null) {
    try {
        // Get carrier mode from settings
        const carrierMode = await getCarrierMode('pickup');
        const carrierResolution = resolveCarrier(carrierMode, carrierOverride, 'pickup');
        console.log(`[${requestId}] Scheduling pickup: primary=${carrierResolution.primary}, fallback=${carrierResolution.useFallback}`);
        
        let fallbackReason = null;
        
        // Prepare request data for Shiprocket/Delhivery/Ekart
        const requestData = {
            requestId,
            orderNumber: order.name,
            customerPhone: order.customer?.phone || '',
            items: items
        };

        // Try the resolved primary carrier, then the fallback partner if enabled
        let booking = null;
        try {
            booking = await returnBookingAttempt(carrierResolution.primary, requestData, order);
        } catch (primaryError) {
            if (!carrierResolution.useFallback) throw primaryError;
            const fallbackCarrier = carrierResolution.fallback || getFallbackCarrier(carrierResolution.primary);
            fallbackReason = `${carrierResolution.primary} failed: ${primaryError.message}`;
            console.warn(`[${requestId}] ️ ${carrierResolution.primary} failed, falling back to ${fallbackCarrier}:`, primaryError.message);
            booking = await returnBookingAttempt(fallbackCarrier, requestData, order);
        }

        console.log(`[${requestId}] ✅ ${booking.carrierUsed} success: ShipmentID ${booking.shipmentId}, AWB ${booking.awbNumber || 'PENDING'}`);

        return {
            awbNumber: booking.awbNumber,
            shipmentId: booking.shipmentId,
            pickupDate: booking.pickupDate,
            carrier: booking.carrierUsed,
            fallbackReason: fallbackReason
        };
    } catch (error) {
        console.error(`[${requestId}] schedulePickup error:`, error.message);
        return null;
    }
}

async function createShopifyExchangeOrder(requestData) {
    try {
        console.log('Creating Shopify Exchange Order for:', requestData.requestId);

        // Fetch original order with robust name matching
        let orderName = requestData.orderNumber;
        let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

        if (!shopifyData.orders || shopifyData.orders.length === 0) {
            const altName = orderName.startsWith('#') ? orderName.substring(1) : `#${orderName}`;
            shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
        }

        const originalOrder = shopifyData.orders && shopifyData.orders[0];

        if (!originalOrder) {
            console.error('Original order not found for exchange creation');
            return null;
        }

        // Determine Address
        let shippingAddress = { ...originalOrder.shipping_address };
        if (requestData.newAddress) {
            shippingAddress = {
                address1: requestData.newAddress,
                city: requestData.newCity,
                province: requestData.newState,
                zip: requestData.newPincode,
                country: 'India',
                first_name: requestData.customerName?.split(' ')[0] || originalOrder.customer?.first_name || 'Customer',
                last_name: requestData.customerName?.split(' ').slice(1).join(' ') || originalOrder.customer?.last_name || '',
                phone: requestData.customerPhone || originalOrder.shipping_address?.phone
            };
        }

        let items = requestData.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
        const lineItems = [];

        for (const item of items) {
            let variantId = item.replacementVariantId;

            // If variantId is missing (legacy request) or "Same", try to resolve it
            if ((!variantId || variantId === 'Same') && item.replacementVariant && item.productId) {
                try {
                    const variantsData = await shopifyAPI(`products/${item.productId}/variants.json`);
                    const variants = variantsData.variants || [];
                    const variant = variants.find(v =>
                        v.title === item.replacementVariant ||
                        v.option1 === item.replacementVariant ||
                        v.option2 === item.replacementVariant ||
                        v.id.toString() === item.replacementVariant
                    );
                    if (variant) variantId = variant.id;
                } catch (e) {
                    console.error(`Failed to fetch variants for product ${item.productId}:`, e);
                }
            }

            if (variantId && variantId !== 'Same') {
                lineItems.push({
                    variant_id: variantId,
                    quantity: parseInt(item.quantity) || 1
                });
            } else if (variantId === 'Same') {
                // If still "Same", use original variantId
                lineItems.push({
                    variant_id: item.variantId,
                    quantity: parseInt(item.quantity) || 1
                });
            } else {
                console.warn(`No valid replacement variant identified for item ${item.name} (Request ${requestData.requestId})`);
            }
        }

        if (lineItems.length === 0) {
            console.error('No valid replacement items identified for Shopify Order creation.');
            return null;
        }

        const orderPayload = {
            order: {
                line_items: lineItems,
                shipping_address: shippingAddress,
                billing_address: shippingAddress,
                customer: {
                    id: originalOrder.customer?.id
                },
                financial_status: 'paid',
                send_receipt: true,
                tags: `Exchange, Replacement, Orig-${requestData.orderNumber}`,
                note: `Exchange for Request ${requestData.requestId}. Reason: ${requestData.reason}`
            }
        };

        const response = await shopifyAPI('orders.json', {
            method: 'POST',
            body: JSON.stringify(orderPayload)
        });

        if (response.order) {
            console.log('✅ Shopify Exchange Order Created:', response.order.name);
            return response.order;
        } else {
            console.error('Failed to create Shopify order:', response);
            return null;
        }

    } catch (error) {
        console.error('Failed to create Shopify exchange order:', error);
        return null;
    }
}

// ==================== CONFIG ENDPOINT ====================

// Get frontend configuration (Razorpay key, etc.)
app.get('/api/config', async (req, res) => {
    res.json({
        razorpayKey: process.env.RAZORPAY_KEY_ID || null,
        allowReturns: await getSetting('allow_returns', true),
        allowExchanges: await getSetting('allow_exchanges', true)
    });
});

// ==================== PUBLIC API ENDPOINTS ====================

// Get order details
app.post('/api/get-order', async (req, res) => {
    try {
        const { orderNumber, email } = req.body;

        const data = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderNumber)}&email=${encodeURIComponent(email)}&status=any&limit=1`);

        if (!data.orders || data.orders.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json(data.orders[0]);
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper to get Shiprocket tracking details
async function getShiprocketTracking(awb) {
    if (!awb || !process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) return null;
    try {
        const trackingData = await shiprocketAPI(`/courier/track/awb/${awb}`);
        if (trackingData && trackingData.tracking_data) {
            return trackingData.tracking_data;
        }
    } catch (error) {
        console.error('Shiprocket tracking fetch error:', error.message);
    }
    return null;
}

// Enrich return/exchange items with the ACTUAL amount paid by the customer per unit.
// Customers often pay less than the product price (coupon codes, discount apps, etc.),
// so panels/refunds must reflect the paid amount, not the raw product price.
// Shopify line items carry `discount_allocations` for order-level discounts; when those
// are missing we fall back to a proportional split of the order's `total_discounts`.
function enrichItemsWithPaidPrice(items, shopifyOrder) {
    if (!Array.isArray(items) || items.length === 0 || !shopifyOrder) return items;
    const lineItems = Array.isArray(shopifyOrder.line_items) ? shopifyOrder.line_items : [];
    if (lineItems.length === 0) return items;

    const orderLevelDiscount = parseFloat(shopifyOrder.total_discounts || 0);
    const orderItemsSubtotal = lineItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
    const usedLineIds = new Set();

    return items.map(item => {
        // Match the Shopify line item: variant id → product id → name (first unused match)
        let lineItem = lineItems.find(li => !usedLineIds.has(li.id) && item.variantId && String(li.variant_id) === String(item.variantId));
        if (!lineItem) lineItem = lineItems.find(li => !usedLineIds.has(li.id) && item.productId && String(li.product_id) === String(item.productId));
        if (!lineItem) lineItem = lineItems.find(li => !usedLineIds.has(li.id) && item.name && li.name === item.name);
        if (!lineItem) return item;
        usedLineIds.add(lineItem.id);

        const qty = lineItem.quantity || parseInt(item.quantity || 1, 10) || 1;
        const unitPrice = parseFloat(lineItem.price || item.price || 0);
        const lineTotal = unitPrice * qty;

        // Discount allocated to this line by coupon/order-level discounts
        let lineDiscount = (lineItem.discount_allocations || []).reduce((s, da) => s + parseFloat(da.amount || 0), 0);
        if (!lineDiscount && orderLevelDiscount > 0 && orderItemsSubtotal > 0) {
            // No per-line allocation available — spread the order-level discount proportionally
            lineDiscount = orderLevelDiscount * (lineTotal / orderItemsSubtotal);
        }

        const paidTotal = Math.max(0, lineTotal - lineDiscount);
        const paidPrice = Math.round((paidTotal / qty) * 100) / 100;

        return {
            ...item,
            originalPrice: unitPrice,
            paidPrice,
            discounted: paidPrice < unitPrice
        };
    });
}

// Extract extra order-level charges the customer pays on top of item prices.
// COD orders carry a "COD Charges" shipping line (e.g. ₹99) which must count
// toward the amount actually paid by the customer.
function getOrderExtraCharges(shopifyOrder) {
    let codCharges = 0;
    if (shopifyOrder && Array.isArray(shopifyOrder.shipping_lines)) {
        for (const sl of shopifyOrder.shipping_lines) {
            const label = `${sl.title || ''} ${sl.code || ''}`.toLowerCase();
            if (label.includes('cod')) codCharges += parseFloat(sl.price || 0);
        }
    }
    return Math.round(codCharges * 100) / 100;
}

// Lazy backfill for requests created BEFORE paid-price tracking existed:
// when a request's items have no paidPrice, fetch the Shopify order once,
// enrich the items and persist them so coupon values/panel display use the
// amount the customer actually paid. Non-fatal — never breaks tracking.
async function ensurePaidPrices(request) {
    try {
        if (!request || !request.orderNumber) return request;
        let items = request.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
        if (!Array.isArray(items) || items.length === 0) return request;

        // Already enriched (items have paidPrice AND COD charges captured) — nothing to do
        const itemsEnriched = items.every(i => typeof i.paidPrice === 'number');
        if (itemsEnriched && typeof request.codCharges === 'number') return request;

        let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(request.orderNumber)}&status=any&limit=1`);
        if (!shopifyData.orders || shopifyData.orders.length === 0) {
            const altName = request.orderNumber.startsWith('#') ? request.orderNumber.substring(1) : '#' + request.orderNumber;
            shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(altName)}&status=any&limit=1`);
        }
        const shopifyOrder = shopifyData.orders && shopifyData.orders[0];
        if (!shopifyOrder) return request;

        const enriched = itemsEnriched ? items : enrichItemsWithPaidPrice(items, shopifyOrder);
        const codCharges = getOrderExtraCharges(shopifyOrder);
        request.items = enriched;
        request.codCharges = codCharges;

        // Persist so Shopify is only hit once per legacy request
        const { error: updErr } = await supabase
            .from('requests')
            .update({ items: enriched, cod_charges: codCharges })
            .eq('request_id', request.requestId);
        if (updErr) console.warn(`[PaidPrice] Persist failed for ${request.requestId}:`, updErr.message);
        else console.log(`[PaidPrice] Backfilled paid prices for ${request.requestId} (order ${request.orderNumber}, COD charges ₹${codCharges})`);
    } catch (err) {
        console.warn(`[PaidPrice] Enrichment failed for ${request && request.requestId}:`, err.message);
    }
    return request;
}

// Lookup order (improved with better error handling)
app.post('/api/lookup-order', async (req, res) => {
    try {
        console.log('--- LOOKUP REQUEST ---');
        console.log('Body:', req.body);
        console.log('Headers:', req.headers['content-type']);

        const { orderNumber, email } = req.body;

        if (!orderNumber || !email) {
            console.log('Lookup attempt with missing fields:', { orderNumber, email });
            return res.status(400).json({
                error: 'Order number and email/phone are required',
                isEligible: false
            });
        }

        console.log('Looking up order:', orderNumber, 'for email:', email);

        // Try to fetch order from Shopify
        let data;
        try {
            // 1. Try exact match
            data = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderNumber)}&status=any&limit=5`);

            // 2. If no result, try adding/removing '#'
            if (!data.orders || data.orders.length === 0) {
                let retryOrderNumber = orderNumber;
                if (orderNumber.startsWith('#')) {
                    retryOrderNumber = orderNumber.substring(1);
                } else {
                    retryOrderNumber = '#' + orderNumber;
                }

                console.log(`Retrying lookup with: ${retryOrderNumber}`);
                data = await shopifyAPI(`orders.json?name=${encodeURIComponent(retryOrderNumber)}&status=any&limit=5`);
            }
        } catch (apiError) {
            console.error('Shopify API Error:', apiError.message);
            return res.status(500).json({
                error: 'Failed to connect to Shopify API',
                details: apiError.message
            });
        }

        if (!data.orders || data.orders.length === 0) {
            console.log('No orders found for:', orderNumber);
            return res.status(404).json({
                error: 'Order not found',
                isEligible: false,
                eligibilityMessage: `Order ${orderNumber} not found. Please check your order number.`
            });
        }

        // Find order matching email OR phone
        const normalizedInput = email ? email.toLowerCase().trim() : '';
        const inputDigits = normalizedInput.replace(/\D/g, '');

        const order = data.orders.find(o => {
            const customerEmail = o.customer?.email?.toLowerCase() || '';
            const customerPhone = o.customer?.phone?.replace(/\D/g, '') || '';
            const shippingPhone = o.shipping_address?.phone?.replace(/\D/g, '') || '';

            // Check Email
            if (customerEmail && customerEmail === normalizedInput) return true;

            // Check Phone (loose match for last 10 digits)
            if (inputDigits.length >= 10) {
                if (customerPhone.endsWith(inputDigits.slice(-10))) return true;
                if (shippingPhone.endsWith(inputDigits.slice(-10))) return true;
            }
            return false;
        });

        if (!order) {
            console.log('Order found but email/phone does not match');
            return res.status(404).json({
                error: 'Order not found',
                isEligible: false,
                eligibilityMessage: 'Order not found with this email/phone. Please check your details.'
            });
        }

        console.log('Order found:', order.name);

        // ── One request per order guard ──────────────────────────────────────────
        // Check BEFORE eligibility so the form never loads for duplicate orders
        try {
            const existingForOrder = await getRequestsByOrderNumber(order.name);
            const activeForOrder = existingForOrder.filter(r => r.status !== 'rejected' && r.status !== 'waiting_payment');
            if (activeForOrder.length > 0) {
                const existing = activeForOrder[0];
                console.log(`Order ${order.name} already has active request ${existing.requestId}`);
                return res.status(400).json({
                    isEligible: false,
                    alreadyHasRequest: true,
                    existingRequestId: existing.requestId,
                    existingRequestType: existing.type,
                    error: `A ${existing.type} request (${existing.requestId}) already exists for this order. Track it at the Track Request page.`,
                    eligibilityMessage: `A ${existing.type} request (${existing.requestId}) has already been raised for this order. You can track it on the Track Request page.`
                });
            }
        } catch (dupCheckErr) {
            // Non-fatal — if duplicate check fails, continue and let submit-time guard catch it
            console.warn('Duplicate check failed (non-fatal):', dupCheckErr.message);
        }
        // ────────────────────────────────────────────────────────────────────────

        // Mutable — the Shopper Hub fallback below can mark unfulfilled orders as shipped
        let isFulfilled = order.fulfillment_status === 'fulfilled';

        // Fetch delivery date BEFORE eligibility check so we can base window on it
        let deliveredDate = null;
        let trackingCurrentStatus = null; // Track actual shipment status to block returns on in-transit orders
        if (order.fulfillments && order.fulfillments.length > 0) {
            const fulfillment = order.fulfillments[0];
            const awb = fulfillment.tracking_number;
            console.log('Fulfillment found. AWB:', awb);

            if (awb) {
                // Detect carrier from AWB format to query the right tracking API
                const fwdCarrier = detectCarrierForAwb(awb, null, null, null);
                console.log('Detected forward carrier:', fwdCarrier, 'for AWB:', awb);

                // Try primary carrier first, then fallback to other carriers for delivered_date
                const carrierFetchFns = {
                    delhivery: async () => {
                        const t = await getDelhiveryTracking(awb);
                        if (t?.shipments?.[0]) {
                            return {
                                deliveredDate: t.shipments[0].delivered_date || null,
                                status: (t.shipments[0].status || t.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_')
                            };
                        }
                        return null;
                    },
                    ekart: async () => {
                        const t = await getEkartTracking(awb);
                        if (t?.shipments?.[0]) {
                            return {
                                deliveredDate: t.shipments[0].delivered_date || null,
                                status: (t.shipments[0].status || t.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_')
                            };
                        }
                        return null;
                    },
                    shiprocket: async () => {
                        const t = await getShiprocketTracking(awb);
                        if (t) {
                            return {
                                deliveredDate: t.delivered_date || null,
                                status: (t.current_status || t.shipment_track?.[0]?.current_status || '').toLowerCase().replace(/\s+/g, '_')
                            };
                        }
                        return null;
                    }
                };

                // Order: try primary carrier first, then others as fallbacks
                const carrierOrder = [fwdCarrier, ...Object.keys(carrierFetchFns).filter(c => c !== fwdCarrier)];
                
                for (const carrier of carrierOrder) {
                    try {
                        const result = await carrierFetchFns[carrier]();
                        if (result) {
                            // Always take status from first successful tracking
                            if (!trackingCurrentStatus) {
                                trackingCurrentStatus = result.status;
                            }
                            // Take delivered_date from first carrier that has it
                            if (result.deliveredDate) {
                                deliveredDate = result.deliveredDate;
                                console.log(`Got deliveredDate from ${carrier}: ${deliveredDate}`);
                                break; // Found delivery date, stop trying other carriers
                            }
                        }
                    } catch (trackErr) {
                        console.warn(`Tracking fetch failed for ${carrier}:`, trackErr.message);
                    }
                }
                console.log('Final deliveredDate:', deliveredDate, '| tracking status:', trackingCurrentStatus, '| primary carrier:', fwdCarrier);
            }
        } else {
            console.log('No fulfillments found for order');
        }

        // ── Shopper Hub fallback (WhatsApp Shoppers Hub orders) ─────────────────
        // Some orders were shipped under Shiprocket's "Custom" channel instead of
        // the Shopify channel, so Shopify never received a fulfillment and the
        // portal wrongly blocks returns/exchanges for them. When the admin toggle
        // is on, trust the shopper data stored by the WhatsApp bot (its Supabase
        // store_shoppers + orders tables) as proof the order shipped/delivered.
        let shopperHubOrder = false;
        if ((!isFulfilled || !deliveredDate) && await getSetting('allow_shopper_hub_orders', true)) {
            try {
                const shopperInfo = await shopperHubDB.findShopperOrder(order.name);
                if (shopperInfo) {
                    console.log(`[ShopperHub] Order ${order.name} resolved via shopper data (AWB ${shopperInfo.awb}, status ${shopperInfo.orderStatus})`);
                    isFulfilled = true;
                    shopperHubOrder = true;

                    // Resolve the real delivery date for the return window check
                    if (!deliveredDate && shopperInfo.deliveredAt) {
                        deliveredDate = shopperInfo.deliveredAt;
                    }
                    if (!deliveredDate && shopperInfo.awb) {
                        const shopperCarrier = detectCarrierForAwb(shopperInfo.awb, null, null, null);
                        try {
                            if (shopperCarrier === 'delhivery') {
                                const st = await getDelhiveryTracking(shopperInfo.awb);
                                if (st?.shipments?.[0]?.delivered_date) deliveredDate = st.shipments[0].delivered_date;
                                else if (st?.shipments?.[0]) trackingCurrentStatus = trackingCurrentStatus || (st.shipments[0].status || st.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_');
                            } else if (shopperCarrier === 'ekart') {
                                const st = await getEkartTracking(shopperInfo.awb);
                                if (st?.shipments?.[0]?.delivered_date) deliveredDate = st.shipments[0].delivered_date;
                                else if (st?.shipments?.[0]) trackingCurrentStatus = trackingCurrentStatus || (st.shipments[0].status || st.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_');
                            } else {
                                const st = await getShiprocketTracking(shopperInfo.awb);
                                if (st?.delivered_date) deliveredDate = st.delivered_date;
                                else if (st) trackingCurrentStatus = trackingCurrentStatus || (st.current_status || st.shipment_track?.[0]?.current_status || '').toLowerCase().replace(/\s+/g, '_');
                            }
                        } catch (stErr) { console.warn('[ShopperHub] Tracking fetch failed:', stErr.message); }
                    }
                    console.log(`[ShopperHub] deliveredDate resolved to: ${deliveredDate || 'unknown (allowing as fulfilled)'}`);
                }
            } catch (shopperErr) {
                console.warn('Shopper Hub fallback failed (non-fatal):', shopperErr.message);
            }
        }
        // ──────────────────────────────────────────────────────────────────────────

        // Eligibility: Check cutoff date first
        const CUTOFF_ENABLED = await getSetting('cutoff_date_enabled', false);
        const CUTOFF_DATE = await getSetting('cutoff_date', null);
        
        if (CUTOFF_ENABLED && CUTOFF_DATE && order.created_at) {
            const orderDate = new Date(order.created_at);
            const cutoff = new Date(CUTOFF_DATE);
            // Set cutoff to end of day for inclusive comparison
            cutoff.setHours(23, 59, 59, 999);
            
            if (orderDate < cutoff) {
                return res.status(200).json({
                    isEligible: false,
                    eligibilityMessage: `This order is not eligible for return/exchange as it was placed before the cutoff date (${CUTOFF_DATE}).`,
                    order: {
                        orderNumber: order.name,
                        customerName: order.customer
                            ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
                            : 'Customer',
                        email: order.customer?.email || email,
                        phone: order.customer?.phone || order.shipping_address?.phone || '',
                        orderDate: order.created_at,
                        totalAmount: order.total_price,
                        codCharges: getOrderExtraCharges(order),
                        items: enrichItemsWithPaidPrice(order.line_items.map(item => ({
                            id: item.id,
                            productId: item.product_id,
                            variantId: item.variant_id,
                            name: item.name,
                            variant: item.variant_title || 'Default',
                            quantity: item.quantity,
                            price: item.price,
                            image: item.properties?.image ||
                                (item.product_id ? `https://cdn.shopify.com/shopifycloud/placeholder.jpg` : '')
                        })), order)
                    }
                });
            }
        }

        // Eligibility: Check window mode (delivery date vs order date)
        const RETURN_WINDOW_DAYS = await getSetting('return_window_days', 2);
        const RETURN_WINDOW_MODE = await getSetting('return_window_mode', 'delivery');
        let daysSinceReference = null;
        let isWithinWindow = false;
        let referenceDate = null;

        if (RETURN_WINDOW_MODE === 'order') {
            // Calculate from order date
            referenceDate = order.created_at;
            if (referenceDate) {
                const orderDate = new Date(referenceDate);
                daysSinceReference = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);
                isWithinWindow = daysSinceReference <= RETURN_WINDOW_DAYS;
            }
        } else {
            // Calculate from delivery date (default behavior)
            if (deliveredDate) {
                referenceDate = deliveredDate;
                const delivered = new Date(deliveredDate);
                daysSinceReference = (Date.now() - delivered.getTime()) / (1000 * 60 * 60 * 24);
                isWithinWindow = daysSinceReference <= RETURN_WINDOW_DAYS;
            } else if (isFulfilled) {
                // No delivery date available — check actual tracking status
                // Block returns if the shipment is still in transit / out for delivery
                const inTransitStatuses = ['in_transit', 'out_for_delivery', 'shipped', 'picked_up', 'ready_to_ship'];
                if (trackingCurrentStatus && inTransitStatuses.includes(trackingCurrentStatus)) {
                    isWithinWindow = false; // Order not yet delivered — block return
                    console.log(`[lookup-order] Order fulfilled but tracking status is "${trackingCurrentStatus}" — blocking return (not delivered yet)`);
                } else {
                    // Fulfilled + not in transit = must be delivered (tracking just didn't return a date)
                    // Treat as delivered now — 2-day window starts from today
                    referenceDate = new Date().toISOString();
                    deliveredDate = referenceDate;
                    daysSinceReference = 0;
                    isWithinWindow = true;
                    console.log(`[lookup-order] No deliveredDate but fulfilled & not in transit — treating as delivered today (window starts now)`);
                }
            }
        }

        const windowTypeText = RETURN_WINDOW_MODE === 'order' ? 'order date' : 'delivery';
        const inTransitStatuses = ['in_transit', 'out_for_delivery', 'shipped', 'picked_up', 'ready_to_ship'];
        const orderInTransit = isFulfilled && !deliveredDate && trackingCurrentStatus && inTransitStatuses.includes(trackingCurrentStatus);
        const eligibilityMessage = RETURN_WINDOW_MODE === 'order'
            ? (!isWithinWindow
                ? `Return/exchange window has closed. Requests must be raised within ${RETURN_WINDOW_DAYS} days of order date.`
                : 'Order is eligible for exchange/return')
            : (orderInTransit
                ? `Your order is still in transit (${trackingCurrentStatus.replace(/_/g, ' ')}). Please wait until delivery before raising a return/exchange request.`
                : !isFulfilled
                    ? 'Order must be delivered before exchange/return'
                    : !isWithinWindow
                        ? `Return/exchange window has closed. Requests must be raised within ${RETURN_WINDOW_DAYS} days of delivery.`
                        : 'Order is eligible for exchange/return');

        console.log('Eligibility:', { isFulfilled, deliveredDate, referenceDate, daysSinceReference, isWithinWindow, returnWindowMode: RETURN_WINDOW_MODE });

        // Fetch product images and variants for inventory check
        const productIds = [...new Set(order.line_items.map(item => item.product_id).filter(id => id))];
        const productDataMap = {}; // Stores images and variants

        if (productIds.length > 0) {
            try {
                // Fetch fields: id, image, images, variants (for inventory)
                const productsData = await shopifyAPI(`products.json?ids=${productIds.join(',')}&fields=id,image,images,variants`);
                if (productsData.products) {
                    productsData.products.forEach(p => {
                        let imageUrl = null;
                        if (p.image) {
                            imageUrl = p.image.src;
                        } else if (p.images && p.images.length > 0) {
                            imageUrl = p.images[0].src;
                        }

                        // Process variants
                        const variants = p.variants.map(v => ({
                            id: v.id,
                            title: v.title,
                            price: v.price,
                            inventory_quantity: v.inventory_quantity,
                            inventory_policy: v.inventory_policy,
                            inventory_management: v.inventory_management
                        }));

                        productDataMap[p.id] = {
                            image: imageUrl,
                            variants: variants
                        };
                    });
                }
            } catch (err) {
                console.error('Failed to fetch product data:', err);
                // Continue without extra data
            }
        }

        // Format shipping address
        let shippingAddress = 'No shipping address';
        if (order.shipping_address) {
            const addr = order.shipping_address;
            shippingAddress = [
                addr.address1,
                addr.address2,
                addr.city,
                addr.province,
                addr.zip,
                addr.country
            ].filter(part => part).join(', ');
        }

        res.json({
            isEligible: isFulfilled && isWithinWindow,
            eligibilityMessage,
            shopperHubOrder, // true when eligibility was proven via WhatsApp shopper data
            productVariants: productDataMap, // Send variants to frontend
            order: {
                orderNumber: order.name,
                customerName: order.customer
                    ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
                    : 'Customer',
                email: order.customer?.email || email,
                phone: order.customer?.phone || order.shipping_address?.phone || '',
                orderDate: order.created_at,
                deliveredDate: deliveredDate, // NEW FIELD
                totalAmount: order.total_price,
                codCharges: getOrderExtraCharges(order),
                shippingAddress,
                items: enrichItemsWithPaidPrice(order.line_items.map(item => {
                    const pData = productDataMap[item.product_id] || {};
                    return {
                        id: item.id,
                        productId: item.product_id,
                        variantId: item.variant_id,
                        name: item.name,
                        variant: item.variant_title || 'Default',
                        quantity: item.quantity,
                        price: item.price,
                        image: pData.image || (item.properties && item.properties.image) || `https://cdn.shopify.com/shopifycloud/placeholder.jpg`
                    };
                }), order)
            }
        });
    } catch (error) {
        console.error('Lookup order error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Search products for exchange
app.get('/api/products/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        // Fetch ALL active products from Shopify (uses cache, paginates up to 5000 products)
        const allProducts = await fetchAllShopifyProducts();

        let products = allProducts || [];

        if (query) {
            const lowerQuery = query.toLowerCase();
            products = products.filter(p =>
                p.title.toLowerCase().includes(lowerQuery) ||
                (p.handle && p.handle.toLowerCase().includes(lowerQuery)) ||
                (p.product_type && p.product_type.toLowerCase().includes(lowerQuery)) ||
                p.id.toString() === query
            );
        }

        const formatted = products.map(p => ({
            id: p.id,
            title: p.title,
            image: p.image ? p.image.src : (p.images && p.images.length > 0 ? p.images[0].src : null),
            variants: (p.variants || []).map(v => ({
                id: v.id,
                title: v.title,
                price: v.price,
                inventory_quantity: v.inventory_quantity,
                inventory_policy: v.inventory_policy,
                inventory_management: v.inventory_management
            }))
        }));

        res.json(formatted);
    } catch (error) {
        console.error('Product search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get product variants with full info
app.post('/api/get-variants', async (req, res) => {
    try {
        const { productId } = req.body;
        const data = await shopifyAPI(`products/${productId}.json?fields=id,title,image,variants`);

        if (!data.product) return res.status(404).json({ error: 'Product not found' });

        const p = data.product;
        res.json({
            id: p.id,
            title: p.title,
            image: p.image ? p.image.src : (p.images && p.images.length > 0 ? p.images[0].src : null),
            variants: p.variants.map(v => ({
                id: v.id,
                title: v.title,
                price: v.price,
                inventory_quantity: v.inventory_quantity,
                inventory_policy: v.inventory_policy,
                inventory_management: v.inventory_management
            }))
        });
    } catch (error) {
        console.error('Get variants error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== WHATSAPP BOT INTEGRATION ====================

// ── Zoho middleware bridge ─────────────────────────────────
// When an exchange is finalized (forward/replacement shipment created), push
// the REAL original + exchanged products to the WhatsApp bot middleware so
// Zoho Books reflects what was actually returned/exchanged — not the
// original order selection. Fire-and-forget: never blocks approval.
async function notifyZohoExchange(requestDetails, items) {
    const botUrl = process.env.WHATSAPP_BOT_URL || 'http://localhost:3000';
    const internalToken = process.env.WHATSAPP_INTERNAL_TOKEN || '';
    const list = items || [];
    const exchangedItems = [];

    for (const i of list) {
        // The replacement size decides which Zoho item (and stock) the invoice
        // line must point at — resolve it from Shopify when the request was
        // stored without it, exactly like the forward-order paths do.
        const variant = await resolveExchangeReplacementVariant(i, requestDetails.requestId);
        exchangedItems.push({
            title: buildExchangeProductName(
                i.replacementProductTitle || i.name || i.title || '',
                // Only use the resolved replacement size — never fall back to the
                // original variant, which would send the wrong size to Zoho.
                variant
            ),
            sku: i.replacementSku || '',
            quantity: parseInt(i.quantity || 1),
            // What the replacement is billed at on its own Zoho invoice. The
            // middleware falls back to the amount paid for the replaced item
            // when this is 0, so a same-price swap never moves money.
            price: parseFloat(i.replacementPrice || 0) || 0,
            variant
        });
    }

    const payload = {
        order_id: String(requestDetails.orderNumber || ''),
        original_items: list.map(i => ({
            title: i.name || i.title || '',
            sku: i.sku || '',
            quantity: parseInt(i.quantity || 1),
            price: parseFloat(i.paidPrice || i.price || 0)
        })),
        exchanged_items: exchangedItems
    };
    const res = await fetch(botUrl.replace(/\/$/, '') + '/webhooks/zoho/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': internalToken },
        body: JSON.stringify(payload)
    });
    console.log('[' + requestDetails.requestId + '] 📒 Zoho exchange notify → ' + res.status);
    return res.status;
}

// Resolve the replacement size (variant title) for an exchange item, falling
// back to a Shopify variant lookup when replacementVariant was not stored.
async function resolveExchangeReplacementVariant(item, requestId) {
    const stored = item.replacementVariant;
    if (stored && stored !== 'Same') return stored;

    const variantId = item.replacementVariantId || item.variantId || item.id;
    const productId = item.replacementProductId || item.productId;
    if (!variantId || variantId === 'Same' || !productId) return '';

    try {
        const variantsData = await shopifyAPI(`products/${productId}/variants.json`);
        const match = (variantsData.variants || []).find(v => v.id.toString() === variantId.toString());
        if (match && match.title && match.title !== 'Default Title') {
            console.log(`[${requestId}] 🔍 Zoho exchange: replacement size "${match.title}" resolved from Shopify variant ${variantId}`);
            return match.title;
        }
    } catch (e) {
        console.warn(`[${requestId}] ⚠️ Zoho exchange: variant lookup failed for ${variantId}: ${e.message}`);
    }
    return '';
}

/**
 * When a pure return is finalized (approved or approved-with-discount),
 * notify the WhatsApp bot middleware so Zoho Books creates a credit note
 * mirroring the original invoice. Fire-and-forget: never blocks approval.
 */
async function notifyZohoReturn(requestDetails, items) {
    const botUrl = process.env.WHATSAPP_BOT_URL || 'http://localhost:3000';
    const internalToken = process.env.WHATSAPP_INTERNAL_TOKEN || '';
    const payload = {
        order_id: String(requestDetails.orderNumber || ''),
        return_items: (items || []).map(i => ({
            title: i.name || i.title || '',
            sku: i.sku || '',
            quantity: parseInt(i.quantity || 1),
            price: parseFloat(i.paidPrice || i.price || 0)
        }))
    };
    try {
        const res = await fetch(botUrl.replace(/\/$/, '') + '/webhooks/zoho/return', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-token': internalToken },
            body: JSON.stringify(payload)
        });
        console.log('[' + requestDetails.requestId + '] 📒 Zoho return notify → ' + res.status);
        return res.status;
    } catch (e) {
        console.warn('[' + requestDetails.requestId + '] ⚠️ Zoho return notify failed: ' + e.message);
        return 0;
    }
}

// ── Meta Template Definition: Return/Exchange Approval ──
const RETURN_EXCHANGE_APPROVAL_TEMPLATE = {
    name: 'return_exchange_approved',
    category: 'UTILITY',
    language: 'en',
    header: null,
    body: `📦 *RETURN / EXCHANGE APPROVED – MANDATORY STEPS*

Hi! Your *Return/Exchange Request* has been approved and is ready for pickup.

🆔 *Request ID:* {{1}}
📦 *Order Number:* {{2}}
🔄 *Request Type:* {{3}}

*Before handing over the package to the pickup executive, please record a continuous handover video showing:*

• The product(s) being packed.
• The package being sealed properly.
• The pickup executive receiving the package.
• The AWB/shipping label clearly visible (if applicable).

⚠️ *Important:* This handover video is *mandatory* and will be required in case of any future disputes, such as:
• Wrong product received at our warehouse
• Missing item(s)
• Empty package claims
• Transit-related issues

*Without a valid handover video, we may be unable to process such claims.*

Thank you for your cooperation! 💙`,
    footer: null,
    buttons: null,
    variables: [
        { name: 'request_id', example: 'REQ-67796' },
        { name: 'order_number', example: '#12345' },
        { name: 'request_type', example: 'Return' }
    ]
};

/**
 * Submit the Return/Exchange Approval template to Meta for review.
 * Call once (e.g. via a one-time script or admin endpoint) to get the template approved.
 */
async function submitReturnExchangeApprovalTemplate() {
    const tpl = RETURN_EXCHANGE_APPROVAL_TEMPLATE;
    console.log('[Meta Template] Submitting return_exchange_approved template to Meta…');
    const result = await metaWhatsApp.submitTemplateToMeta(tpl);
    if (result.success) {
        console.log('[Meta Template] ✅ Template submitted. ID:', result.templateId);
    } else {
        console.error('[Meta Template] ❌ Submission failed:', result.error);
    }
    return result;
}

/**
 * Utility: Send the Return/Exchange Approval WhatsApp message via Meta Cloud API.
 * Uses the approved Meta template "return_exchange_approved" with 3 body variables.
 *
 * @param {Object} opts
 * @param {string} opts.phone        - Customer phone (with country code, e.g. '919876543210')
 * @param {string} opts.requestId    - e.g. "REQ-67796"
 * @param {string} opts.orderNumber  - e.g. "#12345"
 * @param {string} opts.type         - "return" or "exchange"
 * @returns {Promise<{success, messageId?, error?}>}
 */
async function sendReturnExchangeApprovalWhatsApp({ phone, requestId, orderNumber, type }) {
    if (!phone) {
        console.warn(`[${requestId}] ⚠️ No phone number – skipping approval WhatsApp`);
        return { success: false, error: 'No phone number' };
    }

    const typeLabel = (type || 'return').charAt(0).toUpperCase() + (type || 'return').slice(1);

    // Ordered variable pool matching {{1}}, {{2}}, {{3}} in the Meta template body
    const parameters = [requestId, orderNumber, typeLabel];

    try {
        console.log(`[${requestId}] 📤 Sending Meta template "return_exchange_approved" to ${phone}`);
        const result = await metaWhatsApp.sendTemplateMessage(
            phone,
            'return_exchange_approved',   // Meta-approved template name
            parameters,
            'en'
        );

        if (result.success) {
            console.log(`[${requestId}] ✅ Approval WhatsApp sent via ${result.fallback ? 'bot fallback' : 'Meta Cloud API'}. Message ID: ${result.messageId}`);
        } else {
            console.error(`[${requestId}] ❌ Approval WhatsApp failed:`, result.error);
        }
        return result;
    } catch (error) {
        console.error(`[${requestId}] ❌ Approval WhatsApp exception:`, error.message);
        return { success: false, error: error.message };
    }
}

// ── Meta Template Definition: Self-Ship Required (Unserviceable Pincode) ──
const SELF_SHIP_REQUIRED_TEMPLATE = {
    name: 'self_ship_required',
    category: 'UTILITY',
    language: 'en',
    header: null,
    body: `📦 *SELF-SHIP REQUIRED – RETURN/EXCHANGE REQUEST*

Hi! Unfortunately, we're *unable to arrange a pickup* for your {{1}} request because your location is currently *unserviceable by both of our pickup partners.*

💰 *The ₹150 pickup fee (if paid) will be automatically refunded within 24 hours.*

Please *self-ship* the product to the following address:

📍 *Shipping Address:*
{{2}}

📞 *Mobile:* {{3}}

📝 *Please place a note inside the package with the following details:*
• Order Number: {{4}}
• Return/Exchange Request ID: {{5}}
• Registered Name
• Registered Mobile Number
• Return or Exchange Request

🚚 Once you've shipped the package, please *share the courier receipt and AWB/Tracking Number* with us so we can track your shipment.

📦 Once your return reaches our warehouse and successfully passes the *Quality Check (QC)*, we'll process the next step of your request *(Replacement, Store Credit, or Refund, as applicable).*

Thank you for your cooperation, and we sincerely apologize for the inconvenience. 💙`,
    footer: null,
    buttons: null,
    variables: [
        { name: 'request_type', example: 'Return/Exchange' },
        { name: 'warehouse_address', example: 'BURB MANUFACTURES PRIVATE LIMITED, K NO 181/169, K NO 229, Vill. BAIRAWAS, Distt. Mahendergarh, Haryana - 123028' },
        { name: 'warehouse_phone', example: '+91 82959 88424' },
        { name: 'order_number', example: '#12345' },
        { name: 'request_id', example: 'REQ-67796' }
    ]
};

/**
 * Submit the Self-Ship Required template to Meta for review.
 * Call once (e.g. via a one-time script or admin endpoint) to get the template approved.
 */
async function submitSelfShipRequiredTemplate() {
    const tpl = SELF_SHIP_REQUIRED_TEMPLATE;
    console.log('[Meta Template] Submitting self_ship_required template to Meta…');
    const result = await metaWhatsApp.submitTemplateToMeta(tpl);
    if (result.success) {
        console.log('[Meta Template] ✅ Template submitted. ID:', result.templateId);
    } else {
        console.error('[Meta Template] ❌ Submission failed:', result.error);
    }
    return result;
}

/**
 * Utility: Send the Self-Ship Required WhatsApp message via Meta Cloud API.
 * Uses the approved Meta template "self_ship_required" with 5 body variables.
 *
 * @param {Object} opts
 * @param {string} opts.phone            - Customer phone (with country code, e.g. '919876543210')
 * @param {string} opts.requestId        - e.g. "REQ-67796"
 * @param {string} opts.orderNumber      - e.g. "#12345"
 * @param {string} opts.type             - "return" or "exchange"
 * @param {string} opts.warehouseAddress - Full warehouse shipping address
 * @param {string} opts.warehousePhone   - Warehouse contact number
 * @returns {Promise<{success, messageId?, error?}>}
 */
async function sendSelfShipRequiredWhatsApp({ phone, requestId, orderNumber, type, warehouseAddress, warehousePhone }) {
    if (!phone) {
        console.warn(`[${requestId}] ⚠️ No phone number – skipping self-ship WhatsApp`);
        return { success: false, error: 'No phone number' };
    }

    const typeLabel = (type || 'return').charAt(0).toUpperCase() + (type || 'return').slice(1);

    // Ordered variable pool matching {{1}}..{{5}} in the Meta template body
    const parameters = [
        typeLabel,                  // {{1}} request_type
        warehouseAddress,           // {{2}} warehouse_address
        warehousePhone,             // {{3}} warehouse_phone
        orderNumber,                // {{4}} order_number
        requestId                   // {{5}} request_id
    ];

    try {
        console.log(`[${requestId}] 📤 Sending Meta template "self_ship_required" to ${phone}`);
        const result = await metaWhatsApp.sendTemplateMessage(
            phone,
            'self_ship_required',   // Meta-approved template name
            parameters,
            'en'
        );

        if (result.success) {
            console.log(`[${requestId}] ✅ Self-ship WhatsApp sent via ${result.fallback ? 'bot fallback' : 'Meta Cloud API'}. Message ID: ${result.messageId}`);
        } else {
            console.error(`[${requestId}] ❌ Self-ship WhatsApp failed:`, result.error);
        }
        return result;
    } catch (error) {
        console.error(`[${requestId}] ❌ Self-ship WhatsApp exception:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Helper: Resolve the warehouse address and phone from settings (or defaults).
 * Used by self-ship WhatsApp message to build the address string.
 */
async function resolveWarehouseAddress() {
    const warehouseLocation = await getSetting('warehouse_location', null);

    let address = 'BURB MANUFACTURES PRIVATE LIMITED, K NO 181/169, K NO 229, Vill. BAIRAWAS, Distt. Mahendergarh, Haryana - 123028';
    let phone = '8295988424';

    if (warehouseLocation) {
        const parts = [
            warehouseLocation.name,
            warehouseLocation.address || warehouseLocation.address_line_1,
            warehouseLocation.address_2 || warehouseLocation.address_line_2,
            warehouseLocation.city,
            warehouseLocation.state,
            warehouseLocation.pin_code || warehouseLocation.pincode
        ].filter(Boolean);
        if (parts.length > 0) address = parts.join(', ');
        if (warehouseLocation.phone) phone = warehouseLocation.phone;
    }

    // Format for WhatsApp display: 10-digit number → "+91 XXXXX XXXXX"
    const phoneDigits = String(phone).replace(/\D/g, '').slice(-10);
    if (phoneDigits.length === 10) phone = `+91 ${phoneDigits.slice(0, 5)} ${phoneDigits.slice(5)}`;

    return { address, phone };
}

/**
 * Test endpoint: send the self-ship required template to test numbers.
 * Auth: x-internal-token (same as other /api/internal/* endpoints).
 * POST /api/internal/test/self-ship  { phones: ['91xxxxxxxxxx', ...] }
 */
app.post('/api/internal/test/self-ship', async (req, res) => {
    try {
        const expectedToken = process.env.WHATSAPP_INTERNAL_TOKEN;
        if (expectedToken && req.headers['x-internal-token'] !== expectedToken) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const DEFAULT_TEST_PHONES = ['917419112241', '919992722207', '919413378016'];
        const phones = (Array.isArray(req.body?.phones) && req.body.phones.length > 0)
            ? req.body.phones.map(p => String(p).replace(/\D/g, '')).filter(d => d.length >= 10)
            : DEFAULT_TEST_PHONES;

        const { address, phone: warehousePhone } = await resolveWarehouseAddress();
        console.log(`[Self-Ship Test] Resolved warehouse address: ${address} | phone: ${warehousePhone}`);

        const results = [];
        for (const phone of phones) {
            const result = await sendSelfShipRequiredWhatsApp({
                phone,
                requestId: 'REQ-TEST-0001',
                orderNumber: '#TEST-0001',
                type: 'return',
                warehouseAddress: address,
                warehousePhone
            });
            results.push({ phone, success: result.success, messageId: result.messageId || null, error: result.error || null, fallback: !!result.fallback });
        }

        res.json({ success: true, warehouseAddress: address, warehousePhone, results });
    } catch (error) {
        console.error('[Self-Ship Test] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Issue a Razorpay refund for the pickup fee when all carriers fail (unserviceable pincode).
 * Refunds the full payment amount back to the customer.
 *
 * @param {string} requestId    - e.g. "REQ-67796"
 * @param {string} paymentId    - Razorpay payment ID (e.g. "pay_XXXX")
 * @param {number} paymentAmount - Amount in ₹ (rupees, not paise)
 * @returns {Promise<{success, refundId?, error?}>}
 */
async function issuePickupFeeRefund(requestId, paymentId, paymentAmount) {
    if (!razorpay) {
        console.error(`[${requestId}] ❌ Cannot refund: Razorpay not configured`);
        return { success: false, error: 'Razorpay not configured' };
    }
    if (!paymentId) {
        console.warn(`[${requestId}] ⚠️ No paymentId – skipping refund`);
        return { success: false, error: 'No payment ID' };
    }

    // Razorpay expects amount in the smallest currency unit (paise for INR)
    const refundAmountPaise = Math.round((paymentAmount || 0) * 100);
    if (refundAmountPaise <= 0) {
        console.warn(`[${requestId}] ⚠️ Invalid refund amount (${refundAmountPaise} paise) – skipping`);
        return { success: false, error: 'Invalid refund amount' };
    }

    try {
        console.log(`[${requestId}] 💰 Issuing Razorpay refund of ₹${paymentAmount} for payment ${paymentId}`);
        const refund = await razorpay.payments.refund(paymentId, {
            amount: refundAmountPaise,
            speed: 'optimum',
            notes: {
                request_id: requestId,
                reason: 'pickup_unserviceable_self_ship'
            }
        });

        console.log(`[${requestId}] ✅ Refund processed: ${refund.id}, status: ${refund.status}`);
        return { success: true, refundId: refund.id, status: refund.status };
    } catch (error) {
        console.error(`[${requestId}] ❌ Razorpay refund failed:`, error.message);
        return { success: false, error: error.message };
    }
}

async function sendWhatsAppNotification(phone, message, type, requestId, templateData = null) {
    if (!phone || !message) return null;

    // Use environment variable or default to localhost:3000 (standard for local dev)
    const botUrl = process.env.WHATSAPP_BOT_URL || 'http://localhost:3000';
    const internalToken = process.env.WHATSAPP_INTERNAL_TOKEN || '';

    try {
        console.log(`[${requestId}] 📤 Sending WhatsApp notification to ${phone}`);
        // Ensure fetch is available (Node 18+)
        const response = await fetch(`${botUrl}/api/internal/send-notification`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-internal-token': internalToken
            },
            body: JSON.stringify({ phone, message, type, requestId, templateData })
        });

        const data = await response.json();
        if (data.success) {
            console.log(`[${requestId}] ✅ WhatsApp notification sent: ${data.messageId}`);
            return { success: true, messageId: data.messageId, fallback: data.fallback };
        } else {
            console.warn(`[${requestId}] ⚠️ WhatsApp notification failed: ${data.error}`);
            throw new Error(data.error || 'WhatsApp send failed');
        }
    } catch (error) {
        console.error(`[${requestId}] ❌ WhatsApp notification error:`, error.message);
        throw error;
    }
}

/**
 * Finalize a request after payment is confirmed (either via frontend response or webhook)
 */
async function finalizeRequestAfterPayment(requestId, paymentId, paymentAmount) {
    console.log(`[${requestId}] 🚀 Finalizing request after payment confirmation. PaymentId: ${paymentId}`);

    try {
        const request = await getRequestById(requestId);
        if (!request) {
            console.error(`[${requestId}] ❌ Cannot finalize: Request not found in DB`);
            return { success: false, error: 'Request not found' };
        }

        if (request.status !== 'waiting_payment' && request.status !== 'pending') {
            console.log(`[${requestId}] ℹ️ Request already fully processed (Status: ${request.status})`);
            return { success: true, alreadyProcessed: true };
        }

        // Idempotency guard: if request already has an AWB, skip duplicate Delhivery order creation
        if (request.awbNumber || request.carrierAwb) {
            console.log(`[${requestId}] ℹ️ Request already has AWB ${request.awbNumber || request.carrierAwb}, skipping duplicate pickup creation`);
            return { success: true, alreadyProcessed: true, existingAwb: request.awbNumber || request.carrierAwb };
        }

        // 1. Prepare Updates
        const updates = {
            paymentId: paymentId,
            paymentAmount: paymentAmount,
            status: 'pending' // Default status after payment
        };

        // 2. Auto-Pickup: only for paid non-fee-waived requests.
        // Fee-waived (defective/wrong_item) stay 'pending' for admin review before pickup.
        const isFeeWaived = request.reason === 'defective' || request.reason === 'wrong_item';
        let awbNumber = null;
        let shipmentId = null;
        let pickupDate = null;
        let primaryCarrierFailed = false;
        let allCarriersUnserviceable = false;

        if (!isFeeWaived) {
            // Get carrier mode from settings
            const carrierMode = await getCarrierMode('pickup');
            const carrierResolution = resolveCarrier(carrierMode, null, 'pickup');
            console.log(`[${requestId}] Initiating background pickup: primary=${carrierResolution.primary}, fallback=${carrierResolution.useFallback}`);
            
            const requestData = {
                requestId,
                orderNumber: request.orderNumber,
                customerPhone: request.customerPhone,
                items: request.items
            };
            
            let carrierUsed = null;
            let fallbackReason = null;

            try {
                // Try the resolved primary carrier, then the fallback partner if enabled
                let booking = null;
                try {
                    booking = await returnBookingAttempt(carrierResolution.primary, requestData, null);
                } catch (primaryError) {
                    primaryCarrierFailed = true;
                    if (primaryError.isUnserviceable || isUnserviceableError(primaryError.message)) {
                        allCarriersUnserviceable = true;
                    } else {
                        allCarriersUnserviceable = false;
                    }
                    if (!carrierResolution.useFallback) throw primaryError;
                    const fallbackCarrier = carrierResolution.fallback || getFallbackCarrier(carrierResolution.primary);
                    fallbackReason = `${carrierResolution.primary} failed: ${primaryError.message}`;
                    console.warn(`[${requestId}] ️ ${carrierResolution.primary} failed, falling back to ${fallbackCarrier}:`, primaryError.message);
                    try {
                        booking = await returnBookingAttempt(fallbackCarrier, requestData, null);
                    } catch (fallbackError) {
                        // Both carriers failed – only unserviceable if BOTH were unserviceable
                        if (!(fallbackError.isUnserviceable || isUnserviceableError(fallbackError.message))) {
                            allCarriersUnserviceable = false;
                        }
                        throw fallbackError;
                    }
                }

                carrierUsed = booking.carrierUsed;
                awbNumber = booking.awbNumber;
                shipmentId = booking.shipmentId;
                pickupDate = booking.pickupDate;
                console.log(`[${requestId}] ✅ ${carrierUsed} success: ShipmentID ${shipmentId}, AWB ${awbNumber || 'PENDING'}`);

                // Update with success data
                if (carrierUsed) {
                    updates.status = 'pickup_booked';
                    updates.awbNumber = awbNumber;
                    updates.shipmentId = shipmentId;
                    updates.pickupDate = pickupDate;
                    updates.carrier = carrierUsed;
                    updates.carrierShipmentId = shipmentId;
                    updates.carrierAwb = awbNumber;
                    if (fallbackReason) {
                        updates.carrierFallbackReason = fallbackReason;
                    }
                    console.log(`[${requestId}] ✅ Background Auto-Pickup Success: ${shipmentId}`);
                }
            } catch (error) {
                console.error(`[${requestId}] ❌ Background pickup failed:`, error.message);
                // Keep status as 'pending' for manual admin intervention
            }
        } else if (isFeeWaived) {
            console.log(`[${requestId}] Fee-waived reason (${request.reason}): keeping pending for admin review.`);
        }

        // 3. Save to DB
        await updateRequestStatus(requestId, updates);
        console.log(`[${requestId}] ✅ Request finalized and updated in DB`);

        // 4. Send WhatsApp Notification
        if (updates.status === 'pickup_booked') {
            // Send the approval template with handover-video instructions
            sendReturnExchangeApprovalWhatsApp({
                phone: request.customerPhone,
                requestId,
                orderNumber: request.orderNumber,
                type: request.type
            }).then(waResult => {
                if (waResult?.success) {
                    updateRequestStatus(requestId, {
                        whatsappSent: true,
                        whatsappMessageId: waResult.messageId || null,
                        whatsappSentAt: new Date().toISOString()
                    }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                }
            }).catch(() => {}); // fire-and-forget

            // If primary carrier failed (but fallback succeeded), also send self-ship WhatsApp
            // NO refund — fallback carrier booked the pickup successfully
            if (primaryCarrierFailed && !isFeeWaived) {
                console.log(`[${requestId}] 📦 Primary carrier failed but fallback succeeded – sending self-ship WhatsApp (no refund) to ${request.customerPhone}`);
                resolveWarehouseAddress().then(({ address, phone: whPhone }) => {
                    return sendSelfShipRequiredWhatsApp({
                        phone: request.customerPhone,
                        requestId,
                        orderNumber: request.orderNumber,
                        type: request.type,
                        warehouseAddress: address,
                        warehousePhone: whPhone
                    });
                }).catch(err => console.warn(`[${requestId}] Self-ship WhatsApp error:`, err.message));
            }
        } else if (primaryCarrierFailed && !isFeeWaived) {
            // All carriers failed for a paid request
            const isUnserviceable = allCarriersUnserviceable;

            if (isUnserviceable) {
                // Unserviceable pincode – refund pickup fee + send self-ship WhatsApp
                if (paymentId && paymentAmount > 0) {
                    issuePickupFeeRefund(requestId, paymentId, paymentAmount).then(refundResult => {
                        if (refundResult.success) {
                            updateRequestStatus(requestId, {
                                refundId: refundResult.refundId,
                                refundStatus: refundResult.status,
                                refundAmount: paymentAmount,
                                refundedAt: new Date().toISOString()
                            }).catch(e => console.warn(`[${requestId}] Refund status update failed:`, e.message));
                        }
                    }).catch(err => console.error(`[${requestId}] Pickup fee refund error:`, err.message));
                }

                console.log(`[${requestId}] 📦 All carriers failed (unserviceable pincode) – refunding + sending self-ship WhatsApp to ${request.customerPhone}`);
                resolveWarehouseAddress().then(({ address, phone: whPhone }) => {
                    return sendSelfShipRequiredWhatsApp({
                        phone: request.customerPhone,
                        requestId,
                        orderNumber: request.orderNumber,
                        type: request.type,
                        warehouseAddress: address,
                        warehousePhone: whPhone
                    });
                }).then(waResult => {
                    if (waResult?.success) {
                        updateRequestStatus(requestId, {
                            whatsappSent: true,
                            whatsappMessageId: waResult.messageId || null,
                            whatsappSentAt: new Date().toISOString()
                        }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                    }
                }).catch(err => console.warn(`[${requestId}] Self-ship WhatsApp error:`, err.message));
            } else {
                // Non-serviceability error (e.g. insufficient balance) – no refund, no self-ship. Admin intervention needed.
                console.log(`[${requestId}] 📦 All carriers failed (non-serviceability error) – skipping refund and self-ship WhatsApp. Admin intervention needed.`);
            }
        } else {
            // Fee-waived / still pending — send generic payment confirmation
            const customerName = request.customerName || 'Customer';
            const typeLabel = request.type === 'exchange' ? 'Exchange' : 'Return';
            const message = `Payment confirmed for your ${typeLabel} Request ${requestId}. Status: ${updates.status.replace('_', ' ')}. We've recorded your request and will process it shortly.`;
            sendWhatsAppNotification(request.customerPhone, message, request.type, requestId).catch(err => console.error(err));
        }

        return { success: true, status: updates.status };
    } catch (error) {
        console.error(`[${requestId}] ❌ Finalize Error:`, error);
        return { success: false, error: error.message };
    }
}

// Submit exchange request
app.post('/api/submit-exchange', upload.any(), async (req, res) => {
    const allowExchanges = await getSetting('allow_exchanges', true);
    if (!allowExchanges) {
        return res.status(403).json({ error: 'Exchanges are currently disabled by the administrator.' });
    }

    let requestId = await generateUniqueRequestId();
    console.log(`[${requestId}] 📥 Received exchange submission`);
    console.log(`[${requestId}] Body Fields:`, Object.keys(req.body));
    console.log(`[${requestId}] Files:`, req.files ? req.files.length : 0);

    try {
        // Parse items if string
        let items = req.body.items;
        if (typeof items === 'string') {
            try {
                items = JSON.parse(items);
            } catch (e) {
                console.error(`[${requestId}] Failed to parse items:`, e);
                items = [];
            }
        }

        console.log(`[${requestId}] Order: ${req.body.orderNumber}, Items: ${items.length}, PaymentId: ${req.body.paymentId || 'None'}, Amount: ${req.body.paymentAmount || 0}`);

        // Diagnostic: log replacement data received from frontend
        if (items.length > 0) {
            console.log(`[${requestId}] 🔍 Frontend item data (first item):`, JSON.stringify({
                name: items[0].name,
                variant: items[0].variant,
                replacementProductTitle: items[0].replacementProductTitle,
                replacementVariant: items[0].replacementVariant,
                replacementVariantId: items[0].replacementVariantId,
                replacementProductId: items[0].replacementProductId
            }));
        }

        // ── One request per order guard ──────────────────────────────────────────
        const existingRequests = await getRequestsByOrderNumber(req.body.orderNumber);
        const activeExisting = existingRequests.filter(r => r.status !== 'rejected');
        let reuseRequestId = null; // Will be set if resubmitting a waiting_payment request
        if (activeExisting.length > 0) {
            if (activeExisting[0].status === 'waiting_payment') {
                reuseRequestId = activeExisting[0].requestId;
                console.log(`[${requestId}] ♻️  Reusing REQ ID ${reuseRequestId} (was waiting_payment)`);
            } else {
                console.log(`[${requestId}] ❌ Duplicate blocked — ${activeExisting[0].requestId} (${activeExisting[0].status})`);
                return res.status(400).json({
                    error: `A request (${activeExisting[0].requestId}) already exists for this order. Only one request is allowed per order.`
                });
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        // Get Cloudinary Image URLs
        const imageUrls = req.files ? req.files.map(file => file.path) : [];

        // Fetch Order for details
        let shopifyOrder = null;
        let originalAddressFormatted = '';
        let shippingCity = '';
        let shippingState = '';
        let shippingPincode = '';
        try {
            // 1. Try exact match
            let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(req.body.orderNumber)}&status=any&limit=1`);

            // 2. Fuzzy retry
            if (!shopifyData.orders || shopifyData.orders.length === 0) {
                let retryOrderNumber = req.body.orderNumber;
                if (retryOrderNumber.startsWith('#')) {
                    retryOrderNumber = retryOrderNumber.substring(1);
                } else {
                    retryOrderNumber = '#' + retryOrderNumber;
                }
                console.log(`[${requestId}] Retrying order fetch with: ${retryOrderNumber}`);
                shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(retryOrderNumber)}&status=any&limit=1`);
            }

            shopifyOrder = shopifyData.orders && shopifyData.orders[0];

            if (shopifyOrder && shopifyOrder.shipping_address) {
                const addr = shopifyOrder.shipping_address;
                originalAddressFormatted = [
                    addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country
                ].filter(Boolean).join(', ');
                
                // Also extract individual address components
                shippingCity = addr.city || '';
                shippingState = addr.province || '';
                shippingPincode = addr.zip || '';
            }
        } catch (err) {
            console.error(`[${requestId}] Failed to fetch Shopify order for submission:`, err);
        }

        // ── Delivery status safety net ──────────────────────────────────────────
        // Block exchange submission if the order is still in transit (not yet delivered).
        if (shopifyOrder && shopifyOrder.fulfillment_status === 'fulfilled' && shopifyOrder.fulfillments?.length > 0) {
            const fwdAwb = shopifyOrder.fulfillments[0].tracking_number;
            if (fwdAwb) {
                const fwdCarrier = detectCarrierForAwb(fwdAwb, null, null, null);
                let fwdStatus = null;
                try {
                    if (fwdCarrier === 'delhivery') {
                        const t = await getDelhiveryTracking(fwdAwb);
                        if (t?.shipments?.[0]) fwdStatus = (t.shipments[0].status || t.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_');
                    } else if (fwdCarrier === 'ekart') {
                        const t = await getEkartTracking(fwdAwb);
                        if (t?.shipments?.[0]) fwdStatus = (t.shipments[0].status || t.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_');
                    } else {
                        const t = await getShiprocketTracking(fwdAwb);
                        if (t) fwdStatus = (t.current_status || t.shipment_track?.[0]?.current_status || '').toLowerCase().replace(/\s+/g, '_');
                    }
                } catch (e) { console.warn(`[${requestId}] Forward tracking safety net failed:`, e.message); }
                if (fwdStatus) {
                    const stillInTransit = ['in_transit', 'out_for_delivery', 'shipped', 'picked_up', 'ready_to_ship'].includes(fwdStatus);
                    const isDelivered = fwdStatus.includes('delivered');
                    if (stillInTransit && !isDelivered) {
                        console.warn(`[${requestId}] ❌ Exchange blocked — order still in transit (status: ${fwdStatus}, carrier: ${fwdCarrier})`);
                        return res.status(400).json({
                            error: `This order has not been delivered yet (current status: ${fwdStatus.replace(/_/g, ' ')}). Please wait until delivery before filing an exchange.`
                        });
                    }
                }
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        const customerName = req.body.customerName || (shopifyOrder?.customer ? `${shopifyOrder.customer.first_name || ''} ${shopifyOrder.customer.last_name || ''}`.trim() : 'Customer');
        const customerPhone = req.body.customerPhone || shopifyOrder?.shipping_address?.phone || shopifyOrder?.customer?.phone || '';
        const email = req.body.email || shopifyOrder?.email;

        // Store the amount actually PAID by the customer (after coupon/discounts),
        // not the raw product price — the panel/refunds must reflect the paid amount
        items = enrichItemsWithPaidPrice(items, shopifyOrder);
        const codCharges = getOrderExtraCharges(shopifyOrder);

        // Verify Payment logic
        // Fee is ONLY waived for defective/wrong items (requires manual review)
        const isFeeWaived = req.body.reason === 'defective' || req.body.reason === 'wrong_item';
        let paymentVerified = false;

        if (req.body.paymentId && !isFeeWaived) {
            if (!razorpay) {
                console.error(`[${requestId}] Payment config missing`);
                return res.status(500).json({ error: 'Payment configuration missing on server' });
            }
            try {
                const payment = await razorpay.payments.fetch(req.body.paymentId);
                console.log(`[${requestId}] Razorpay Verification - PaymentId: ${req.body.paymentId}, Status: ${payment.status}, Amount: ${payment.amount / 100} ${payment.currency}`);
                if (payment.status === 'captured' || payment.status === 'authorized') {
                    paymentVerified = true;
                } else {
                    return res.status(400).json({ error: 'Payment not successful' });
                }
            } catch (payError) {
                console.error(`[${requestId}] Payment Verification Failed:`, payError);
                return res.status(400).json({ error: 'Invalid Payment ID' });
            }
        }

        const needsPayment = !isFeeWaived && !paymentVerified;

        console.log(`[${requestId}] Status Calculation: isFeeWaived=${isFeeWaived}, paymentVerified=${paymentVerified}, needsPayment=${needsPayment}`);


        // Shiprocket Return Order (Auto-Pickup) Logic:
        // - PAID reasons: auto-initiate pickup at submission
        // - FEE-WAIVED reasons (damaged/wrong_item): go to admin for review first, pickup triggered upon admin approval
        let awbNumber = null;
        let shipmentId = null;
        let pickupDate = null;
        let carrierUsed = null;
        let fallbackReason = null;
        let primaryCarrierFailed = false;
        let allCarriersUnserviceable = false;

        if (!isFeeWaived && !needsPayment) {
            // Guard: if resubmitting a waiting_payment request that already has an AWB,
            // skip duplicate Delhivery order creation and reuse the existing booking
            if (reuseRequestId && (activeExisting[0].awbNumber || activeExisting[0].carrierAwb)) {
                const existingAwb = activeExisting[0].awbNumber || activeExisting[0].carrierAwb;
                console.log(`[${requestId}] ♻️  Existing waiting_payment request already has AWB ${existingAwb}, skipping duplicate Delhivery order`);
                awbNumber = existingAwb;
                shipmentId = activeExisting[0].shipmentId || activeExisting[0].carrierShipmentId;
                carrierUsed = activeExisting[0].carrier;
                pickupDate = activeExisting[0].pickupDate;
            } else {
            // Get carrier mode from settings
            const carrierMode = await getCarrierMode('pickup');
            console.log(`[${requestId}] Auto-Pickup with carrier mode: ${carrierMode} for paid reason: ${req.body.reason}`);
            
            const requestData = {
                requestId,
                orderNumber: req.body.orderNumber,
                customerPhone: customerPhone,
                items
            };

            try {
                const resolution = resolveCarrier(carrierMode, null, 'pickup');

                // Try the resolved primary carrier, then the fallback partner if enabled
                let booking = null;
                try {
                    booking = await returnBookingAttempt(resolution.primary, requestData, shopifyOrder);
                } catch (primaryError) {
                    primaryCarrierFailed = true;
                    if (primaryError.isUnserviceable || isUnserviceableError(primaryError.message)) {
                        allCarriersUnserviceable = true;
                    } else {
                        allCarriersUnserviceable = false;
                    }
                    if (!resolution.useFallback) throw primaryError;
                    const fallbackCarrier = resolution.fallback || getFallbackCarrier(resolution.primary);
                    fallbackReason = `${resolution.primary} failed: ${primaryError.message}`;
                    console.warn(`[${requestId}] ⚠️ ${resolution.primary} failed, falling back to ${fallbackCarrier}:`, primaryError.message);
                    try {
                        booking = await returnBookingAttempt(fallbackCarrier, requestData, shopifyOrder);
                    } catch (fallbackError) {
                        if (!(fallbackError.isUnserviceable || isUnserviceableError(fallbackError.message))) {
                            allCarriersUnserviceable = false;
                        }
                        throw fallbackError;
                    }
                }

                carrierUsed = booking.carrierUsed;
                awbNumber = booking.awbNumber;
                shipmentId = booking.shipmentId;
                pickupDate = booking.pickupDate;
                console.log(`[${requestId}] ✅ ${carrierUsed} success: ShipmentID ${shipmentId}, AWB ${awbNumber || 'PENDING'}`);
            } catch (error) {
                console.error(`[${requestId}] ❌ Auto-pickup failed:`, error.message);
                // Continue without shipment - will be pending
            }
            }
        } else if (isFeeWaived) {
            console.log(`[${requestId}] Reason (${req.body.reason}) is fee-waived. Deferring pickup for manual admin review.`);
        }

        try {
            console.log(`[${requestId}] Saving Request to Database...`);
            const requestData = {
                ...req.body,
                requestId,
                email,
                customerEmail: email,
                customerName,
                customerPhone,
                items,
                codCharges,
                images: imageUrls,
                type: 'exchange',
                shippingAddress: originalAddressFormatted,
                shippingCity: shippingCity,
                shippingState: shippingState,
                shippingPincode: shippingPincode,
                awbNumber,
                shipmentId,
                pickupDate,
                paymentId: req.body.paymentId || null,
                paymentAmount: req.body.paymentAmount || 0,
                status: needsPayment ? 'waiting_payment' : (isFeeWaived ? 'pending' : ((awbNumber || shipmentId) ? 'scheduled' : 'pending')),
                carrier: carrierUsed,
                carrierShipmentId: shipmentId,
                carrierAwb: awbNumber,
                carrierFallbackReason: fallbackReason
            };

            console.log(`[${requestId}] Final Status: ${requestData.status}, AWB: ${awbNumber}`);
            if (reuseRequestId) {
                // Resubmission — update existing record, keep same REQ ID
                requestData.requestId = reuseRequestId;
                await updateRequestData(reuseRequestId, requestData);
            } else {
                await createRequest(requestData);
            }
        } catch (dbError) {
            console.error(`[${requestId}] ❌ Database Insert Failed:`, dbError.message);
            if (dbError.message.includes('column "images"')) {
                return res.status(500).json({ error: 'Database mismatch: Please add "images" column.' });
            }
            throw dbError;
        }

        // If resubmitting, use the reused REQ ID for notifications and response
        if (reuseRequestId) requestId = reuseRequestId;

        console.log(`[${requestId}] ✅ Exchange Request Submitted Successfully`);

        // If selected carrier failed for a paid request, handle refund + self-ship (only if unserviceable)
        if (!isFeeWaived && !needsPayment && primaryCarrierFailed) {
            const paymentId = req.body.paymentId || null;
            const paymentAmount = parseFloat(req.body.paymentAmount) || 0;

            if (allCarriersUnserviceable) {
                // Unserviceable pincode – refund pickup fee + send self-ship WhatsApp
                if (!awbNumber && !shipmentId && paymentId && paymentAmount > 0) {
                    console.log(`[${requestId}] 💰 Unserviceable – issuing ₹${paymentAmount} refund for payment ${paymentId}`);
                    issuePickupFeeRefund(requestId, paymentId, paymentAmount).then(refundResult => {
                        if (refundResult.success) {
                            updateRequestStatus(requestId, {
                                refundId: refundResult.refundId,
                                refundStatus: refundResult.status,
                                refundAmount: paymentAmount,
                                refundedAt: new Date().toISOString()
                            }).catch(e => console.warn(`[${requestId}] Refund status update failed:`, e.message));
                        }
                    }).catch(err => console.error(`[${requestId}] Pickup fee refund error:`, err.message));
                } else if (awbNumber || shipmentId) {
                    console.log(`[${requestId}] ℹ️ Fallback carrier succeeded (AWB: ${awbNumber}) – skipping refund`);
                }

                console.log(`[${requestId}] 📦 All carriers failed (unserviceable pincode) – sending self-ship WhatsApp to ${customerPhone}`);
                resolveWarehouseAddress().then(({ address, phone: whPhone }) => {
                    return sendSelfShipRequiredWhatsApp({
                        phone: customerPhone,
                        requestId,
                        orderNumber: req.body.orderNumber,
                        type: 'exchange',
                        warehouseAddress: address,
                        warehousePhone: whPhone
                    });
                }).then(waResult => {
                    if (waResult?.success) {
                        updateRequestStatus(requestId, {
                            whatsappSent: true,
                            whatsappMessageId: waResult.messageId || null,
                            whatsappSentAt: new Date().toISOString()
                        }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                    }
                }).catch(err => console.warn(`[${requestId}] Self-ship WhatsApp error:`, err.message));
            } else {
                // Non-serviceability error – no refund, no self-ship. Admin intervention needed.
                console.log(`[${requestId}] 📦 Carrier failed (non-serviceability error) – skipping refund and self-ship WhatsApp. Admin intervention needed.`);
            }
        }

        res.json({
            success: true,
            requestId,
            message: 'Exchange request submitted successfully'
        });
    } catch (error) {
        console.error(`[${requestId}] ❌ Submit exchange error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Submit return request
app.post('/api/submit-return', upload.any(), async (req, res) => {
    const allowReturns = await getSetting('allow_returns', true);
    if (!allowReturns) {
        return res.status(403).json({ error: 'Returns are currently disabled by the administrator.' });
    }

    let requestId = await generateUniqueRequestId();
    console.log(`[${requestId}] 📥 Received return submission`);
    console.log(`[${requestId}] Body Fields:`, Object.keys(req.body));
    console.log(`[${requestId}] Files:`, req.files ? req.files.length : 0);

    try {
        // Parse items if string
        let items = req.body.items;
        if (typeof items === 'string') {
            try {
                items = JSON.parse(items);
            } catch (e) {
                console.error('Failed to parse items:', e);
                items = [];
            }
        }

        // ── One request per order guard ──────────────────────────────────────────
        const existingRequests = await getRequestsByOrderNumber(req.body.orderNumber);
        const activeExisting = existingRequests.filter(r => r.status !== 'rejected');
        let reuseRequestId = null; // Will be set if resubmitting a waiting_payment request
        if (activeExisting.length > 0) {
            if (activeExisting[0].status === 'waiting_payment') {
                // Reuse same REQ ID — update existing record instead of creating new
                reuseRequestId = activeExisting[0].requestId;
                console.log(`[${requestId}] ♻️  Reusing REQ ID ${reuseRequestId} (was waiting_payment)`);
            } else {
                console.log(`[${requestId}] ❌ Duplicate blocked — existing request ${activeExisting[0].requestId} for order ${req.body.orderNumber}`);
                return res.status(400).json({
                    error: `A return/exchange request (${activeExisting[0].requestId}) already exists for this order. Only one request is allowed per order.`
                });
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        const imageUrls = req.files ? req.files.map(file => file.path) : [];

        // Fetch Order for details
        let shopifyOrder = null;
        let originalAddressFormatted = '';
        try {
            // 1. Try exact match
            let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(req.body.orderNumber)}&status=any&limit=1`);

            // 2. Fuzzy retry
            if (!shopifyData.orders || shopifyData.orders.length === 0) {
                let retryOrderNumber = req.body.orderNumber;
                if (retryOrderNumber.startsWith('#')) {
                    retryOrderNumber = retryOrderNumber.substring(1);
                } else {
                    retryOrderNumber = '#' + retryOrderNumber;
                }
                console.log(`[${requestId}] Retrying order fetch with: ${retryOrderNumber}`);
                shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(retryOrderNumber)}&status=any&limit=1`);
            }

            shopifyOrder = shopifyData.orders && shopifyData.orders[0];

            if (shopifyOrder && shopifyOrder.shipping_address) {
                const addr = shopifyOrder.shipping_address;
                originalAddressFormatted = [
                    addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country
                ].filter(Boolean).join(', ');
                
                // Also extract individual address components
                shippingCity = addr.city || '';
                shippingState = addr.province || '';
                shippingPincode = addr.zip || '';
            }
        } catch (err) {
            console.error('Failed to fetch Shopify order for submission:', err);
        }

        // ── Delivery status safety net ──────────────────────────────────────────
        // Block return submission if the order is still in transit (not yet delivered).
        // This prevents returns filed before the customer actually receives the package.
        if (shopifyOrder && shopifyOrder.fulfillment_status === 'fulfilled' && shopifyOrder.fulfillments?.length > 0) {
            const fwdAwb = shopifyOrder.fulfillments[0].tracking_number;
            if (fwdAwb) {
                const fwdCarrier = detectCarrierForAwb(fwdAwb, null, null, null);
                let fwdStatus = null;
                try {
                    if (fwdCarrier === 'delhivery') {
                        const t = await getDelhiveryTracking(fwdAwb);
                        if (t?.shipments?.[0]) fwdStatus = (t.shipments[0].status || t.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_');
                    } else if (fwdCarrier === 'ekart') {
                        const t = await getEkartTracking(fwdAwb);
                        if (t?.shipments?.[0]) fwdStatus = (t.shipments[0].status || t.shipments[0].status_type || '').toLowerCase().replace(/\s+/g, '_');
                    } else {
                        const t = await getShiprocketTracking(fwdAwb);
                        if (t) fwdStatus = (t.current_status || t.shipment_track?.[0]?.current_status || '').toLowerCase().replace(/\s+/g, '_');
                    }
                } catch (e) { console.warn(`[${requestId}] Forward tracking safety net failed:`, e.message); }
                if (fwdStatus) {
                    const stillInTransit = ['in_transit', 'out_for_delivery', 'shipped', 'picked_up', 'ready_to_ship'].includes(fwdStatus);
                    const isDelivered = fwdStatus.includes('delivered');
                    if (stillInTransit && !isDelivered) {
                        console.warn(`[${requestId}] ❌ Return blocked — order still in transit (status: ${fwdStatus}, carrier: ${fwdCarrier})`);
                        return res.status(400).json({
                            error: `This order has not been delivered yet (current status: ${fwdStatus.replace(/_/g, ' ')}). Please wait until delivery before filing a return.`
                        });
                    }
                }
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        const customerName = req.body.customerName || (shopifyOrder?.customer ? `${shopifyOrder.customer.first_name || ''} ${shopifyOrder.customer.last_name || ''}`.trim() : 'Customer');
        const customerPhone = req.body.customerPhone || shopifyOrder?.shipping_address?.phone || shopifyOrder?.customer?.phone || '';
        const email = req.body.email || shopifyOrder?.email;

        // Store the amount actually PAID by the customer (after coupon/discounts),
        // not the raw product price — the panel/refunds must reflect the paid amount
        items = enrichItemsWithPaidPrice(items, shopifyOrder);
        const codCharges = getOrderExtraCharges(shopifyOrder);

        // Verify Payment logic for Return
        const isFeeWaivedReturn = req.body.reason === 'defective' || req.body.reason === 'wrong_item';
        let paymentVerified = false;

        if (req.body.paymentId && !isFeeWaivedReturn) {
            if (!razorpay) return res.status(500).json({ error: 'Config error' });
            try {
                const payment = await razorpay.payments.fetch(req.body.paymentId);
                console.log(`[${requestId}] Razorpay Verification (Return) - PaymentId: ${req.body.paymentId}, Status: ${payment.status}, Amount: ${payment.amount / 100} ${payment.currency}`);
                if (payment.status === 'captured' || payment.status === 'authorized') {
                    paymentVerified = true;
                } else {
                    return res.status(400).json({ error: 'Payment failed' });
                }
            } catch (e) {
                console.error(`[${requestId}] Razorpay Verification Failed (Return):`, e.message);
                return res.status(400).json({ error: 'Invalid payment' });
            }
        }

        const needsPayment = !isFeeWaivedReturn && !paymentVerified;

        console.log(`[${requestId}] Status Calculation (Return): isFeeWaivedReturn=${isFeeWaivedReturn}, paymentVerified=${paymentVerified}, needsPayment=${needsPayment}`);

        // Shiprocket Return Order (Auto-Pickup) Logic:
        // - PAID reasons: auto-initiate pickup at submission
        // - FEE-WAIVED reasons (damaged/wrong_item): go to admin for review first, pickup triggered upon admin approval
        let awbNumber = null;
        let shipmentId = null;
        let pickupDate = null;
        let carrierUsed = null;
        let fallbackReason = null;
        let primaryCarrierFailed = false;
        let allCarriersUnserviceable = false;

        if (!isFeeWaivedReturn && !needsPayment) {
            // Guard: if resubmitting a waiting_payment request that already has an AWB,
            // skip duplicate Delhivery order creation and reuse the existing booking
            if (reuseRequestId && (activeExisting[0].awbNumber || activeExisting[0].carrierAwb)) {
                const existingAwb = activeExisting[0].awbNumber || activeExisting[0].carrierAwb;
                console.log(`[${requestId}] ♻️  Existing waiting_payment request already has AWB ${existingAwb}, skipping duplicate Delhivery order`);
                awbNumber = existingAwb;
                shipmentId = activeExisting[0].shipmentId || activeExisting[0].carrierShipmentId;
                carrierUsed = activeExisting[0].carrier;
                pickupDate = activeExisting[0].pickupDate;
            } else {
            // Get carrier mode from settings
            const carrierMode = await getCarrierMode('pickup');
            console.log(`[${requestId}] Auto-Pickup with carrier mode: ${carrierMode} for paid reason: ${req.body.reason}`);
            
            const requestData = {
                requestId,
                orderNumber: req.body.orderNumber,
                customerPhone: customerPhone,
                items
            };

            try {
                const resolution = resolveCarrier(carrierMode, null, 'pickup');

                // Try the resolved primary carrier, then the fallback partner if enabled
                let booking = null;
                try {
                    booking = await returnBookingAttempt(resolution.primary, requestData, shopifyOrder);
                } catch (primaryError) {
                    primaryCarrierFailed = true;
                    if (primaryError.isUnserviceable || isUnserviceableError(primaryError.message)) {
                        allCarriersUnserviceable = true;
                    } else {
                        allCarriersUnserviceable = false;
                    }
                    if (!resolution.useFallback) throw primaryError;
                    const fallbackCarrier = resolution.fallback || getFallbackCarrier(resolution.primary);
                    fallbackReason = `${resolution.primary} failed: ${primaryError.message}`;
                    console.warn(`[${requestId}] ⚠️ ${resolution.primary} failed, falling back to ${fallbackCarrier}:`, primaryError.message);
                    try {
                        booking = await returnBookingAttempt(fallbackCarrier, requestData, shopifyOrder);
                    } catch (fallbackError) {
                        if (!(fallbackError.isUnserviceable || isUnserviceableError(fallbackError.message))) {
                            allCarriersUnserviceable = false;
                        }
                        throw fallbackError;
                    }
                }

                carrierUsed = booking.carrierUsed;
                awbNumber = booking.awbNumber;
                shipmentId = booking.shipmentId;
                pickupDate = booking.pickupDate;
                console.log(`[${requestId}] ✅ ${carrierUsed} success: ShipmentID ${shipmentId}, AWB ${awbNumber || 'PENDING'}`);
            } catch (error) {
                console.error(`[${requestId}] ❌ Auto-pickup failed:`, error.message);
                // Continue without shipment - will be pending
            }
            }
        } else if (isFeeWaivedReturn) {
            console.log(`[${requestId}] Reason (${req.body.reason}) is fee-waived. Deferring pickup for manual admin review.`);
        }

        try {
            console.log(`[${requestId}] Saving Request to Database...`);
            const requestData = {
                ...req.body,
                requestId,
                email,
                customerEmail: email,
                customerName,
                customerPhone,
                items,
                codCharges,
                images: imageUrls,
                type: 'return',
                shippingAddress: originalAddressFormatted,
                shippingCity: shippingCity,
                shippingState: shippingState,
                shippingPincode: shippingPincode,
                awbNumber,
                shipmentId,
                pickupDate,
                paymentId: req.body.paymentId || null,
                paymentAmount: req.body.paymentAmount || 0,
                status: needsPayment ? 'waiting_payment' : (isFeeWaivedReturn ? 'pending' : ((awbNumber || shipmentId) ? 'scheduled' : 'pending')),
                carrier: carrierUsed,
                carrierShipmentId: shipmentId,
                carrierAwb: awbNumber,
                carrierFallbackReason: fallbackReason
            };

            console.log(`[${requestId}] Final Status (Return): ${requestData.status}, AWB: ${awbNumber}`);
            if (reuseRequestId) {
                // Resubmission — update existing record, keep same REQ ID
                requestData.requestId = reuseRequestId;
                await updateRequestData(reuseRequestId, requestData);
            } else {
                await createRequest(requestData);
            }
        } catch (dbError) {
            console.error(`[${requestId}] ❌ Database Insert Failed:`, dbError.message);
            if (dbError.message.includes('column "images"')) {
                return res.status(500).json({ error: 'Database mismatch: Please add "images" column.' });
            }
            throw dbError;
        }

        // If resubmitting, use the reused REQ ID for notifications and response
        if (reuseRequestId) requestId = reuseRequestId;

        console.log(`[${requestId}] ✅ Return Request Submitted Successfully`);

        // If selected carrier failed for a paid request, handle refund + self-ship (only if unserviceable)
        if (!isFeeWaivedReturn && !needsPayment && primaryCarrierFailed) {
            const paymentId = req.body.paymentId || null;
            const paymentAmount = parseFloat(req.body.paymentAmount) || 0;

            if (allCarriersUnserviceable) {
                // Unserviceable pincode – refund pickup fee + send self-ship WhatsApp
                if (!awbNumber && !shipmentId && paymentId && paymentAmount > 0) {
                    console.log(`[${requestId}] 💰 Unserviceable – issuing ₹${paymentAmount} refund for payment ${paymentId}`);
                    issuePickupFeeRefund(requestId, paymentId, paymentAmount).then(refundResult => {
                        if (refundResult.success) {
                            updateRequestStatus(requestId, {
                                refundId: refundResult.refundId,
                                refundStatus: refundResult.status,
                                refundAmount: paymentAmount,
                                refundedAt: new Date().toISOString()
                            }).catch(e => console.warn(`[${requestId}] Refund status update failed:`, e.message));
                        }
                    }).catch(err => console.error(`[${requestId}] Pickup fee refund error:`, err.message));
                } else if (awbNumber || shipmentId) {
                    console.log(`[${requestId}] ℹ️ Fallback carrier succeeded (AWB: ${awbNumber}) – skipping refund`);
                }

                console.log(`[${requestId}] 📦 All carriers failed (unserviceable pincode) – sending self-ship WhatsApp to ${customerPhone}`);
                resolveWarehouseAddress().then(({ address, phone: whPhone }) => {
                    return sendSelfShipRequiredWhatsApp({
                        phone: customerPhone,
                        requestId,
                        orderNumber: req.body.orderNumber,
                        type: 'return',
                        warehouseAddress: address,
                        warehousePhone: whPhone
                    });
                }).then(waResult => {
                    if (waResult?.success) {
                        updateRequestStatus(requestId, {
                            whatsappSent: true,
                            whatsappMessageId: waResult.messageId || null,
                            whatsappSentAt: new Date().toISOString()
                        }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                    }
                }).catch(err => console.warn(`[${requestId}] Self-ship WhatsApp error:`, err.message));
            } else {
                // Non-serviceability error – no refund, no self-ship. Admin intervention needed.
                console.log(`[${requestId}] 📦 Carrier failed (non-serviceability error) – skipping refund and self-ship WhatsApp. Admin intervention needed.`);
            }
        }

        res.json({
            success: true,
            requestId,
            message: 'Return request submitted successfully'
        });
    } catch (error) {
        console.error('Submit return error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Track request (Return/Exchange) — accepts REQ ID or Order Number
app.get('/api/track-request/:identifier', async (req, res) => {
    const { identifier } = req.params;

    // Helper to build complete workflow history from status timestamps
    function buildWorkflowHistory(request) {
        const workflow = [];
        
        // Define all possible workflow states with labels
        const states = [
            { key: 'created_at', label: 'Request Created', icon: '' },
            { key: 'waiting_payment', label: 'Waiting Payment', icon: '' },
            { key: 'payment_received', label: 'Payment Received', icon: '✅' },
            { key: 'pending_admin', label: 'Pending Admin Review', icon: '👤' },
            { key: 'pickup_booked', label: 'Pickup Booked', icon: '📦' },
            { key: 'picked_up_at', label: 'Picked Up', icon: '' },
            { key: 'in_transit_at', label: 'In Transit', icon: '🛣️' },
            { key: 'out_for_delivery_at', label: 'Out For Delivery', icon: '🚚' },
            { key: 'delivered_at', label: 'Delivered', icon: '✅' },
            { key: 'inspected_at', label: 'Inspected', icon: '🔍' },
            { key: 'approved_at', label: 'Approved', icon: '✓' },
            { key: 'rejected_at', label: 'Rejected', icon: '✗' }
        ];
        
        // Get the current status to determine which states are active
        const currentStatus = (request.status || '').toLowerCase();
        
        // Build status order for returns/exchanges
        const statusOrder = [
            'waiting_payment',
            'pending',
            'pickup_booked',
            'scheduled',
            'picked_up',
            'in_transit',
            'out_for_delivery',
            'delivered',
            'delivered (pending insp.)',
            'inspected',
            'approved',
            'rejected'
        ];
        
        const currentIndex = statusOrder.indexOf(currentStatus);
        
        states.forEach(state => {
            const timestamp = request[state.key];
            if (timestamp) {
                // Determine if this state is completed, active, or future
                let statusClass = 'completed';
                
                // Check if this matches current status
                if (state.key === 'created_at' && currentIndex === 0) {
                    statusClass = 'active';
                } else if (state.key.replace('_at', '') === currentStatus || 
                          state.key === currentStatus) {
                    statusClass = 'active';
                }
                
                workflow.push({
                    label: state.label,
                    icon: state.icon,
                    date: new Date(timestamp).toISOString(),
                    status: statusClass,
                    completed: true
                });
            }
        });
        
        // Sort by date
        workflow.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        return workflow;
    }

    // Normalize carrier tracking activities into a unified { status, location, date } shape
    // so the frontend checkpoint renderer works identically for Delhivery, Shiprocket, and Ekart.
    //
    // Delhivery ScanDetail : { Scan, ScannedLocation, ScanDateTime, ScanType, StatusCode, StatusDateTime, Instructions }
    // Shiprocket track item  : { 'sr-status-label', activity, location, date }
    // Ekart event            : { status, desc, location, datetime }
    function normalizeActivities(raw, carrier) {
        if (!Array.isArray(raw) || raw.length === 0) return [];
        
        return raw.map(act => {
            // Status / label - try all possible field names
            const status =
                act['sr-status-label'] ||
                act.Scan ||
                act.scan ||
                act.scan_type ||
                act.status ||
                act.Status ||
                act.desc ||
                act.description ||
                act.activity ||
                act.event ||
                'Update';
            
            // Location - try all possible field names (Delhivery uses ScannedLocation)
            const location =
                act.ScannedLocation ||
                act.Location ||
                act.location ||
                act.ScanLocation ||
                act.scan_location ||
                act.loc ||
                act.city ||
                act.place ||
                act.warehouse ||
                'Hub';
            
            // Date — try all possible field names and formats (Delhivery uses ScanDateTime)
            const rawDate = 
                act.ScanDateTime ||
                act.StatusDateTime ||
                act.Date || 
                act.date || 
                act.datetime || 
                act.dateTime ||
                act.scan_date || 
                act.scan_date_time ||
                act.timestamp ||
                act.time ||
                act.created_at ||
                null;
            
            let date = rawDate;
            if (rawDate && typeof rawDate === 'string') {
                if (rawDate.includes('T')) {
                    // ISO string — convert to "YYYY-MM-DD HH:MM" for the frontend splitter
                    const d = new Date(rawDate);
                    if (!isNaN(d.getTime())) {
                        const pad = n => String(n).padStart(2, '0');
                        date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    }
                } else if (rawDate.includes(' ')) {
                    // Already in "YYYY-MM-DD HH:MM:SS" format - keep as is
                    date = rawDate;
                } else if (!isNaN(Date.parse(rawDate))) {
                    // Try parsing as date
                    const d = new Date(rawDate);
                    if (!isNaN(d.getTime())) {
                        const pad = n => String(n).padStart(2, '0');
                        date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    }
                }
            } else if (rawDate && typeof rawDate === 'number') {
                // Unix timestamp
                const d = new Date(rawDate);
                if (!isNaN(d.getTime())) {
                    const pad = n => String(n).padStart(2, '0');
                    date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                }
            }
            
            return { status, location, date };
        });
    }

    // Helper to enrich a request with live tracking data (supports both Shiprocket and Delhivery)
    // Also persists EDD and status updates to DB so data is always fresh
    async function enrichWithTracking(request) {
        // Build complete workflow history from timestamps
        request.workflowHistory = buildWorkflowHistory(request);
        
        // Track what needs persisting (fire-and-forget after response)
        const persistUpdates = {};
        
        // Return shipment tracking
        if (request.awbNumber) {
            const returnCarrier = detectCarrier(request);
            try {
                // Route to the correct carrier using unified detection
                if (returnCarrier === 'delhivery') {
                    // Try Delhivery tracking
                    const trackingData = await getDelhiveryTracking(request.awbNumber);
                    if (trackingData && trackingData.shipments && trackingData.shipments.length > 0) {
                        const shipment = trackingData.shipments[0];
                        const edd = shipment.eta || null;
                        const carrierStatus = shipment.status || shipment.delivered_status;
                        const statusType = shipment.status_type || null;
                        request.shipment = {
                            origin: trackingData.pickup_location?.name || null,
                            destination: trackingData.return_address?.name || null,
                            status: carrierStatus || 'Pending',
                            edd: edd,
                            activities: normalizeActivities(shipment.tracking_data || [], 'delhivery'),
                            carrier: 'delhivery'
                        };
                        // Queue EDD + carrier name for persistence
                        if (edd) persistUpdates.expectedDeliveryDate = edd;
                        persistUpdates.carrierName = 'Delhivery';
                        // Check if status should advance
                        if (carrierStatus) {
                            const mapping = mapCarrierStatus(carrierStatus, 'delhivery', statusType);
                            if (mapping && mapping.shouldUpdate && mapping.status && mapping.status !== request.status && isForwardProgress(request.status, mapping.status)) {
                                persistUpdates.status = mapping.status;
                                if (mapping.status === 'picked_up') persistUpdates.pickedUpAt = new Date().toISOString();
                                if (mapping.status === 'in_transit') persistUpdates.inTransitAt = new Date().toISOString();
                                if (mapping.status === 'out_for_delivery') persistUpdates.outForDeliveryAt = new Date().toISOString();
                                if (mapping.status === 'delivered') persistUpdates.deliveredAt = new Date().toISOString();
                            }
                        }
                    }
                } else {
                    // Try Shiprocket tracking
                    const trackingData = await shiprocketAPI(`/courier/track/awb/${request.awbNumber}`);
                    if (trackingData && trackingData.tracking_data) {
                        const tracking = trackingData.tracking_data;
                        const edd = tracking.edd || tracking.etd || null;
                        const carrierStatus = tracking.current_status;
                        request.shipment = {
                            origin: tracking.shipment_track?.[0]?.origin || tracking.origin || null,
                            destination: tracking.shipment_track?.[0]?.destination || tracking.destination || null,
                            status: carrierStatus || 'Pending',
                            edd: edd,
                            activities: normalizeActivities(tracking.shipment_track || [], 'shiprocket'),
                            carrier: 'shiprocket'
                        };
                        if (edd) persistUpdates.expectedDeliveryDate = edd;
                        persistUpdates.carrierName = 'Shiprocket';
                        if (carrierStatus) {
                            const mapping = mapCarrierStatus(carrierStatus, 'shiprocket');
                            if (mapping && mapping.shouldUpdate && mapping.status && mapping.status !== request.status && isForwardProgress(request.status, mapping.status)) {
                                persistUpdates.status = mapping.status;
                                if (mapping.status === 'picked_up') persistUpdates.pickedUpAt = new Date().toISOString();
                                if (mapping.status === 'in_transit') persistUpdates.inTransitAt = new Date().toISOString();
                                if (mapping.status === 'out_for_delivery') persistUpdates.outForDeliveryAt = new Date().toISOString();
                                if (mapping.status === 'delivered') persistUpdates.deliveredAt = new Date().toISOString();
                            }
                        }
                    }
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('cancelled') || err.message.toLowerCase().includes('canceled')) {
                    console.log(`[Tracking API] Return Shipment (${request.awbNumber}) is cancelled.`);
                    request.shipment = { status: 'Cancelled', edd: null, activities: [], carrier: returnCarrier || 'unknown' };
                } else {
                    console.error(`[Tracking API] Return Shipment (${request.awbNumber}) failed:`, err.message);
                }
            }
        }
        
        // Forward shipment tracking (for exchanges) - carrier-aware
        if (request.forwardAwbNumber) {
            const forwardCarrier = detectCarrierForAwb(
                request.forwardAwbNumber,
                request.forwardShipmentId,
                request.forwardCarrier,
                request.carrierFallbackReason
            );
            try {
                if (forwardCarrier === 'delhivery') {
                    const trackingData = await getDelhiveryTracking(request.forwardAwbNumber);
                    if (trackingData && trackingData.shipments && trackingData.shipments.length > 0) {
                        const shipment = trackingData.shipments[0];
                        const activities = normalizeActivities(shipment.tracking_data || shipment.scans || [], 'delhivery');
                        const fwdEdd = shipment.eta || null;
                        const fwdStatus = shipment.status || shipment.delivered_status;
                        const fwdStatusType = shipment.status_type || null;
                        request.forwardShipment = {
                            awb: request.forwardAwbNumber,
                            status: fwdStatus || 'Scheduled',
                            edd: fwdEdd,
                            activities: activities,
                            courierName: 'Delhivery',
                            deliveredDate: shipment.delivered_date || null,
                            deliveredTo: null,
                            trackUrl: null,
                            origin: trackingData.pickup_location?.name || null,
                            destination: trackingData.return_address?.name || shipment.destination || null,
                            pickupDate: shipment.pickup_date || null,
                            packageCount: trackingData.shipments.length || null,
                            carrier: 'delhivery'
                        };
                        if (fwdEdd) persistUpdates.forwardExpectedDeliveryDate = fwdEdd;
                        persistUpdates.forwardCarrierName = 'Delhivery';
                        // Check forward status advancement
                        if (fwdStatus && request.forwardStatus !== 'delivered') {
                            const fwdMapping = mapCarrierStatus(fwdStatus, 'delhivery', fwdStatusType);
                            if (fwdMapping && fwdMapping.shouldUpdate && fwdMapping.status && fwdMapping.status !== request.forwardStatus && isForwardProgress(request.forwardStatus || 'scheduled', fwdMapping.status)) {
                                persistUpdates.forwardStatus = fwdMapping.status;
                            }
                        }
                    }
                } else if (process.env.SHIPROCKET_EMAIL) {
                    const trackingData = await shiprocketAPI(`/courier/track/awb/${request.forwardAwbNumber}`);
                    if (trackingData && trackingData.tracking_data) {
                        const tracking = trackingData.tracking_data;
                        const activities = normalizeActivities(tracking.shipment_track || [], 'shiprocket');
                        const fwdEdd = tracking.edd || tracking.etd || null;
                        const fwdStatus = tracking.current_status;
                        
                        // DEBUG: Log first activity structure to understand Shiprocket response
                        if (activities.length > 0) {
                            console.log(`[DEBUG] Forward Shipment (${request.forwardAwbNumber}) - First activity:`, JSON.stringify(activities[0], null, 2));
                        }
                        
                        request.forwardShipment = {
                            awb: request.forwardAwbNumber,
                            status: fwdStatus || 'Scheduled',
                            edd: fwdEdd,
                            activities: activities,
                            courierName: tracking.courier_name || null,
                            deliveredDate: tracking.delivered_date || null,
                            deliveredTo: tracking.delivered_to || null,
                            trackUrl: tracking.track_url || null,
                            origin: tracking.shipment_track?.[0]?.origin || tracking.origin || null,
                            destination: tracking.shipment_track?.[0]?.destination || tracking.destination || null,
                            pickupDate: activities.length > 0 ? activities[activities.length - 1].date : null,
                            packageCount: tracking.packages ? tracking.packages.length : null,
                            carrier: 'shiprocket'
                        };
                        if (fwdEdd) persistUpdates.forwardExpectedDeliveryDate = fwdEdd;
                        persistUpdates.forwardCarrierName = tracking.courier_name || 'Shiprocket';
                        if (fwdStatus && request.forwardStatus !== 'delivered') {
                            const fwdMapping = mapCarrierStatus(fwdStatus, 'shiprocket');
                            if (fwdMapping && fwdMapping.shouldUpdate && fwdMapping.status && fwdMapping.status !== request.forwardStatus && isForwardProgress(request.forwardStatus || 'scheduled', fwdMapping.status)) {
                                persistUpdates.forwardStatus = fwdMapping.status;
                            }
                        }
                    }
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('cancelled') || err.message.toLowerCase().includes('canceled')) {
                    console.log(`[Tracking API] Forward Shipment (${request.forwardAwbNumber}) is cancelled.`);
                    request.forwardShipment = { awb: request.forwardAwbNumber, status: 'Cancelled', edd: null, activities: [], carrier: forwardCarrier };
                } else {
                    console.error(`[Tracking API] Forward Shipment (${request.forwardAwbNumber}) failed:`, err.message);
                }
            }
        }
        
        // Persist any updates to DB (fire-and-forget, don't block response)
        if (Object.keys(persistUpdates).length > 0) {
            persistUpdates.lastSyncedAt = new Date().toISOString();
            updateRequestStatus(request.requestId, persistUpdates)
                .then(() => console.log(`[Track-View Sync] ${request.requestId} persisted:`, Object.keys(persistUpdates).join(', ')))
                .catch(e => console.warn(`[Track-View Sync] ${request.requestId} persist failed:`, e.message));
        }
        
        return request;
    }

    // Helper: fetch shipping address from Shopify when missing in DB
    async function backfillShippingAddress(request) {
        const needsAddress = !request.shippingAddress;
        const needsPhone = !request.customerPhone;
        const needsName = !request.customerName || request.customerName === 'Customer' || request.customerName === 'null';
        if (!needsAddress && !needsPhone && !needsName) return; // nothing to backfill
        if (!request.orderNumber) return;

        try {
            const bare = String(request.orderNumber).replace(/^#/, '');
            const shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(bare)}&status=any&limit=1`);
            const order = shopifyData?.orders?.[0];
            if (!order) return;

            const addr = order.shipping_address || (order.fulfillments?.[0]?.destination);
            const customer = order.customer || {};

            const updates = {};

            if (needsAddress && addr) {
                request.shippingAddress = [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country]
                    .filter(Boolean).join(', ');
                request.shippingCity = addr.city || '';
                request.shippingState = addr.province || '';
                request.shippingPincode = addr.zip || '';
                updates.shippingAddress = request.shippingAddress;
                updates.shippingCity = request.shippingCity;
                updates.shippingState = request.shippingState;
                updates.shippingPincode = request.shippingPincode;
                console.log(`[Backfill Address] ${request.requestId} — fetched from Shopify:`, request.shippingAddress);
            }

            if (needsPhone) {
                const phone = addr?.phone || customer?.phone || customer?.default_address?.phone || null;
                if (phone) {
                    request.customerPhone = phone;
                    updates.customerPhone = phone;
                    console.log(`[Backfill Phone] ${request.requestId} — fetched from Shopify:`, phone);
                }
            }

            if (needsName && customer) {
                const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
                if (name) {
                    request.customerName = name;
                    updates.customerName = name;
                    console.log(`[Backfill Name] ${request.requestId} — fetched from Shopify:`, name);
                }
            }

            // Persist back to DB so we don't hit Shopify again
            if (Object.keys(updates).length > 0) {
                updateRequestStatus(request.requestId, updates)
                    .catch(e => console.warn(`[Backfill] Persist failed for ${request.requestId}:`, e.message));
            }
        } catch (err) {
            console.warn(`[Backfill] ${request.requestId} — Shopify fetch failed:`, err.message);
        }
    }

    try {
        // Detect: REQ IDs always start with 'REQ-'; everything else treated as an order number
        const isReqId = identifier.toUpperCase().startsWith('REQ-');

        console.log(`[Track Request] identifier=${identifier}, isReqId=${isReqId}`);

        if (isReqId) {
            // --- Normal path: single request by REQ ID ---
            const request = await getRequestById(identifier);
            if (!request) return res.status(404).json({ error: 'Request not found' });
            
            console.log(`[Track Request] DB status for ${identifier}:`, request.status);
            
            await ensurePaidPrices(request);
            await backfillShippingAddress(request);
            await enrichWithTracking(request);
            console.log(`[Track Request] After enrichment, status:`, request.status);
            return res.json(request);
        } else {
            // --- Order number path: may return multiple requests ---
            const requests = await getRequestsByOrderNumber(identifier);
            if (!requests || requests.length === 0) {
                return res.status(404).json({ error: 'No return or exchange request found for this order number' });
            }
            // Backfill paid prices + shipping address (legacy requests), then enrich with live tracking data
            const enriched = await Promise.all(requests.map(async r => {
                await ensurePaidPrices(r);
                await backfillShippingAddress(r);
                return enrichWithTracking(r);
            }));
            // If exactly one, return as single object (keeps frontend backward compatible)
            if (enriched.length === 1) return res.json(enriched[0]);
            // Multiple: return as array under 'requests' key
            return res.json({ multiple: true, requests: enriched });
        }
    } catch (error) {
        console.error(`[Tracking Error] [${identifier}]:`, error);
        res.status(500).json({
            error: 'Failed to track request',
            details: error.message
        });
    }
});

// Track order (IMPROVED with Shiprocket integration)
app.post('/api/track-order', async (req, res) => {
    try {
        const { orderNumber, email } = req.body;

        if (!orderNumber || !email) {
            return res.status(400).json({ error: 'Order number and email are required' });
        }

        console.log('Tracking order:', orderNumber, 'for email:', email);

        // Get order from Shopify
        let shopifyData;
        try {
            // 1. Try exact match
            shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderNumber)}&status=any&limit=5`);

            // 2. If no result, try adding/removing '#'
            if (!shopifyData.orders || shopifyData.orders.length === 0) {
                let retryOrderNumber = orderNumber;
                if (orderNumber.startsWith('#')) {
                    retryOrderNumber = orderNumber.substring(1);
                } else {
                    retryOrderNumber = '#' + orderNumber;
                }

                console.log(`Retrying tracking lookup with: ${retryOrderNumber}`);
                shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(retryOrderNumber)}&status=any&limit=5`);
            }
        } catch (apiError) {
            // Handle 404 gracefully - order simply doesn't exist
            if (apiError.message.includes('404')) {
                console.log(`Order ${orderNumber} not found in Shopify`);
                return res.status(404).json({ error: 'Order not found' });
            }
            console.error('Shopify API Error:', apiError.message);
            return res.status(500).json({ error: 'Failed to fetch order from Shopify' });
        }

        if (!shopifyData.orders || shopifyData.orders.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Find matching order by email OR phone
        const normalizedInput = email ? email.toLowerCase().trim() : '';
        const inputDigits = normalizedInput.replace(/\D/g, '');

        const order = shopifyData.orders.find(o => {
            const customerEmail = o.customer?.email?.toLowerCase() || '';
            const customerPhone = o.customer?.phone?.replace(/\D/g, '') || '';
            const shippingPhone = o.shipping_address?.phone?.replace(/\D/g, '') || '';

            // Check Email
            if (customerEmail && customerEmail === normalizedInput) return true;

            // Check Phone (loose match for last 10 digits)
            if (inputDigits.length >= 10) {
                if (customerPhone.endsWith(inputDigits.slice(-10))) return true;
                if (shippingPhone.endsWith(inputDigits.slice(-10))) return true;
            }
            return false;
        });

        if (!order) {
            return res.status(404).json({ error: 'Order not found with this email/phone' });
        }

        // Check if order has fulfillments
        const fulfillments = order.fulfillments || [];

        if (fulfillments.length === 0) {
            return res.json({
                status: 'pending_shipment',
                message: 'Your order is being processed and will be shipped soon.',
                orderNumber: order.name,
                customerName: order.customer
                    ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
                    : 'Customer',
                orderDate: order.created_at,
                totalAmount: order.total_price
            });
        }

        // Get tracking info from first fulfillment
        const fulfillment = fulfillments[0];
        const trackingNumber = fulfillment.tracking_number;
        const trackingUrl = fulfillment.tracking_url;

        // Fetch product images
        const productIds = [...new Set(order.line_items.map(item => item.product_id).filter(id => id))];
        const productImages = {};

        if (productIds.length > 0) {
            try {
                const productsData = await shopifyAPI(`products.json?ids=${productIds.join(',')}&fields=id,image,images`);
                if (productsData.products) {
                    productsData.products.forEach(p => {
                        if (p.image) {
                            productImages[p.id] = p.image.src;
                        } else if (p.images && p.images.length > 0) {
                            productImages[p.id] = p.images[0].src;
                        }
                    });
                }
            } catch (err) {
                console.error('Failed to fetch product images for tracking:', err);
            }
        }

        // Prepare basic response
        const response = {
            orderNumber: order.name,
            customerName: order.customer
                ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
                : 'Customer',
            orderDate: order.created_at,
            totalAmount: order.total_price,
            currentStatus: fulfillment.shipment_status || 'Shipped',
            awbNumber: trackingNumber || 'N/A',
            courierName: fulfillment.tracking_company || 'N/A',
            trackingUrl: trackingUrl || null,
            estimatedDelivery: null,
            items: order.line_items.map(item => ({
                name: item.name,
                variant: item.variant_title || 'Default',
                quantity: item.quantity,
                price: item.price,
                image: productImages[item.product_id] || item.properties?.image || 'https://via.placeholder.com/200'
            })),
            activities: [],
            shipment: null
        };

        // Try to get detailed tracking from Shiprocket if AWB exists
        if (trackingNumber && process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD) {
            try {
                // Wrap in additional try/catch specifically for the API call to ensure we log the AWB
                const trackingData = await shiprocketAPI(`/courier/track/awb/${trackingNumber}`);
                console.log(`Shiprocket Tracking for ${trackingNumber}:`, trackingData?.tracking_data ? 'Success' : 'No Data');

                if (trackingData && trackingData.tracking_data) {
                    const tracking = trackingData.tracking_data;

                    // Update response with Shiprocket data
                    response.currentStatus = tracking.current_status || response.currentStatus;
                    response.courierName = tracking.courier_name || response.courierName;
                    response.estimatedDelivery = tracking.etd || tracking.edd || null; // Fix: Shiprocket returns 'etd'

                    // Add shipment details
                    response.shipment = {
                        origin: tracking.shipment_track?.[0]?.origin || tracking.origin || null,
                        destination: tracking.shipment_track?.[0]?.destination || tracking.destination || null,
                        weight: tracking.weight || null,
                        packages: tracking.packages || null,
                        deliveredDate: tracking.delivered_date || null,
                        deliveredTo: tracking.delivered_to || null
                    };

                    // Add tracking activities
                    if (tracking.shipment_track && Array.isArray(tracking.shipment_track)) {
                        response.activities = tracking.shipment_track.map(activity => ({
                            status: activity['sr-status-label'] || activity.status,
                            activity: activity.activity || activity['sr-status-label'],
                            date: activity.date,
                            location: activity.location || null
                        }));
                    }

                    // Check if delivered
                    response.isDelivered = tracking.current_status?.toLowerCase().includes('delivered') || false;

                    // Add message for old/delivered orders
                    const orderDate = new Date(order.created_at);
                    const daysSinceOrder = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);
                    response.isOldOrder = daysSinceOrder > 60;

                    if (response.isDelivered) {
                        response.message = '✅ Your order has been delivered successfully!';
                    } else if (response.isOldOrder) {
                        response.message = 'This order is older than 60 days. Some tracking details may no longer be available.';
                    }
                }
            } catch (shiprocketError) {
                console.error('Shiprocket tracking error:', shiprocketError.message);
                // Continue with basic Shopify data if Shiprocket fails
            }
        }

        if (!res.headersSent) {
            res.json(response);
        } else {
            console.warn('Response already sent (client may have disconnected)');
        }

    } catch (error) {
        console.error('Track order error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to track order. Please try again.' });
        }
    }
});

// ==================== ADMIN ENDPOINTS ====================

// ── Operator Accounts, Permissions & Activity Tracking ──

// All permission keys that can be granted to an operator (team management is super-admin-only)
const VALID_PERMISSIONS = [
    'approve', 'reject', 'edit_requests', 'delete_requests', 'book_pickups',
    'payment_links', 'modify_exchange_address', 'duplicate_pickup', 'carrier_redispatch',
    'choose_resolution',
    'view_analytics', 'manage_settings', 'manage_influencers', 'manage_marketing'
];

// Route → permission rules (first match wins; influencer approve/reject rules precede the catch-all)
const PERMISSION_RULES = [
    { method: 'POST', pattern: /^\/api\/admin\/approve(-return|-exchange)?$/, perm: 'approve', label: 'Approve Request' },
    { method: 'POST', pattern: /^\/api\/admin\/approve-return-with-discount$/, perm: 'approve', label: 'Approve with Discount' },
    { method: 'POST', pattern: /^\/api\/admin\/send-coupon-code$/, perm: 'approve', label: 'Send Coupon Code' },
    { method: 'POST', pattern: /^\/api\/admin\/resolve-exchange$/, perm: 'choose_resolution', label: 'Choose Resolution' },
    { method: 'POST', pattern: /^\/api\/admin\/convert-to-exchange$/, perm: 'approve', label: 'Convert to Exchange' },
    { method: 'POST', pattern: /^\/api\/admin\/reject(-return|-exchange)?$/, perm: 'reject', label: 'Reject Request' },
    { method: 'POST', pattern: /^\/api\/admin\/undo-rejection$/, perm: 'reject', label: 'Undo Rejection' },
    { method: 'PUT', pattern: /^\/api\/admin\/update-request\/[^/]+$/, perm: 'modify_exchange_address', label: 'Modify Exchange Address' },
    { method: 'POST', pattern: /^\/api\/admin\/create-request$/, perm: 'edit_requests', label: 'Create Request' },
    { method: 'POST', pattern: /^\/api\/admin\/lookup-order-force$/, perm: 'edit_requests', label: 'Force Order Lookup' },
    { method: 'POST', pattern: /^\/api\/admin\/delete-requests$/, perm: 'delete_requests', label: 'Delete Requests' },
    { method: 'POST', pattern: /^\/api\/admin\/bulk-initiate-pickup$/, perm: 'book_pickups', label: 'Bulk Initiate Pickup' },
    { method: 'POST', pattern: /^\/api\/admin\/reset-pickup$/, perm: 'book_pickups', label: 'Reset Pickup' },
    { method: 'POST', pattern: /^\/api\/admin\/redispatch$/, perm: 'carrier_redispatch', label: 'Carrier for Re-dispatch' },
    { method: 'POST', pattern: /^\/api\/admin\/create-duplicate-pickup$/, perm: 'duplicate_pickup', label: 'Create Duplicate Pickup' },
    { method: 'POST', pattern: /^\/api\/admin\/create-duplicate-forward$/, perm: 'book_pickups', label: 'Create Duplicate Forward' },
    { method: 'POST', pattern: /^\/api\/admin\/mark-delivered$/, perm: 'book_pickups', label: 'Mark Delivered' },
    { method: 'POST', pattern: /^\/api\/admin\/generate-payment-link$/, perm: 'payment_links', label: 'Generate Payment Link' },
    { method: 'POST', pattern: /^\/api\/admin\/override-payment$/, perm: 'payment_links', label: 'Override Payment' },
    { method: 'GET', pattern: /^\/api\/admin\/stats$/, perm: 'view_analytics', label: 'View Stats' },
    { method: 'GET', pattern: /^\/api\/admin\/analytics\/detailed$/, perm: 'view_analytics', label: 'View Detailed Analytics' },
    { method: 'GET', pattern: /^\/api\/admin\/settings$/, perm: 'manage_settings', label: 'View Settings' },
    { method: 'POST', pattern: /^\/api\/admin\/settings$/, perm: 'manage_settings', label: 'Update Settings' },
    { method: 'GET', pattern: /^\/api\/admin\/shiprocket-locations$/, perm: 'manage_settings', label: 'View Pickup Locations' },
    { method: 'GET', pattern: /^\/api\/admin\/sync-status$/, perm: 'manage_settings', label: 'View Sync Status' },
    { method: 'POST', pattern: /^\/api\/admin\/sync-status$/, perm: 'manage_settings', label: 'Update Sync Status' },
    { method: 'GET', pattern: /^\/api\/admin\/shopify-sync-status$/, perm: 'manage_settings', label: 'View Shopify Sync Status' },
    { method: 'POST', pattern: /^\/api\/admin\/trigger-shopify-sync$/, perm: 'manage_settings', label: 'Trigger Shopify Sync' },
    { method: '*', pattern: /^\/api\/admin\/operators(\/|$)/, superOnly: true, label: 'Team Management' },
    { method: '*', pattern: /^\/api\/admin\/marketing(\/|$)/, perm: 'manage_marketing', label: 'Marketing Dashboard' },
    { method: 'POST', pattern: /^\/api\/influencer-admin\/(bulk-approve|approve)/, perm: 'approve', label: 'Approve Influencer' },
    { method: 'POST', pattern: /^\/api\/influencer-admin\/(bulk-reject|reject)/, perm: 'reject', label: 'Reject Influencer' },
    { method: '*', pattern: /^\/api\/influencer-admin(\/|$)/, perm: 'manage_influencers', label: 'Influencer Management' }
];

// Bounded in-memory operator cache (same pattern as settingsCache) — avoids a DB hit per request
const operatorCache = new Map();
const OPERATOR_CACHE_TTL = 30 * 1000;

function invalidateOperatorCache() {
    operatorCache.clear();
}

async function getCachedOperator(operatorId) {
    const cached = operatorCache.get(operatorId);
    if (cached && Date.now() - cached.fetchedAt < OPERATOR_CACHE_TTL) {
        return cached.op;
    }
    const op = await getOperatorById(operatorId);
    operatorCache.set(operatorId, { op: op || null, fetchedAt: Date.now() });
    return op || null;
}

function matchPermissionRule(method, pathname) {
    return PERMISSION_RULES.find(r =>
        (r.method === '*' || r.method === method) && r.pattern.test(pathname)
    ) || null;
}

// Fire-and-forget audit insert — never blocks or breaks the response path
function audit(entry) {
    logOperatorActivity(entry).catch(err => {
        console.error('[Audit] Failed to log activity:', err.message);
    });
}

// Extract a target identifier (e.g. REQ id) from the request for the audit trail
function extractAuditTarget(req) {
    if (req.params && req.params.requestId) return String(req.params.requestId);
    const body = req.body || {};
    return body.requestId || body.request_id || body.requestID || null;
}

// Centralized permission enforcement + activity audit for all admin surfaces.
// Registered BEFORE the admin routes. Super admin: zero DB calls. Operators: cached lookup only.
app.use(['/api/admin', '/api/influencer-admin'], async function enforceOperatorPermissions(req, res, next) {
    // Let CORS preflight and the login endpoint pass through (login has no token yet)
    if (req.method === 'OPTIONS' || req.path === '/login') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next(); // authenticateAdmin will 401

    const decoded = verifyToken(authHeader.substring(7));
    if (!decoded || (decoded.role !== 'admin' && decoded.role !== 'operator')) return next();

    const pathname = req.originalUrl.split('?')[0];
    const rule = matchPermissionRule(req.method, pathname);
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);

    if (decoded.role === 'operator') {
        let op = null;
        try {
            op = await getCachedOperator(decoded.operatorId);
        } catch (err) {
            console.error('[OperatorAuth] Cache lookup failed:', err.message);
        }

        if (!op || op.is_active === false) {
            audit({ operatorId: decoded.operatorId, username: decoded.username || 'operator', action: 'banned_or_deleted_access', method: req.method, path: pathname, success: false, ip: req.ip });
            return res.status(401).json({ error: 'This account has been banned or removed. Contact the administrator.' });
        }

        req.operator = op;
        req.permissions = op.permissions || [];

        // Team management is never grantable to operators
        if (rule && rule.superOnly) {
            audit({ operatorId: op.id, username: op.username, action: 'permission_denied', method: req.method, path: pathname, success: false, ip: req.ip });
            return res.status(403).json({ error: 'You do not have permission to perform this action' });
        }

        if (rule && rule.perm && !req.permissions.includes(rule.perm)) {
            audit({ operatorId: op.id, username: op.username, action: 'permission_denied', method: req.method, path: pathname, success: false, ip: req.ip });
            return res.status(403).json({ error: `You do not have permission for: ${rule.label}` });
        }

        // Default-deny unmatched write routes for operators
        if (!rule && isMutation) {
            audit({ operatorId: op.id, username: op.username, action: 'permission_denied', method: req.method, path: pathname, success: false, ip: req.ip });
            return res.status(403).json({ error: 'You do not have permission to perform this action' });
        }

        req.user = decoded;
    } else {
        req.user = decoded; // super admin: always passes
    }

    // Activity audit for mutating actions (fire-and-forget, attached before handlers run).
    // Team-management routes are excluded here — their handlers log richer entries themselves.
    if (isMutation && !(rule && rule.superOnly)) {
        const actor = decoded.role === 'admin'
            ? { operatorId: null, username: 'super-admin' }
            : { operatorId: decoded.operatorId, username: decoded.username };
        res.on('finish', () => {
            audit({
                ...actor,
                action: rule ? rule.label : `${req.method} ${pathname}`,
                method: req.method,
                path: pathname,
                target: extractAuditTarget(req),
                success: res.statusCode < 400,
                ip: req.ip
            });
        });
    }

    next();
});

// Admin authentication middleware with JWT (accepts super admin + operators)
async function authenticateAdmin(req, res, next) {
    // Already verified by the enforcement middleware above (normal path)
    if (req.user && (req.user.role === 'admin' || req.user.role === 'operator')) {
        return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded || (decoded.role !== 'admin' && decoded.role !== 'operator')) {
        trackSuspicious(req.ip, 'invalid_admin_token');
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Fallback operator resolution (enforcement middleware normally handles this)
    if (decoded.role === 'operator') {
        try {
            const op = await getCachedOperator(decoded.operatorId);
            if (!op || op.is_active === false) {
                return res.status(401).json({ error: 'This account has been banned or removed. Contact the administrator.' });
            }
            req.operator = op;
            req.permissions = op.permissions || [];
        } catch (err) {
            console.error('[OperatorAuth] Resolution failed:', err.message);
            return res.status(500).json({ error: 'Authentication error' });
        }
    }

    req.user = decoded;
    next();
}

// Super-admin-only gate (team management)
function requireSuperAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    return res.status(403).json({ error: 'Super admin access required' });
}

// Admin login with JWT — super admin (env password) or operator (username + password)
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;

    if (!password) {
        return res.status(400).json({ error: 'Password required' });
    }

    // ── Super admin path (unchanged behaviour) ──
    if (!username) {
        const expectedPassword = process.env.ADMIN_PASSWORD || 'admin123';
        if (password === expectedPassword) {
            const token = generateToken({ role: 'admin', timestamp: Date.now() });
            return res.json({ success: true, token, role: 'admin', username: 'super-admin' });
        }
        trackSuspicious(req.ip, 'failed_admin_login');
        return res.status(401).json({ error: 'Invalid password' });
    }

    // ── Operator path ──
    try {
        const op = await getOperatorByUsername(username.trim());

        if (!op || !verifyOperatorPassword(password, op.password_hash)) {
            audit({ operatorId: op ? op.id : null, username, action: 'login_failed', success: false, ip: req.ip });
            trackSuspicious(req.ip, 'failed_operator_login');
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (!op.is_active) {
            audit({ operatorId: op.id, username: op.username, action: 'login_banned', success: false, ip: req.ip });
            return res.status(403).json({ error: 'This account has been banned. Contact the administrator.' });
        }

        touchOperatorLogin(op.id); // fire-and-forget
        invalidateOperatorCache(); // fresh permissions/state from next request

        const mfrScope = op.manufacture_scope || 'full';
        const token = generateToken({ role: 'operator', operatorId: op.id, username: op.username, manufactureScope: mfrScope, timestamp: Date.now() });
        audit({ operatorId: op.id, username: op.username, action: 'login', ip: req.ip });

        res.json({
            success: true,
            token,
            role: 'operator',
            manufacture_scope: mfrScope,
            operator: {
                id: op.id,
                username: op.username,
                name: op.name,
                permissions: op.permissions || [],
                manufacture_scope: mfrScope
            }
        });
    } catch (error) {
        console.error('Operator login error:', error);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ==================== TEAM MANAGEMENT (Super Admin only) ====================

// Current session identity + permissions (drives frontend UI gating)
app.get('/api/admin/operators/me', authenticateAdmin, (req, res) => {
    if (req.user.role === 'admin') {
        return res.json({ role: 'admin', username: 'super-admin', name: 'Super Admin', permissions: VALID_PERMISSIONS, manufacture_scope: 'full' });
    }
    const op = req.operator || {};
    res.json({
        role: 'operator',
        id: op.id,
        username: op.username,
        name: op.name || op.username,
        permissions: op.permissions || [],
        manufacture_scope: op.manufacture_scope || 'full'
    });
});

// List all operators (password hashes never returned)
app.get('/api/admin/operators', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const operators = await listOperators();
        res.json({ success: true, operators });
    } catch (error) {
        console.error('List operators error:', error);
        res.status(500).json({ error: 'Failed to load operators' });
    }
});

// Create an operator
app.post('/api/admin/operators', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { username, name, email, password, permissions, manufactureScope } = req.body;

        const cleanUsername = String(username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,50}$/.test(cleanUsername)) {
            return res.status(400).json({ error: 'Username must be 2-50 characters (letters, numbers, dot, dash, underscore)' });
        }
        if (!password || String(password).length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const cleanPerms = Array.isArray(permissions)
            ? permissions.filter(p => VALID_PERMISSIONS.includes(p))
            : [];

        const validScopes = ['full', 'samples_techpacks'];
        const mfrScope = validScopes.includes(manufactureScope) ? manufactureScope : 'full';

        const existing = await getOperatorByUsername(cleanUsername);
        if (existing) {
            return res.status(409).json({ error: 'This username is already taken' });
        }

        const operator = await createOperator({
            username: cleanUsername,
            name: (name || '').trim() || null,
            email: (email || '').trim() || null,
            passwordHash: hashOperatorPassword(password),
            permissions: cleanPerms,
            manufactureScope: mfrScope
        });

        audit({ username: 'super-admin', action: 'operator_created', target: cleanUsername, ip: req.ip });
        res.json({ success: true, operator });
    } catch (error) {
        console.error('Create operator error:', error);
        res.status(500).json({ error: 'Failed to create operator' });
    }
});

// Edit an operator (name/email/permissions, optional password reset)
app.patch('/api/admin/operators/:id', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const opId = parseInt(req.params.id, 10);
        const { name, email, permissions, newPassword, manufactureScope } = req.body;

        const existing = await getOperatorById(opId);
        if (!existing) return res.status(404).json({ error: 'Operator not found' });

        const updates = {};
        if (name !== undefined) updates.name = String(name).trim() || null;
        if (email !== undefined) updates.email = String(email).trim() || null;
        if (permissions !== undefined) {
            updates.permissions = Array.isArray(permissions)
                ? permissions.filter(p => VALID_PERMISSIONS.includes(p))
                : [];
        }
        if (manufactureScope !== undefined) {
            const validScopes = ['full', 'samples_techpacks'];
            updates.manufactureScope = validScopes.includes(manufactureScope) ? manufactureScope : 'full';
        }
        if (newPassword) {
            if (String(newPassword).length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            updates.passwordHash = hashOperatorPassword(newPassword);
        }

        const operator = await updateOperator(opId, updates);
        invalidateOperatorCache();

        audit({ username: 'super-admin', action: updates.passwordHash ? 'operator_password_reset' : 'operator_updated', target: existing.username, ip: req.ip });
        res.json({ success: true, operator });
    } catch (error) {
        console.error('Update operator error:', error);
        res.status(500).json({ error: 'Failed to update operator' });
    }
});

// Ban an operator (immediately blocks login; tokens rejected within cache window)
app.post('/api/admin/operators/:id/ban', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const opId = parseInt(req.params.id, 10);
        const existing = await getOperatorById(opId);
        if (!existing) return res.status(404).json({ error: 'Operator not found' });

        const operator = await setOperatorActive(opId, false);
        invalidateOperatorCache();

        audit({ username: 'super-admin', action: 'operator_banned', target: existing.username, ip: req.ip });
        res.json({ success: true, operator });
    } catch (error) {
        console.error('Ban operator error:', error);
        res.status(500).json({ error: 'Failed to ban operator' });
    }
});

// Unban an operator
app.post('/api/admin/operators/:id/unban', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const opId = parseInt(req.params.id, 10);
        const existing = await getOperatorById(opId);
        if (!existing) return res.status(404).json({ error: 'Operator not found' });

        const operator = await setOperatorActive(opId, true);
        invalidateOperatorCache();

        audit({ username: 'super-admin', action: 'operator_unbanned', target: existing.username, ip: req.ip });
        res.json({ success: true, operator });
    } catch (error) {
        console.error('Unban operator error:', error);
        res.status(500).json({ error: 'Failed to unban operator' });
    }
});

// Delete an operator (activity history is preserved via denormalized username)
app.delete('/api/admin/operators/:id', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const opId = parseInt(req.params.id, 10);
        const existing = await getOperatorById(opId);
        if (!existing) return res.status(404).json({ error: 'Operator not found' });

        await deleteOperator(opId);
        invalidateOperatorCache();

        audit({ username: 'super-admin', action: 'operator_deleted', target: existing.username, ip: req.ip });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete operator error:', error);
        res.status(500).json({ error: 'Failed to delete operator' });
    }
});

// Activity log with filters + pagination
app.get('/api/admin/operators/activity', authenticateAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.search) filters.search = String(req.query.search).trim();
        if (req.query.operatorId) filters.operatorId = parseInt(req.query.operatorId, 10);
        if (req.query.username) filters.username = String(req.query.username);
        if (req.query.action) filters.action = String(req.query.action);
        if (req.query.fromDate) filters.fromDate = String(req.query.fromDate);
        if (req.query.toDate) filters.toDate = String(req.query.toDate);
        filters.page = req.query.page;
        filters.limit = req.query.limit;

        const result = await getOperatorActivityLogs(filters);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Get activity logs error:', error);
        res.status(500).json({ error: 'Failed to load activity logs' });
    }
});

// Admin: Get Settings
app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = {
            return_window_days: await getSetting('return_window_days', 2),
            return_window_mode: await getSetting('return_window_mode', 'delivery'),
            allow_returns: await getSetting('allow_returns', true),
            allow_exchanges: await getSetting('allow_exchanges', true),
            auto_approve_reasons: await getSetting('auto_approve_reasons', ['size', 'fit']),
            warehouse_location: await getSetting('warehouse_location', null),
            delhivery_pickup_location: await getSetting('delhivery_pickup_location', null),
            cutoff_date_enabled: await getSetting('cutoff_date_enabled', false),
            cutoff_date: await getSetting('cutoff_date', null),
            allow_shopper_hub_orders: await getSetting('allow_shopper_hub_orders', true),
            // Separate pickup/dispatch carrier settings (new)
            carrier_mode_pickup: await getSetting('carrier_mode_pickup', null),
            carrier_mode_dispatch: await getSetting('carrier_mode_dispatch', null),
            // Legacy carrier mode (for backward compatibility)
            carrier_mode: await getSetting('carrier_mode', 'shiprocket_with_fallback')
        };
        res.json(settings);
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// Admin: Get Shiprocket Locations
app.get('/api/admin/shiprocket-locations', authenticateAdmin, async (req, res) => {
    try {
        const token = await getShiprocketToken();
        const response = await fetchWithRetry('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Shiprocket API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();

        // Shiprocket returns an array of pickup locations
        if (data && data.data && data.data.shipping_address) {
            res.json({ success: true, locations: data.data.shipping_address });
        } else {
            res.json({ success: true, locations: [] });
        }
    } catch (error) {
        console.error('Get Shiprocket locations error:', error);
        res.status(500).json({ error: 'Failed to fetch Shiprocket pickup locations' });
    }
});

// Admin: Update Settings
app.post('/api/admin/settings', authenticateAdmin, async (req, res) => {
    try {
        const { updates } = req.body;
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Invalid updates object' });
        }

        for (const [key, value] of Object.entries(updates)) {
            await updateSetting(key, value);
        }

        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ==================== AGENT ENDPOINTS (Read-only + Notes) ====================

// Agent auth middleware with JWT
function authenticateAgent(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded || decoded.role !== 'agent') {
        trackSuspicious(req.ip, 'invalid_agent_token');
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = decoded;
    next();
}

// Agent login with JWT
app.post('/api/agent/login', (req, res) => {
    const { password } = req.body;
    const agentPass = process.env.AGENT_PASSWORD;

    if (!password) {
        return res.status(400).json({ error: 'Password required' });
    }
    if (!agentPass) return res.status(503).json({ error: 'Agent access not configured' });
    if (password !== agentPass) {
        trackSuspicious(req.ip, 'failed_agent_login');
        return res.status(401).json({ error: 'Invalid password' });
    }

    const token = generateToken({ role: 'agent', timestamp: Date.now() });
    res.json({ success: true, token });
});

// Agent — read-only request list
app.get('/api/agent/requests', authenticateAgent, async (req, res) => {
    try {
        const { status, type, search, page, limit } = req.query;
        const result = await getAllRequests({ status, type, search, page, limit });
        res.json({ requests: result.data, pagination: result.pagination });
    } catch (error) {
        console.error('Agent get requests error:', error);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// Agent — read-only stats
app.get('/api/agent/stats', authenticateAgent, async (req, res) => {
    try {
        const stats = await getRequestStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Agent — save notes on a request
app.post('/api/agent/save-notes', authenticateAgent, async (req, res) => {
    try {
        const { requestId, notes } = req.body;
        if (!requestId) return res.status(400).json({ error: 'requestId required' });
        await saveAgentNotes(requestId, notes || '');
        res.json({ success: true });
    } catch (error) {
        console.error('Agent save notes error:', error);
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

// ==========================================================================

// Get all requests (admin)
app.get('/api/admin/requests', authenticateAdmin, async (req, res) => {
    try {
        const { status, type, date, search, page, limit, carrier } = req.query;

        // Run in parallel to reduce latency and avoid timeouts
        const [result, stats] = await Promise.all([
            getAllRequests({ status, type, date, search, page, limit, carrier }),
            getRequestStats()
        ]);

        if (res.headersSent) return;
        res.json({ requests: result.data, pagination: result.pagination, stats });
    } catch (error) {
        console.error('Get requests error:', error);
        if (res.headersSent) return;
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// ==================== EXPORT ENDPOINT (Excel / CSV) ====================
app.get('/api/admin/requests/export', authenticateAdmin, async (req, res) => {
    try {
        const { status, type, carrier, dateFrom, dateTo, date, search, format } = req.query;
        const exportFormat = format === 'csv' ? 'csv' : 'xlsx';

        console.log('[Export] Generating %s export with filters:', exportFormat, { status, type, carrier, dateFrom, dateTo, date });

        // Fetch ALL matching records (no pagination) using paging loop
        const requests = await getAllRequestsForExport({ status, type, carrier, dateFrom, dateTo, date, search });

        if (!requests || requests.length === 0) {
            return res.status(404).json({ error: 'No data found for the selected filters' });
        }

        // Build detailed row data
        const headers = [
            'Request ID', 'Type', 'Status', 'Order Number', 'Customer Name',
            'Customer Email', 'Customer Phone', 'Carrier', 'AWB Number',
            'Shipment ID', 'Pickup Date', 'Reason', 'Comments',
            'Items', 'Shipping Address', 'Shipping City', 'Shipping State',
            'Shipping Pincode', 'Payment ID', 'Payment Amount', 'COD Charges',
            'Admin Notes', 'Agent Notes', 'Created At', 'Updated At'
        ];

        const rows = requests.map(req => [
            req.requestId || '',
            req.type || '',
            req.status || '',
            req.orderNumber || '',
            req.customerName || '',
            req.customerEmail || '',
            req.customerPhone || '',
            req.carrier || '',
            req.awbNumber || '',
            req.shipmentId || '',
            req.pickupDate || '',
            req.reason || '',
            (req.comments || '').replace(/[\n\r]+/g, ' '),
            Array.isArray(req.items) ? req.items.map(i => i.name || i.title || JSON.stringify(i)).join('; ') : '',
            req.shippingAddress || '',
            req.shippingCity || '',
            req.shippingState || '',
            req.shippingPincode || '',
            req.paymentId || '',
            req.paymentAmount || 0,
            req.codCharges || 0,
            (req.adminNotes || '').replace(/[\n\r]+/g, ' '),
            (req.agentNotes || '').replace(/[\n\r]+/g, ' '),
            req.createdAt ? new Date(req.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
            req.updatedAt ? new Date(req.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : ''
        ]);

        const dateSuffix = dateFrom && dateTo
            ? `${dateFrom}_to_${dateTo}`
            : dateFrom ? `from_${dateFrom}`
            : dateTo ? `until_${dateTo}`
            : new Date().toISOString().slice(0, 10);

        if (exportFormat === 'csv') {
            // ── CSV export ──
            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            ].join('\n');

            // Add BOM for Excel UTF-8 compatibility
            const bom = '\uFEFF';
            const buffer = Buffer.from(bom + csvContent, 'utf-8');

            res.setHeader('Content-Type', 'text/csv;charset=utf-8;');
            res.setHeader('Content-Disposition', `attachment; filename="return_exchange_${dateSuffix}.csv"`);
            res.setHeader('Content-Length', buffer.length);
            return res.send(buffer);
        }

        // ── Excel (XLSX) export using exceljs ──
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'OFFCOMFRT Admin';
        workbook.created = new Date();

        const sheet = workbook.addWorksheet('Returns & Exchanges', {
            views: [{ state: 'frozen', ySplit: 1 }]
        });

        // Define columns
        sheet.columns = headers.map((h, i) => ({
            header: h,
            key: `col_${i}`,
            width: Math.max(h.length + 2, 14)
        }));

        // Style header row
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        headerRow.border = {
            bottom: { style: 'thin', color: { argb: 'FF374151' } }
        };
        headerRow.height = 22;

        // Auto-filter
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

        // Add data rows
        rows.forEach(rowData => {
            const row = sheet.addRow(rowData);
            row.alignment = { vertical: 'middle', wrapText: true };
            // Alternate row shading
            if (row.number % 2 === 0) {
                row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
            }
        });

        // Status column conditional coloring
        const statusColIdx = headers.indexOf('Status') + 1;
        const statusColors = {
            'pending': 'FFFFF7ED',
            'approved': 'FFECFDF5',
            'rejected': 'FFFEF2F2',
            'pickup_pending': 'FFFFFBEB',
            'scheduled': 'FFEFF6FF',
            'picked_up': 'FFECFDF5',
            'in_transit': 'FFEFF6FF',
            'delivered': 'FFECFDF5',
            'cancelled': 'FFFEF2F2',
            'failed': 'FFFEF2F2',
            'waiting_payment': 'FFFEF9C3',
            'payment_received': 'FFECFDF5'
        };

        for (let r = 2; r <= rows.length + 1; r++) {
            const cell = sheet.getRow(r).getCell(statusColIdx);
            const color = statusColors[cell.value] || 'FFFFFFFF';
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        }

        // Date columns formatting
        const createdAtColIdx = headers.indexOf('Created At') + 1;
        for (let r = 2; r <= rows.length + 1; r++) {
            const cell = sheet.getRow(r).getCell(createdAtColIdx);
            cell.numFmt = 'dd/mm/yyyy hh:mm AM/PM';
        }

        // Set column widths more intelligently
        const colWidths = {
            'Request ID': 16, 'Type': 10, 'Status': 16, 'Order Number': 14,
            'Customer Name': 20, 'Customer Email': 26, 'Customer Phone': 15,
            'Carrier': 12, 'AWB Number': 16, 'Shipment ID': 16,
            'Pickup Date': 14, 'Reason': 16, 'Comments': 30,
            'Items': 40, 'Shipping Address': 30, 'Shipping City': 16,
            'Shipping State': 14, 'Shipping Pincode': 12, 'Payment ID': 18,
            'Payment Amount': 14, 'COD Charges': 12, 'Admin Notes': 30,
            'Agent Notes': 30, 'Created At': 20, 'Updated At': 20
        };
        sheet.columns.forEach(col => {
            col.width = colWidths[col.header] || 14;
        });

        // Summary sheet
        const summarySheet = workbook.addWorksheet('Summary');
        const totalReturns = requests.filter(r => r.type === 'return').length;
        const totalExchanges = requests.filter(r => r.type === 'exchange').length;
        const statusCounts = {};
        requests.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });

        summarySheet.columns = [
            { header: 'Metric', key: 'metric', width: 24 },
            { header: 'Value', key: 'value', width: 16 }
        ];

        const summaryHeader = summarySheet.getRow(1);
        summaryHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        summaryHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
        summaryHeader.alignment = { vertical: 'middle', horizontal: 'center' };

        const summaryData = [
            ['Total Records', requests.length],
            ['Total Returns', totalReturns],
            ['Total Exchanges', totalExchanges],
            ['Date From', dateFrom || 'All time'],
            ['Date To', dateTo || 'Present'],
            ...Object.entries(statusCounts).map(([s, c]) => [`Status: ${s}`, c])
        ];
        summaryData.forEach(([metric, value]) => {
            summarySheet.addRow({ metric, value });
        });

        // Write to buffer
        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="return_exchange_${dateSuffix}.xlsx"`);
        res.setHeader('Content-Length', buffer.length);
        return res.send(buffer);

    } catch (error) {
        console.error('[Export] Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Export failed: ' + error.message });
        }
    }
});

// Get admin stats (optimized, separate endpoint)
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await getRequestStats();
        res.json(stats);
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Get detailed analytics (new premium endpoint)
app.get('/api/admin/analytics/detailed', authenticateAdmin, async (req, res) => {
    try {
        const { dateRange } = req.query;
        
        // Calculate date range
        const now = new Date();
        let startDate;
        let previousStartDate;
        
        switch (dateRange) {
            case '7d':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                previousStartDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
                break;
            case '90d':
                startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                previousStartDate = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
                break;
            case '30d':
            default:
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                previousStartDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
                break;
        }
        
        // Fetch current period data
        const { data: currentRequests, error: currentError } = await supabase
            .from('requests')
            .select('*')
            .gte('created_at', startDate.toISOString());
        
        if (currentError) throw currentError;
        
        // Fetch previous period data for comparison
        const { data: previousRequests, error: previousError } = await supabase
            .from('requests')
            .select('*')
            .gte('created_at', previousStartDate.toISOString())
            .lt('created_at', startDate.toISOString());
        
        if (previousError) throw previousError;
        
        // Calculate stats for current period
        const stats = {
            total: currentRequests.length,
            pending: currentRequests.filter(r => r.status === 'pending').length,
            waitingPayment: currentRequests.filter(r => r.status === 'waiting_payment').length,
            approved: currentRequests.filter(r => r.status === 'approved').length,
            rejected: currentRequests.filter(r => r.status === 'rejected').length,
            returns: currentRequests.filter(r => r.type === 'return').length,
            exchanges: currentRequests.filter(r => r.type === 'exchange').length,
            totalRevenue: currentRequests.reduce((sum, r) => {
                // Try total_amount first, then calculate from items
                if (r.total_amount) return sum + r.total_amount;
                // Calculate from items array
                if (r.items && Array.isArray(r.items)) {
                    const itemsTotal = r.items.reduce((itemSum, item) => {
                        // Prefer the amount actually paid (after coupon/discounts)
                        const price = parseFloat(item.paidPrice) || parseFloat(item.price) || 0;
                        const quantity = parseInt(item.quantity) || 1;
                        return itemSum + (price * quantity);
                    }, 0);
                    return sum + itemsTotal;
                }
                return sum;
            }, 0)
        };
        
        // Calculate stats for previous period
        const previousStats = {
            total: previousRequests.length,
            totalRevenue: previousRequests.reduce((sum, r) => {
                // Try total_amount first, then calculate from items
                if (r.total_amount) return sum + r.total_amount;
                // Calculate from items array
                if (r.items && Array.isArray(r.items)) {
                    const itemsTotal = r.items.reduce((itemSum, item) => {
                        // Prefer the amount actually paid (after coupon/discounts)
                        const price = parseFloat(item.paidPrice) || parseFloat(item.price) || 0;
                        const quantity = parseInt(item.quantity) || 1;
                        return itemSum + (price * quantity);
                    }, 0);
                    return sum + itemsTotal;
                }
                return sum;
            }, 0)
        };
        
        // Calculate comparisons
        const totalChange = previousStats.total > 0 
            ? Math.round(((stats.total - previousStats.total) / previousStats.total) * 100) 
            : 0;
        
        const valueChange = previousStats.totalRevenue > 0 
            ? Math.round(((stats.totalRevenue - previousStats.totalRevenue) / previousStats.totalRevenue) * 100) 
            : 0;
        
        // Status distribution
        const statusDistribution = {};
        currentRequests.forEach(r => {
            statusDistribution[r.status] = (statusDistribution[r.status] || 0) + 1;
        });
        
        // Return reasons breakdown
        const reasons = {};
        currentRequests.forEach(r => {
            if (r.reason) {
                reasons[r.reason] = (reasons[r.reason] || 0) + 1;
            }
        });
        
        // Carrier statistics
        const carrierStats = {};
        currentRequests.forEach(r => {
            if (r.carrier) {
                if (!carrierStats[r.carrier]) {
                    carrierStats[r.carrier] = { total: 0, success: 0 };
                }
                carrierStats[r.carrier].total++;
                if (['delivered', 'approved'].includes(r.status)) {
                    carrierStats[r.carrier].success++;
                }
            }
        });
        
        // Time series data (chronological order: oldest to newest)
        const timeSeries = [];
        const days = dateRange === '7d' ? 7 : dateRange === '90d' ? 90 : 30;
        
        for (let i = 0; i < days; i++) {
            const date = new Date(now.getTime() - (days - 1 - i) * 24 * 60 * 60 * 1000);
            const dateStr = date.toISOString().split('T')[0];
            const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);
            
            const dayRequests = currentRequests.filter(r => {
                const reqDate = new Date(r.created_at);
                return reqDate >= date && reqDate < nextDate;
            });
            
            timeSeries.push({
                date: dateStr,
                total: dayRequests.length,
                returns: dayRequests.filter(r => r.type === 'return').length,
                exchanges: dayRequests.filter(r => r.type === 'exchange').length
            });
        }
        
        // Sort chronologically (oldest to newest)
        timeSeries.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        // Calculate average processing time
        const completedRequests = currentRequests.filter(r => 
            ['approved', 'rejected', 'delivered'].includes(r.status) && r.updated_at
        );
        
        let avgProcessingTime = 0;
        if (completedRequests.length > 0) {
            const totalTime = completedRequests.reduce((sum, r) => {
                const created = new Date(r.created_at);
                const updated = new Date(r.updated_at);
                return sum + (updated - created);
            }, 0);
            avgProcessingTime = totalTime / completedRequests.length / (1000 * 60 * 60 * 24); // Convert to days
        }
        
        // Insights
        const insights = {
            topReason: Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A',
            topReasonCount: Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[1] || 0,
            peakDay: timeSeries.sort((a, b) => b.total - a.total)[0]?.date || 'N/A',
            peakDayCount: timeSeries.sort((a, b) => b.total - a.total)[0]?.total || 0,
            carrierSuccessRate: Object.keys(carrierStats).length > 0 
                ? Math.round(
                    (Object.values(carrierStats).reduce((sum, c) => sum + c.success, 0) / 
                     Object.values(carrierStats).reduce((sum, c) => sum + c.total, 0)) * 100
                  ) + '%'
                : 'N/A'
        };
        
        res.json({
            stats,
            comparison: {
                totalChange,
                valueChange,
                previousTotal: previousStats.total
            },
            statusDistribution,
            reasons,
            carrierStats,
            timeSeries,
            avgProcessingTime,
            insights
        });
        
    } catch (error) {
        console.error('Get detailed analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch detailed analytics' });
    }
});

// Approve request (admin) - supports legacy endpoints
app.post(['/api/admin/approve', '/api/admin/approve-return', '/api/admin/approve-exchange'], authenticateAdmin, async (req, res) => {
    try {
        const { requestId, notes, carrierOverride } = req.body;

        // Get request details first
        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }

        let adminNotes = notes || '';
        let newStatus = 'approved';
        let updates = { adminNotes };

        // 1. Initial Approval or Re-initiate -> Initiate Pickup
        if (requestDetails.status === 'pending' || requestDetails.status === 'pickup_pending') {
            // If re-initiating pickup_pending, log and add note
            if (requestDetails.status === 'pickup_pending') {
                console.log(`[${requestId}] RE-INITIATING pickup (was already pickup_pending). Previous carrier: ${requestDetails.carrier || 'unknown'}`);
                adminNotes += `\n--- Pickup Re-initiated by Admin (Previous: ${requestDetails.carrier || 'unknown'}) ---`;

                // Guard: if an AWB already exists, skip duplicate Delhivery order creation
                if (requestDetails.awbNumber || requestDetails.carrierAwb) {
                    console.log(`[${requestId}] AWB already exists (${requestDetails.awbNumber || requestDetails.carrierAwb}), skipping duplicate Delhivery order`);
                    return res.json({
                        success: true,
                        message: `Pickup already booked via ${requestDetails.carrier || 'unknown'}. Use "Create Duplicate Pickup" for a fresh booking.`,
                        existingBooking: {
                            awbNumber: requestDetails.awbNumber || requestDetails.carrierAwb,
                            shipmentId: requestDetails.shipmentId || requestDetails.carrierShipmentId,
                            carrier: requestDetails.carrier
                        }
                    });
                }
            }
            
            // Get carrier mode from settings (supports separate pickup/dispatch settings)
            const carrierMode = await getCarrierMode('pickup');
            const carrierResolution = resolveCarrier(carrierMode, carrierOverride, 'pickup');
            console.log(`[${requestId}] Admin authorized pickup. Carrier mode: ${carrierMode}, Resolution:`, carrierResolution);

            // Try to fetch Shopify order but don't block on failure
            let shopifyOrder = null;
            try {
                let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(requestDetails.orderNumber)}&status=any&limit=1`);
                // Fuzzy retry with/without '#'
                if (!shopifyData.orders || shopifyData.orders.length === 0) {
                    const alt = requestDetails.orderNumber.startsWith('#')
                        ? requestDetails.orderNumber.substring(1)
                        : '#' + requestDetails.orderNumber;
                    shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(alt)}&status=any&limit=1`);
                }
                shopifyOrder = shopifyData.orders && shopifyData.orders[0];
                if (!shopifyOrder) console.warn(`[${requestId}] Shopify order not found for ${requestDetails.orderNumber} — Will use stored request data as fallback.`);
            } catch (err) {
                console.warn(`[${requestId}] Shopify fetch failed, proceeding with stored data:`, err.message);
            }

            let awbNumber = null;
            let shipmentId = null;
            let pickupDate = null;
            let carrierUsed = null;
            let fallbackReason = null;

            try {
                const { primary: carrierToUse, useFallback, fallback: configuredFallback } = carrierResolution;

                // Try the resolved primary carrier, then the fallback partner if enabled
                const bookingData = {
                    ...requestDetails,
                    requestId,
                    orderNumber: requestDetails.orderNumber,
                    customerPhone: requestDetails.customerPhone
                };

                let booking = null;
                try {
                    console.log(`[${requestId}] Using ${carrierToUse} (fallback: ${useFallback})...`);
                    booking = await returnBookingAttempt(carrierToUse, bookingData, shopifyOrder);
                } catch (primaryError) {
                    // If fallback is enabled, try the fallback carrier
                    if (!useFallback) throw primaryError;

                    const fallbackCarrier = configuredFallback || getFallbackCarrier(carrierToUse);
                    fallbackReason = `${carrierToUse} failed: ${primaryError.message}`;
                    console.warn(`[${requestId}] ⚠️ ${carrierToUse} failed, falling back to ${fallbackCarrier}:`, primaryError.message);

                    try {
                        booking = await returnBookingAttempt(fallbackCarrier, bookingData, shopifyOrder);
                        console.log(`[${requestId}] ✅ ${fallbackCarrier} fallback success: AWB ${booking.awbNumber || 'PENDING'}`);
                    } catch (fallbackError) {
                        console.error(`[${requestId}] ❌ Both carriers failed. Fallback error:`, fallbackError.message);
                        throw new Error(`Both carriers failed: ${primaryError.message} | ${fallbackError.message}`);
                    }
                }

                carrierUsed = booking.carrierUsed;
                awbNumber = booking.awbNumber;
                shipmentId = booking.shipmentId;
                pickupDate = booking.pickupDate;
                console.log(`[${requestId}] ✅ ${carrierUsed} success: ShipmentID ${shipmentId}, AWB ${awbNumber || 'PENDING'}`);

                // Update with success data
                if (carrierUsed) {
                    updates.shipmentId = shipmentId;
                    updates.awbNumber = awbNumber;
                    updates.pickupDate = pickupDate;
                    updates.carrier = carrierUsed;
                    updates.carrierShipmentId = shipmentId;
                    updates.carrierAwb = awbNumber;
                    if (fallbackReason) {
                        updates.carrierFallbackReason = fallbackReason;
                    }
                    updates.status = 'pickup_booked';
                    updates.adminNotes = adminNotes + `\nPickup scheduled via ${carrierUsed}: AWB ${awbNumber || 'Pending'}`;

                    const request = await updateRequestStatus(requestId, updates);

                    // ── Send approval WhatsApp message (non-blocking) ──
                    sendReturnExchangeApprovalWhatsApp({
                        phone: requestDetails.customerPhone,
                        requestId,
                        orderNumber: requestDetails.orderNumber,
                        type: requestDetails.type
                    }).then(waResult => {
                        if (waResult?.success) {
                            updateRequestStatus(requestId, {
                                whatsappSent: true,
                                whatsappMessageId: waResult.messageId || null,
                                whatsappSentAt: new Date().toISOString()
                            }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                        }
                    }).catch(() => {}); // fire-and-forget

                    return res.json({ success: true, message: `Pickup initiated via ${carrierUsed} and status updated to pickup_booked`, request });
                } else {
                    throw new Error('No carrier was used');
                }
            } catch (carrierError) {
                console.error(`[${requestId}] Pickup initiation failed:`, carrierError);
                return res.status(500).json({ error: 'Failed to initiate pickup: ' + carrierError.message });
            }
        }

        // 2. Final Approval -> Quality Check Passed -> Process Resolution
        // Trigger Forward Shipment based on carrier settings (Shiprocket and/or Delhivery)
        if (requestDetails.type === 'exchange' && requestDetails.status !== 'approved') {
            // Guard: skip forward order creation if one already exists (prevents duplicate Delhivery orders on re-approval)
            if (requestDetails.forwardAwbNumber || requestDetails.forwardShipmentId) {
                console.log(`[${requestId}] Forward shipment already exists (AWB: ${requestDetails.forwardAwbNumber || 'N/A'}), skipping duplicate creation`);
                updates.status = 'approved';
            } else {
            console.log(`[${requestId}] Finalizing exchange resolution...`);

            // Get carrier mode for dispatch (forward shipment)
            const carrierMode = await getCarrierMode('dispatch');
            const carrierResolution = resolveCarrier(carrierMode, carrierOverride || null, 'dispatch');
            
            console.log(`[${requestId}] 🚀 Creating Forward Shipment for Exchange with carrier: ${carrierResolution.primary}${carrierResolution.useFallback ? ' (with fallback)' : ''}`);
            
            let items = requestDetails.items;
            if (typeof items === 'string') { 
                try { 
                    items = JSON.parse(items); 
                    console.log(`[${requestId}] 📋 Parsed items from JSON string: ${items.length} item(s)`);
                } catch (e) { 
                    console.error(`[${requestId}] ❌ Failed to parse items JSON:`, e);
                    items = []; 
                } 
            }

            // Log item details before creating forward order
            console.log(`[${requestId}] 📦 Items to be dispatched:`);
            items.forEach((item, idx) => {
                console.log(`  ${idx + 1}. ${item.replacementProductTitle || item.name}`);
                console.log(`     replacementProductTitle: "${item.replacementProductTitle || ''}" | name: "${item.name || ''}"`);
                console.log(`     replacementVariant: "${item.replacementVariant || '(MISSING)'}" | original variant: "${item.variant || ''}"`);
                console.log(`     replacementVariantId: "${item.replacementVariantId || '(MISSING)'}" | original variantId: "${item.variantId || ''}"`);
                console.log(`     Qty: ${item.quantity}`);
                if (!item.replacementVariant) {
                    console.warn(`[${requestId}] ⚠️ Item ${idx + 1}: replacementVariant is MISSING — Shopify lookup will be attempted as fallback`);
                }
            });

            // Create forward order based on carrier mode
            let forwardOrder = null;
            let carrierUsed = null;

            const primaryCarrier = carrierResolution.primary;
            const useFallback = carrierResolution.useFallback;
            const fallbackCarrier = carrierResolution.fallback || getFallbackCarrier(primaryCarrier);

            try {
                const primaryResult = await forwardBookingAttempt(primaryCarrier, { ...requestDetails, items });
                forwardOrder = primaryResult.forwardOrder;
                carrierUsed = primaryResult.carrierUsed;
                console.log(`[${requestId}] ✅ ${primaryCarrier} forward dispatch success`);
            } catch (primaryError) {
                console.error(`[${requestId}] ❌ Primary carrier (${primaryCarrier}) failed:`, primaryError.message);
                
                // Try fallback if enabled
                if (useFallback) {
                    try {
                        console.log(`[${requestId}] ⚠️ Falling back to ${fallbackCarrier}...`);
                        const fallbackResult = await forwardBookingAttempt(fallbackCarrier, { ...requestDetails, items });
                        forwardOrder = fallbackResult.forwardOrder;
                        carrierUsed = fallbackResult.carrierUsed;
                        console.log(`[${requestId}] ✅ ${fallbackCarrier} fallback success`);
                    } catch (fallbackError) {
                        console.error(`[${requestId}] ❌ Both carriers failed. Fallback error:`, fallbackError.message);
                        forwardOrder = null;
                    }
                } else {
                    console.error(`[${requestId}] ❌ ${primaryCarrier} failed and fallback not enabled`);
                    forwardOrder = null;
                }
            }

            if (forwardOrder && (forwardOrder.shipment_id || forwardOrder.waybill)) {
                const shipmentInfo = carrierUsed === 'shiprocket' 
                    ? `Shiprocket ID: ${forwardOrder.shipment_id}` 
                    : `${carrierUsed === 'ekart' ? 'Ekart' : 'Delhivery'} AWB: ${forwardOrder.waybill}`;
                adminNotes += `\nReplacement Shipment Created (${carrierUsed}: ${shipmentInfo})`;
                updates.forwardShipmentId = String(forwardOrder.shipment_id || forwardOrder.order_id);
                updates.forwardAwbNumber = forwardOrder.awb_code || forwardOrder.waybill || '';
                updates.forwardStatus = 'scheduled';
                updates.forwardCarrier = carrierUsed;
                // Only mark as approved if forward shipment was successfully created
                updates.status = 'approved';
            } else {
                // Forward shipment creation failed - do NOT mark as approved
                adminNotes += `\nFailed to create replacement shipment. Check logs.`;
                console.error(`[${requestId}] ❌ Forward shipment creation failed. Status will remain as: ${requestDetails.status}`);
                // Keep the current status instead of marking as approved
                updates.status = requestDetails.status;
                return res.status(500).json({ 
                    success: false, 
                    error: 'Failed to create forward shipment. Please check logs and try again.',
                    requestId: requestId
                });
            }
        } // ← closes forwardAwbNumber guard else
        } else {
            // For non-exchange types or already approved, just mark as approved
            updates.status = 'approved';
        }

        const request = await updateRequestStatus(requestId, {
            ...updates,
            adminNotes: adminNotes
        });

        // Zoho middleware: reflect the real exchanged/returned products (fire-and-forget)
        if (requestDetails.type === 'exchange') {
            let zohoNotifyItems = requestDetails.items;
            if (typeof zohoNotifyItems === 'string') {
                try { zohoNotifyItems = JSON.parse(zohoNotifyItems); } catch (e) { zohoNotifyItems = []; }
            }
            notifyZohoExchange(requestDetails, Array.isArray(zohoNotifyItems) ? zohoNotifyItems : [])
                .catch(e => console.warn('[' + requestId + '] Zoho exchange notify failed: ' + e.message));
        } else if (requestDetails.type === 'return' && updates.status === 'approved') {
            let zohoReturnItems = requestDetails.items;
            if (typeof zohoReturnItems === 'string') {
                try { zohoReturnItems = JSON.parse(zohoReturnItems); } catch (e) { zohoReturnItems = []; }
            }
            notifyZohoReturn(requestDetails, Array.isArray(zohoReturnItems) ? zohoReturnItems : [])
                .catch(e => console.warn('[' + requestId + '] Zoho return notify failed: ' + e.message));
        }

        res.json({ success: true, message: 'Request approved successfully', request });
    } catch (error) {
        console.error('Approve request error:', error);
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

// Approve return with discount code creation (admin)
app.post('/api/admin/approve-return-with-discount', authenticateAdmin, async (req, res) => {
    try {
        const { 
            requestId, 
            notes, 
            discountCode,      // e.g., "RETURN10" or "REFUND500"
            discountValue,     // e.g., 10 (for 10%) or 500 (for ₹500)
            discountType,      // 'percentage' or 'fixed'
            usageLimit,        // optional, null = unlimited
            sendWhatsApp,      // boolean: send via WhatsApp?
            whatsappPhone      // optional: edited phone number
        } = req.body;

        // 1. Validate request exists and is in 'delivered' status (final approval only)
        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }
        if (requestDetails.status !== 'delivered') {
            return res.status(400).json({ 
                error: 'Can only approve with discount for delivered returns' 
            });
        }
        if (requestDetails.type !== 'return') {
            return res.status(400).json({ error: 'Only for return requests' });
        }

        // 2. Create Shopify discount code (auto-generate if not provided)
        let shopifyResult = null;
        let discountCodeGenerated = null;
        
        if (discountValue) {
            const finalCode = discountCode || `RETURN${requestId.slice(-6).toUpperCase()}`;
            const valueType = discountType === 'fixed' ? 'fixed_amount' : 'percentage';
            const title = `Return Compensation: ${requestDetails.orderNumber}`;
            
            console.log(`[approve-discount][${requestId}] Creating Shopify discount: code=${finalCode}, value=${discountValue}, type=${valueType}, usage=${usageLimit || 'unlimited'}`);
            shopifyResult = await createCompensationDiscountCode(
                finalCode,
                parseFloat(discountValue),
                valueType,
                usageLimit || null,
                title
            );
            
            discountCodeGenerated = finalCode.toUpperCase();
            console.log(`[approve-discount][${requestId}] ✅ Shopify discount created: ${discountCodeGenerated} (value=${discountValue}, type=${valueType})`);
        }

        // 3. Update request status to 'approved' with discount info
        let adminNotes = notes || '';
        if (discountCodeGenerated) {
            adminNotes += `\n--- Discount Code Issued ---\nCode: ${discountCodeGenerated}\nValue: ${discountType === 'fixed' ? '₹' + discountValue : discountValue + '%'}\nUsage Limit: ${usageLimit || 'Unlimited'}`;
        }

        const request = await updateRequestStatus(requestId, {
            status: 'approved',
            adminNotes,
            discountCode: discountCodeGenerated || null,
            discountValue: discountValue || null,
            discountType: discountType || null,
            approvedAt: new Date().toISOString()
        });

        // Zoho middleware: notify return for credit note (fire-and-forget)
        let zohoReturnItems = requestDetails.items;
        if (typeof zohoReturnItems === 'string') {
            try { zohoReturnItems = JSON.parse(zohoReturnItems); } catch (e) { zohoReturnItems = []; }
        }
        notifyZohoReturn(requestDetails, Array.isArray(zohoReturnItems) ? zohoReturnItems : [])
            .catch(e => console.warn('[' + requestId + '] Zoho return notify failed: ' + e.message));

        // 4. Send WhatsApp notification if requested
        let whatsappSent = false;
        let whatsappMessageId = null;
        let whatsappError = null;
        
        if (sendWhatsApp && discountCodeGenerated) {
            const phoneToSend = whatsappPhone || requestDetails.customerPhone;
            if (phoneToSend) {
                const valueTypeLabel = discountType === 'fixed' ? `₹${discountValue}` : `${discountValue}%`;
                const customerName = requestDetails.customerName || 'Valued Customer';
                const message = `Hi ${customerName}! 👋\n\nGreat news! Your return for order *${requestDetails.orderNumber}* has been approved and processed successfully. ✅\n\n🎁 *Your Exclusive Compensation:*\n━━━━━━━━━━━━━━━━━\n💰 Discount Code: *${discountCodeGenerated}*\n💎 Value: ${valueTypeLabel}\n📝 Usage: ${usageLimit ? usageLimit + ' time(s)' : 'Unlimited'}\n━━━━━━━━━━━━━━━━━\n\nSimply apply this code at checkout on any product in our store!\n\nThank you for your patience and trust in us. We look forward to serving you again! 🙏\n\nNeed help? Reply to this message.`;
                
                try {
                    const whatsappResult = await sendWhatsAppNotification(
                        phoneToSend,
                        message,
                        'return_approved_with_discount',
                        requestId,
                        {
                            templateName: 'return_approved_discount',
                            customerName: customerName,
                            orderNumber: requestDetails.orderNumber,
                            discountCode: discountCodeGenerated,
                            value: discountValue,
                            valueType: discountType === 'fixed' ? 'fixed_amount' : 'percentage',
                            usage: usageLimit ? `${usageLimit} time(s)` : 'Unlimited'
                        }
                    );
                    
                    whatsappSent = true;
                    whatsappMessageId = whatsappResult?.messageId || null;
                    console.log(`[approve-discount][${requestId}] ✅ WhatsApp template sent successfully. Message ID: ${whatsappMessageId}`);
                    
                    // Update database with WhatsApp status
                    await updateRequestStatus(requestId, {
                        whatsappSent: true,
                        whatsappMessageId: whatsappMessageId,
                        whatsappSentAt: new Date().toISOString()
                    });
                } catch (error) {
                    whatsappError = error.message;
                    console.error(`[approve-discount][${requestId}] ❌ WhatsApp send failed:`, error.message);
                    
                    // Update database with error
                    await updateRequestStatus(requestId, {
                        whatsappSent: false,
                        whatsappError: error.message
                    });
                }
            }
        }

        res.json({ 
            success: true, 
            message: 'Return approved with discount code',
            discountCode: discountCodeGenerated,
            whatsappSent,
            whatsappMessageId,
            whatsappError,
            request 
        });
    } catch (error) {
        console.error('Approve return with discount error:', error);
        res.status(500).json({ 
            error: 'Failed to approve return with discount: ' + error.message 
        });
    }
});

// ==================== RESOLVE EXCHANGE (exchange / refund / store_credit) ====================
// Replaces the "approve exchange" path for requests in delivered/inspected status.
// Admin chooses one of three resolutions: dispatch replacement, issue refund, or issue store credit.
app.post('/api/admin/resolve-exchange', authenticateAdmin, async (req, res) => {
    try {
        const {
            requestId,
            resolution,         // 'exchange' | 'refund' | 'store_credit'
            notes,
            carrierOverride,
            discountValue,
            discountType,
            discountCode,
            usageLimit,
            sendWhatsApp,
            whatsappPhone
        } = req.body;

        if (!['exchange', 'refund', 'store_credit'].includes(resolution)) {
            return res.status(400).json({ error: 'Invalid resolution. Must be exchange, refund, or store_credit.' });
        }

        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Only allow resolution for exchanges/returns in delivered/inspected status
        if (!['exchange', 'return'].includes(requestDetails.type)) {
            return res.status(400).json({ error: 'Resolution is only available for exchange and return requests' });
        }
        if (!['delivered', 'inspected'].includes(requestDetails.status)) {
            return res.status(400).json({ error: 'Can only resolve exchanges in delivered or inspected status' });
        }

        let adminNotes = notes || '';
        const existingHistory = Array.isArray(requestDetails.requestHistory) ? [...requestDetails.requestHistory] : [];
        const historyEntry = {
            action: 'resolution_selected',
            resolution,
            notes: adminNotes || null,
            timestamp: new Date().toISOString(),
            by: 'admin'
        };

        // ── Resolution: EXCHANGE (dispatch replacement) ──
        if (resolution === 'exchange') {
            console.log(`[${requestId}] Resolving exchange: dispatching replacement...`);

            const carrierMode = await getCarrierMode('dispatch');
            const carrierResolution = resolveCarrier(carrierMode, carrierOverride || null, 'dispatch');
            console.log(`[${requestId}] Forward carrier: ${carrierResolution.primary}${carrierResolution.useFallback ? ' (with fallback)' : ''}`);

            let items = requestDetails.items;
            if (typeof items === 'string') {
                try { items = JSON.parse(items); } catch (e) { items = []; }
            }

            let forwardOrder = null;
            let carrierUsed = null;
            const primaryCarrier = carrierResolution.primary;
            const useFallback = carrierResolution.useFallback;
            const fallbackCarrier = carrierResolution.fallback || getFallbackCarrier(primaryCarrier);

            try {
                const primaryResult = await forwardBookingAttempt(primaryCarrier, { ...requestDetails, items });
                forwardOrder = primaryResult.forwardOrder;
                carrierUsed = primaryResult.carrierUsed;
            } catch (primaryError) {
                if (useFallback) {
                    try {
                        const fallbackResult = await forwardBookingAttempt(fallbackCarrier, { ...requestDetails, items });
                        forwardOrder = fallbackResult.forwardOrder;
                        carrierUsed = fallbackResult.carrierUsed;
                    } catch (fallbackError) {
                        forwardOrder = null;
                    }
                } else {
                    forwardOrder = null;
                }
            }

            if (forwardOrder && (forwardOrder.shipment_id || forwardOrder.waybill)) {
                const shipmentInfo = carrierUsed === 'shiprocket'
                    ? `Shiprocket ID: ${forwardOrder.shipment_id}`
                    : `${carrierUsed === 'ekart' ? 'Ekart' : 'Delhivery'} AWB: ${forwardOrder.waybill}`;
                adminNotes += `\nResolution: EXCHANGE — Replacement Shipment Created (${carrierUsed}: ${shipmentInfo})`;
                existingHistory.push(historyEntry);
                existingHistory.push(exchangeDispatches.dispatchEvent(requestDetails, carrierUsed,
                    forwardOrder.shipment_id || forwardOrder.order_id,
                    forwardOrder.awb_code || forwardOrder.waybill, items));

                const request = await updateRequestStatus(requestId, {
                    status: 'approved',
                    resolution: 'exchange',
                    adminNotes,
                    requestHistory: existingHistory,
                    forwardShipmentId: String(forwardOrder.shipment_id || forwardOrder.order_id),
                    forwardAwbNumber: forwardOrder.awb_code || forwardOrder.waybill || '',
                    forwardStatus: 'scheduled',
                    forwardCarrier: carrierUsed
                });

                // Notify Zoho
                let zohoItems = requestDetails.items;
                if (typeof zohoItems === 'string') { try { zohoItems = JSON.parse(zohoItems); } catch (e) { zohoItems = []; } }
                notifyZohoExchange(requestDetails, Array.isArray(zohoItems) ? zohoItems : []).catch(() => {});

                return res.json({ success: true, message: 'Exchange resolved: replacement dispatched', resolution: 'exchange', request });
            } else {
                adminNotes += `\nResolution: EXCHANGE — Failed to create forward shipment. Check logs.`;
                existingHistory.push({ ...historyEntry, resolution: 'exchange_failed', notes: adminNotes });
                return res.status(500).json({
                    success: false,
                    error: 'Failed to create forward shipment. Please check logs and try again.',
                    requestId
                });
            }
        }

        // ── Resolution: REFUND (Shopify refund) ──
        if (resolution === 'refund') {
            console.log(`[${requestId}] Resolving exchange: issuing Shopify refund...`);

            // Calculate refund amount from items
            let items = requestDetails.items;
            if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
            const refundAmount = (Array.isArray(items) ? items : []).reduce((sum, item) => {
                const price = parseFloat(item.paidPrice || item.price || 0);
                const qty = parseInt(item.quantity || 1);
                return sum + (price * qty);
            }, 0) + (parseFloat(requestDetails.codCharges) || 0);

            if (refundAmount <= 0) {
                return res.status(400).json({ error: 'Cannot calculate refund amount from items' });
            }

            const refundResult = await createShopifyRefund(
                requestDetails.orderNumber,
                refundAmount,
                'customer',
                `Return/Exchange resolution: Refund for ${requestId}`
            );

            if (refundResult.success) {
                adminNotes += `\nResolution: REFUND — Shopify refund of ₹${refundAmount} issued (Refund ID: ${refundResult.refundId})`;
                existingHistory.push(historyEntry);

                const request = await updateRequestStatus(requestId, {
                    status: 'approved',
                    resolution: 'refund',
                    adminNotes,
                    requestHistory: existingHistory
                });

                return res.json({
                    success: true,
                    message: 'Exchange resolved: refund issued',
                    resolution: 'refund',
                    refundId: refundResult.refundId,
                    refundAmount,
                    request
                });
            } else {
                existingHistory.push({ ...historyEntry, resolution: 'refund_failed', notes: refundResult.error });
                return res.status(500).json({
                    success: false,
                    error: `Shopify refund failed: ${refundResult.error}`,
                    requestId
                });
            }
        }

        // ── Resolution: STORE CREDIT (Shopify discount code) ──
        if (resolution === 'store_credit') {
            console.log(`[${requestId}] Resolving exchange: issuing store credit...`);

            if (!discountValue || parseFloat(discountValue) <= 0) {
                return res.status(400).json({ error: 'Discount value is required for store credit resolution' });
            }

            const finalCode = discountCode || `CREDIT${requestId.slice(-6).toUpperCase()}`;
            const valueType = discountType === 'fixed' ? 'fixed_amount' : 'percentage';
            const title = `Store Credit: ${requestDetails.orderNumber}`;

            const shopifyResult = await createCompensationDiscountCode(
                finalCode,
                parseFloat(discountValue),
                valueType,
                usageLimit || null,
                title
            );

            const discountCodeGenerated = finalCode.toUpperCase();
            adminNotes += `\nResolution: STORE CREDIT — Discount Code: ${discountCodeGenerated} (${discountType === 'fixed' ? '₹' : ''}${discountValue}${discountType === 'percentage' ? '%' : ''})`;
            existingHistory.push(historyEntry);

            const request = await updateRequestStatus(requestId, {
                status: 'approved',
                resolution: 'store_credit',
                adminNotes,
                requestHistory: existingHistory,
                discountCode: discountCodeGenerated,
                discountValue: parseFloat(discountValue),
                discountType: discountType || 'fixed'
            });

            // Send WhatsApp notification if requested
            let whatsappSent = false;
            let whatsappMessageId = null;
            let whatsappError = null;

            if (sendWhatsApp && discountCodeGenerated) {
                const phoneToSend = whatsappPhone || requestDetails.customerPhone;
                if (phoneToSend) {
                    const valueTypeLabel = discountType === 'fixed' ? `₹${discountValue}` : `${discountValue}%`;
                    const customerName = requestDetails.customerName || 'Valued Customer';
                    const message = `Hi ${customerName}! 👋\n\nYour return/exchange for order *${requestDetails.orderNumber}* has been processed. ✅\n\n🎁 *Your Store Credit:*\n━━━━━━━━━━━━━━━━━\n💰 Code: *${discountCodeGenerated}*\n💎 Value: ${valueTypeLabel}\n━━━━━━━━━━━━━━━━━\n\nApply this code at checkout!\n\nThank you for shopping with us! 🙏`;

                    try {
                        const waResult = await sendWhatsAppNotification(
                            phoneToSend, message, 'store_credit_issued', requestId,
                            { customerName, orderNumber: requestDetails.orderNumber, discountCode: discountCodeGenerated }
                        );
                        whatsappSent = true;
                        whatsappMessageId = waResult?.messageId || null;
                        await updateRequestStatus(requestId, {
                            whatsappSent: true,
                            whatsappMessageId,
                            whatsappSentAt: new Date().toISOString()
                        });
                    } catch (waErr) {
                        whatsappError = waErr.message;
                        await updateRequestStatus(requestId, { whatsappSent: false, whatsappError: waErr.message });
                    }
                }
            }

            return res.json({
                success: true,
                message: 'Exchange resolved: store credit issued',
                resolution: 'store_credit',
                discountCode: discountCodeGenerated,
                whatsappSent,
                whatsappMessageId,
                whatsappError,
                request
            });
        }
    } catch (error) {
        console.error('Resolve exchange error:', error);
        res.status(500).json({ error: 'Failed to resolve exchange: ' + error.message });
    }
});

// ==================== CONVERT RETURN TO EXCHANGE ====================
// Converts an existing return request into an exchange by adding replacement item data.
app.post('/api/admin/convert-to-exchange', authenticateAdmin, async (req, res) => {
    try {
        const { requestId, replacementItems, notes } = req.body;

        if (!replacementItems || !Array.isArray(replacementItems) || replacementItems.length === 0) {
            return res.status(400).json({ error: 'replacementItems array is required' });
        }

        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (requestDetails.type !== 'return') {
            return res.status(400).json({ error: 'Only return requests can be converted to exchange' });
        }

        if (['approved', 'rejected', 'cancelled'].includes(requestDetails.status)) {
            return res.status(400).json({ error: `Cannot convert a ${requestDetails.status} request` });
        }

        // Merge replacement data into existing items
        let items = requestDetails.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
        if (!Array.isArray(items)) items = [];

        const updatedItems = items.map((item, idx) => {
            const replacement = replacementItems[idx] || replacementItems[0];
            if (!replacement) return item;
            return {
                ...item,
                replacementProductId: replacement.productId || replacement.product_id || null,
                replacementVariantId: replacement.variantId || replacement.variant_id || null,
                replacementProductTitle: replacement.variantTitle || replacement.productTitle || replacement.title || item.name,
                replacementVariant: replacement.variantTitle || replacement.variant_title || replacement.variant || '',
                replacementPrice: replacement.price || item.price,
                replacementProductImage: replacement.image || item.image || null
            };
        });

        // Build history
        const existingHistory = Array.isArray(requestDetails.requestHistory) ? [...requestDetails.requestHistory] : [];
        existingHistory.push({
            action: 'converted_to_exchange',
            from_type: 'return',
            to_type: 'exchange',
            notes: notes || null,
            timestamp: new Date().toISOString(),
            by: 'admin'
        });

        let adminNotes = requestDetails.adminNotes || '';
        adminNotes += `\n--- Converted from Return to Exchange by Admin ---\nReplacement items: ${replacementItems.length} item(s) selected`;
        if (notes) adminNotes += `\nNotes: ${notes}`;

        // Update the request
        const request = await updateRequestStatus(requestId, {
            type: 'exchange',
            originalType: 'return',
            adminNotes,
            requestHistory: existingHistory,
            items: JSON.stringify(updatedItems)
        });

        console.log(`[${requestId}] ✅ Converted return to exchange with ${replacementItems.length} replacement item(s)`);

        res.json({
            success: true,
            message: 'Return converted to exchange successfully',
            request
        });
    } catch (error) {
        console.error('Convert to exchange error:', error);
        res.status(500).json({ error: 'Failed to convert: ' + error.message });
    }
});

// ==================== SHOPIFY ORDER LOOKUP (for admin modals) ====================
app.get('/api/shopify/order/:orderNumber', authenticateAdmin, async (req, res) => {
    try {
        const { orderNumber } = req.params;
        const orderName = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
        let orderData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=1`);

        if (!orderData.orders || orderData.orders.length === 0) {
            const bare = orderNumber.replace(/^#/, '');
            orderData = await shopifyAPI(`orders.json?name=${encodeURIComponent(bare)}&status=any&limit=1`);
        }

        if (!orderData.orders || orderData.orders.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderData.orders[0];
        res.json({
            id: order.id,
            name: order.name,
            line_items: (order.line_items || []).map(li => ({
                product_id: li.product_id,
                variant_id: li.variant_id,
                title: li.title,
                variant_title: li.variant_title,
                price: li.price,
                quantity: li.quantity,
                image: li.image
            }))
        });
    } catch (error) {
        console.error('Shopify order lookup error:', error);
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

// ==================== ALL PRODUCTS FOR EXCHANGE SELECTOR ====================
// Returns all active store products with variants for the convert-to-exchange modal
app.get('/api/admin/products-for-exchange', authenticateAdmin, async (req, res) => {
    try {
        const allProducts = await fetchAllShopifyProducts();
        const productsWithInventory = filterProductsWithInventory(allProducts);

        // Flatten: each variant becomes a selectable option
        const options = [];
        for (const product of productsWithInventory) {
            for (const variant of (product.variants || [])) {
                options.push({
                    productId: String(product.id),
                    variantId: String(variant.id),
                    productTitle: product.title || '',
                    variantTitle: variant.title || '',
                    price: variant.price || '0',
                    image: (product.image && product.image.src) || (product.images && product.images[0] && product.images[0].src) || ''
                });
            }
        }

        res.json({ success: true, products: options, total: options.length });
    } catch (error) {
        console.error('Products for exchange error:', error);
        res.status(500).json({ error: 'Failed to fetch products: ' + error.message, products: [] });
    }
});

// ── Athlete Products (for product request sheet) ──
app.get('/api/athlete-products', async (req, res) => {
    try {
        const allProducts = await fetchAllShopifyProducts();
        const products = allProducts.map(p => ({
            id: String(p.id),
            title: p.title || '',
            handle: p.handle || '',
            product_type: p.product_type || '',
            vendor: p.vendor || '',
            image: (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '',
            variants: (p.variants || []).map(v => ({
                id: String(v.id),
                title: v.title || 'Default',
                price: v.price || '0',
                available: v.inventory_quantity > 0 || v.inventory_policy === 'continue'
            }))
        }));
        res.json({ success: true, products, total: products.length });
    } catch (error) {
        console.error('Athlete products error:', error);
        res.status(500).json({ error: 'Failed to fetch products: ' + error.message, products: [] });
    }
});

// ── Send Coupon Code (create discount + send WhatsApp message, no status change) ──
app.post('/api/admin/send-coupon-code', authenticateAdmin, async (req, res) => {
    try {
        const {
            requestId,
            discountCode,
            discountValue,
            discountType,
            usageLimit,
            sendWhatsApp,
            whatsappPhone
        } = req.body;

        if (!requestId) {
            return res.status(400).json({ error: 'Request ID is required' });
        }
        if (!discountValue || parseFloat(discountValue) <= 0) {
            return res.status(400).json({ error: 'Discount value is required' });
        }

        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // 1. Create Shopify discount code
        const finalCode = discountCode || `RETURN${requestId.slice(-6).toUpperCase()}`;
        const valueType = discountType === 'fixed' ? 'fixed_amount' : 'percentage';
        const title = `Return Compensation: ${requestDetails.orderNumber}`;

        console.log(`[send-coupon][${requestId}] Creating Shopify discount: code=${finalCode}, value=${discountValue}, type=${valueType}, usage=${usageLimit || 'unlimited'}`);

        let shopifyResult = null;
        try {
            shopifyResult = await createCompensationDiscountCode(
                finalCode,
                parseFloat(discountValue),
                valueType,
                usageLimit || null,
                title
            );
            console.log(`[send-coupon][${requestId}] ✅ Shopify discount created: ${finalCode.toUpperCase()} (value=${discountValue}, type=${valueType})`);
        } catch (shopifyError) {
            console.error(`[send-coupon][${requestId}] ❌ Shopify discount creation failed:`, shopifyError.message);
            return res.status(500).json({ error: 'Failed to create discount code in Shopify: ' + shopifyError.message });
        }

        const discountCodeGenerated = finalCode.toUpperCase();

        // 2. Save coupon info to request notes (without changing status)
        const couponNote = `\n--- Coupon Code Sent ---\nCode: ${discountCodeGenerated}\nValue: ${discountType === 'fixed' ? '₹' + discountValue : discountValue + '%'}\nUsage Limit: ${usageLimit || 'Unlimited'}\nSent At: ${new Date().toLocaleString('en-IN')}`;
        const existingNotes = requestDetails.adminNotes || '';
        await updateRequestStatus(requestId, {
            adminNotes: existingNotes + couponNote,
            discountCode: discountCodeGenerated,
            discountValue: parseFloat(discountValue),
            discountType: discountType || 'percentage'
        });

        // 3. Send WhatsApp notification if requested
        let whatsappSent = false;
        let whatsappMessageId = null;
        let whatsappError = null;

        if (sendWhatsApp) {
            const phoneToSend = whatsappPhone || requestDetails.customerPhone;
            if (phoneToSend) {
                const valueTypeLabel = discountType === 'fixed' ? `₹${discountValue}` : `${discountValue}%`;
                const customerName = requestDetails.customerName || 'Valued Customer';
                const message = `Hi ${customerName}! 👋\n\nGreat news! Your return for order *${requestDetails.orderNumber}* has been approved and processed successfully. ✅\n\n🎁 *Your Exclusive Compensation:*\n━━━━━━━━━━━━━━━━━\n💰 Discount Code: *${discountCodeGenerated}*\n💎 Value: ${valueTypeLabel}\n📝 Usage: ${usageLimit ? usageLimit + ' time(s)' : 'Unlimited'}\n━━━━━━━━━━━━━━━━━\n\nSimply apply this code at checkout on any product in our store!\n\nThank you for your patience and trust in us. We look forward to serving you again! 🙏\n\nNeed help? Reply to this message.`;

                try {
                    const whatsappResult = await sendWhatsAppNotification(
                        phoneToSend,
                        message,
                        'return_approved_with_discount',
                        requestId,
                        {
                            templateName: 'return_approved_discount',
                            customerName: customerName,
                            orderNumber: requestDetails.orderNumber,
                            discountCode: discountCodeGenerated,
                            value: parseFloat(discountValue),
                            valueType: discountType === 'fixed' ? 'fixed_amount' : 'percentage',
                            usage: usageLimit ? `${usageLimit} time(s)` : 'Unlimited'
                        }
                    );

                    whatsappSent = true;
                    whatsappMessageId = whatsappResult?.messageId || null;
                    console.log(`[send-coupon][${requestId}] ✅ WhatsApp template sent. Message ID: ${whatsappMessageId}`);
                } catch (error) {
                    whatsappError = error.message;
                    console.error(`[send-coupon][${requestId}] ❌ WhatsApp send failed:`, error.message);
                }
            } else {
                whatsappError = 'No phone number available';
            }
        }

        res.json({
            success: true,
            message: 'Coupon code created and message sent',
            discountCode: discountCodeGenerated,
            discountValue: parseFloat(discountValue),
            discountType: discountType || 'percentage',
            whatsappSent,
            whatsappMessageId,
            whatsappError
        });
    } catch (error) {
        console.error('Send coupon code error:', error);
        res.status(500).json({ error: 'Failed to send coupon: ' + error.message });
    }
});

// Reset pickup to pending (for fixing failed carrier bookings)
app.post('/api/admin/reset-pickup', authenticateAdmin, async (req, res) => {
    try {
        const { requestId } = req.body;
        
        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }
        
        // Allow reverting a pickup from any status where a pickup was attempted/booked.
        // Useful when a carrier pickup gets cancelled and admin needs to start over.
        const revertableStatuses = ['pickup_pending', 'pickup_booked', 'scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'cancelled', 'failed'];
        if (!revertableStatuses.includes(requestDetails.status)) {
            return res.status(400).json({ error: `Cannot revert pickup from status: ${requestDetails.status}` });
        }
        
        const adminNotes = (requestDetails.adminNotes || '') + 
            `\n[SYSTEM] Pickup reverted to pending by admin (was: ${requestDetails.status}, carrier: ${requestDetails.carrier || 'unknown'}, AWB: ${requestDetails.awbNumber || requestDetails.carrierAwb || 'none'})`;
        
        const request = await updateRequestStatus(requestId, {
            status: 'pending',
            carrier: null,
            carrierAwb: null,
            carrierShipmentId: null,
            awbNumber: null,
            shipmentId: null,
            pickupDate: null,
            adminNotes
        });
        
        res.json({ 
            success: true, 
            message: 'Request reset to pending status',
            request
        });
    } catch (error) {
        console.error('Reset pickup error:', error);
        res.status(500).json({ error: 'Failed to reset pickup' });
    }
});

// Mark request as delivered/received manually (admin override)
app.post('/api/admin/mark-delivered', authenticateAdmin, async (req, res) => {
    try {
        const { requestId } = req.body;
        console.log(`[${requestId}] Manual Override: Marking as Delivered`);

        const request = await updateRequestStatus(requestId, {
            status: 'delivered',
            deliveredAt: new Date().toISOString()
        });

        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        res.json({ success: true, message: 'Request marked as delivered/received', request });

    } catch (error) {
        console.error('Mark delivered error:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Re-dispatch cancelled or failed orders (admin)
app.post('/api/admin/redispatch', authenticateAdmin, async (req, res) => {
    try {
        const { requestId, carrierOverride } = req.body;
        
        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }
        
        // Only allow re-dispatch for cancelled or failed orders
        if (requestDetails.status !== 'cancelled' && requestDetails.status !== 'failed') {
            return res.status(400).json({ 
                error: 'Can only re-dispatch cancelled or failed orders',
                currentStatus: requestDetails.status
            });
        }
        
        console.log(`[${requestId}] RE-DISPATCHING order (was ${requestDetails.status}). Previous carrier: ${requestDetails.carrier || 'none'}`);
        
        // Clear previous carrier info and reset to pending for re-processing
        const adminNotes = (requestDetails.adminNotes || '') + 
            `\n[SYSTEM] Order re-dispatched by admin from ${requestDetails.status} status (Previous carrier: ${requestDetails.carrier || 'none'})`;
        
        const request = await updateRequestStatus(requestId, {
            status: 'pending',
            carrier: null,
            carrierAwb: null,
            carrierShipmentId: null,
            awbNumber: null,
            shipmentId: null,
            pickupDate: null,
            forwardAwbNumber: null,
            forwardShipmentId: null,
            adminNotes
        });
        
        res.json({ 
            success: true, 
            message: 'Order reset to pending for re-dispatch. You can now approve it again.',
            request
        });
    } catch (error) {
        console.error('Re-dispatch error:', error);
        res.status(500).json({ error: 'Failed to re-dispatch order' });
    }
});

// ── Reusable helper: book a fresh return pickup with primary + optional fallback carrier ──
// Returns { carrierUsed, awbNumber, shipmentId, pickupDate, fallbackReason } or throws.
async function bookReturnPickup(requestDetails, requestId, carrierOverride = null, options = {}) {
    const carrierMode = await getCarrierMode('pickup');
    const carrierResolution = resolveCarrier(carrierMode, carrierOverride, 'pickup');
    console.log(`[${requestId}] bookReturnPickup: carrier mode ${carrierMode}, resolution`, carrierResolution);

    // Optional unique suffix for the Delhivery order id so a fresh/duplicate pickup is not
    // rejected as a "Duplicate order id" (which would silently re-adopt the stale waybill).
    const delhiveryOrderIdSuffix = options.delhiveryOrderIdSuffix || '';

    // Best-effort Shopify order fetch (don't block on failure)
    let shopifyOrder = null;
    try {
        let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(requestDetails.orderNumber)}&status=any&limit=1`);
        if (!shopifyData.orders || shopifyData.orders.length === 0) {
            const alt = requestDetails.orderNumber.startsWith('#')
                ? requestDetails.orderNumber.substring(1)
                : '#' + requestDetails.orderNumber;
            shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(alt)}&status=any&limit=1`);
        }
        shopifyOrder = shopifyData.orders && shopifyData.orders[0];
    } catch (err) {
        console.warn(`[${requestId}] bookReturnPickup Shopify fetch failed, using stored data:`, err.message);
    }

    const { primary: carrierToUse, useFallback, fallback: configuredFallback } = carrierResolution;
    const fallbackCarrier = configuredFallback || getFallbackCarrier(carrierToUse);

    const attempt = (carrier) => returnBookingAttempt(carrier, {
        ...requestDetails,
        requestId,
        orderNumber: requestDetails.orderNumber,
        customerPhone: requestDetails.customerPhone,
        delhiveryOrderIdSuffix
    }, shopifyOrder);

    let result = null;
    let fallbackReason = null;
    try {
        result = await attempt(carrierToUse);
    } catch (primaryError) {
        if (!useFallback) throw primaryError;
        fallbackReason = `${carrierToUse} failed: ${primaryError.message}`;
        console.warn(`[${requestId}] ⚠️ ${carrierToUse} failed, falling back to ${fallbackCarrier}:`, primaryError.message);
        try {
            result = await attempt(fallbackCarrier);
        } catch (fallbackError) {
            throw new Error(`Both carriers failed: ${primaryError.message} | ${fallbackError.message}`);
        }
    }

    if (!result || !result.carrierUsed) throw new Error('No carrier was used');
    return { ...result, fallbackReason };
}

// Create a fresh (duplicate) return pickup for a request regardless of current status.
// Useful when a previously booked pickup was cancelled by the carrier.
app.post('/api/admin/create-duplicate-pickup', authenticateAdmin, async (req, res) => {
    try {
        const { requestId, carrierOverride } = req.body;

        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const prevAwb = requestDetails.awbNumber || requestDetails.carrierAwb || 'none';
        console.log(`[${requestId}] Creating DUPLICATE pickup (current status: ${requestDetails.status}, previous carrier: ${requestDetails.carrier || 'none'}, previous AWB: ${prevAwb})`);

        // Delhivery rejects a re-used order id ("Duplicate order id") and echoes back the
        // stale waybill, so a fresh pickup must carry a unique order id. Derive the next
        // retry number from how many duplicate pickups were previously logged for this request.
        const priorDuplicateCount = ((requestDetails.adminNotes || '').match(/\[SYSTEM\] Duplicate pickup created/g) || []).length;
        const retryNumber = priorDuplicateCount + 1;
        const delhiveryOrderIdSuffix = `-R${retryNumber}`;

        const booking = await bookReturnPickup(requestDetails, requestId, carrierOverride || null, { delhiveryOrderIdSuffix });

        let adminNotes = requestDetails.adminNotes || '';
        adminNotes += `\n[SYSTEM] Duplicate pickup created via ${booking.carrierUsed}: AWB ${booking.awbNumber || 'Pending'} (previous AWB: ${prevAwb}). Previous booking may remain in carrier system.`;
        if (booking.fallbackReason) adminNotes += `\nFallback: ${booking.fallbackReason}`;

        const request = await updateRequestStatus(requestId, {
            shipmentId: booking.shipmentId,
            awbNumber: booking.awbNumber,
            pickupDate: booking.pickupDate,
            status: 'pickup_booked',
            adminNotes,
            carrier: booking.carrierUsed,
            carrierShipmentId: booking.shipmentId,
            carrierAwb: booking.awbNumber,
            carrierFallbackReason: booking.fallbackReason || null
        });

        // ── Send approval WhatsApp message (non-blocking) ──
        sendReturnExchangeApprovalWhatsApp({
            phone: requestDetails.customerPhone,
            requestId,
            orderNumber: requestDetails.orderNumber,
            type: requestDetails.type
        }).then(waResult => {
            if (waResult?.success) {
                updateRequestStatus(requestId, {
                    whatsappSent: true,
                    whatsappMessageId: waResult.messageId || null,
                    whatsappSentAt: new Date().toISOString()
                }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
            }
        }).catch(() => {}); // fire-and-forget

        res.json({
            success: true,
            message: `Duplicate pickup created via ${booking.carrierUsed}. New AWB: ${booking.awbNumber || 'Pending'}`,
            request
        });
    } catch (error) {
        console.error('Create duplicate pickup error:', error);
        res.status(500).json({ error: 'Failed to create duplicate pickup: ' + error.message });
    }
});

// Create a fresh (duplicate) forward/replacement shipment for an approved exchange.
// Useful when the original forward order was cancelled or lost by the carrier.
app.post('/api/admin/create-duplicate-forward', authenticateAdmin, async (req, res) => {
    try {
        const { requestId, carrierOverride } = req.body;

        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }
        if (requestDetails.type !== 'exchange') {
            return res.status(400).json({ error: 'Duplicate forward orders are only available for exchange requests' });
        }

        const prevForwardAwb = requestDetails.forwardAwbNumber || 'none';
        console.log(`[${requestId}] Creating DUPLICATE forward order (previous forward AWB: ${prevForwardAwb})`);

        // Parse replacement items
        let items = requestDetails.items;
        if (typeof items === 'string') {
            try { items = JSON.parse(items); } catch (e) { items = []; }
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'No replacement items found on this request' });
        }

        // Carriers reject re-used order ids, so tag the duplicate with a unique -R{n} suffix.
        // Derive the retry number from how many duplicate forward orders were previously logged.
        const priorDuplicateCount = ((requestDetails.adminNotes || '').match(/\[SYSTEM\] Duplicate forward order created/g) || []).length;
        const forwardOrderIdSuffix = `-R${priorDuplicateCount + 1}`;

        const carrierMode = await getCarrierMode('dispatch');
        const carrierResolution = resolveCarrier(carrierMode, carrierOverride || null, 'dispatch');
        const primaryCarrier = carrierResolution.primary;
        const useFallback = carrierResolution.useFallback;
        const fallbackCarrier = carrierResolution.fallback || getFallbackCarrier(primaryCarrier);

        const attempt = (carrier) => forwardBookingAttempt(carrier, { ...requestDetails, items, forwardOrderIdSuffix });

        let result = null;
        let fallbackReason = null;
        try {
            result = await attempt(primaryCarrier);
        } catch (primaryError) {
            if (!useFallback) throw primaryError;
            fallbackReason = `${primaryCarrier} failed: ${primaryError.message}`;
            console.warn(`[${requestId}] ⚠️ ${primaryCarrier} failed for duplicate forward, falling back to ${fallbackCarrier}:`, primaryError.message);
            try {
                result = await attempt(fallbackCarrier);
            } catch (fallbackError) {
                throw new Error(`Both carriers failed: ${primaryError.message} | ${fallbackError.message}`);
            }
        }

        const { carrierUsed, forwardOrder } = result;
        const newAwb = forwardOrder.awb_code || forwardOrder.waybill || '';

        let adminNotes = requestDetails.adminNotes || '';
        adminNotes += `\n[SYSTEM] Duplicate forward order created via ${carrierUsed}: AWB ${newAwb || 'Pending'} (previous forward AWB: ${prevForwardAwb}). Previous shipment may remain in carrier system.`;
        if (fallbackReason) adminNotes += `\nFallback: ${fallbackReason}`;

        const request = await updateRequestStatus(requestId, {
            forwardShipmentId: String(forwardOrder.shipment_id || forwardOrder.order_id),
            forwardAwbNumber: newAwb,
            forwardStatus: 'scheduled',
            forwardCarrier: carrierUsed,
            requestHistory: [
                ...(Array.isArray(requestDetails.requestHistory) ? requestDetails.requestHistory : []),
                exchangeDispatches.dispatchEvent(requestDetails, carrierUsed,
                    forwardOrder.shipment_id || forwardOrder.order_id, newAwb, items)
            ],
            adminNotes
        });

        res.json({
            success: true,
            message: `Duplicate forward order created via ${carrierUsed}. New AWB: ${newAwb || 'Pending'}`,
            request
        });
    } catch (error) {
        console.error('Create duplicate forward order error:', error);
        res.status(500).json({ error: 'Failed to create duplicate forward order: ' + error.message });
    }
});

// ── Admin: Update exchange details (items, phone, address) ──
app.put('/api/admin/update-request/:requestId', authenticateAdmin, async (req, res) => {
    const requestId = req.params.requestId;
    const { items, customerPhone, newAddress, newCity, newPincode, newState, customerName, adminNotes } = req.body;
    
    console.log(`[ADMIN UPDATE] ${requestId} — Exchange details modification started`);
    console.log(`[ADMIN UPDATE] ${requestId} — Request body:`, { items: items?.length, customerPhone, newAddress, newCity, newState, newPincode, customerName });
    
    try {
        // Validate request exists
        const existingRequest = await getRequestById(requestId);
        if (!existingRequest) {
            console.log(`[ADMIN UPDATE] ${requestId} — Request not found`);
            return res.status(404).json({ error: 'Request not found' });
        }
        
        // Only allow modifications for exchange requests
        if (existingRequest.type !== 'exchange') {
            console.log(`[ADMIN UPDATE] ${requestId} — Not an exchange request (type: ${existingRequest.type})`);
            return res.status(400).json({ 
                error: 'Can only modify exchange requests' 
            });
        }
        
        // Only allow modifications for requests where forward shipment hasn't been dispatched yet
        // 'delivered' = return received at warehouse (forward not yet created) — ALLOW modifications
        // 'shipped' = forward dispatched, 'resolved' = completed — BLOCK modifications
        const blockedStatuses = ['shipped', 'resolved'];
        if (blockedStatuses.includes(existingRequest.status)) {
            console.log(`[ADMIN UPDATE] ${requestId} — Cannot modify request with status: ${existingRequest.status}`);
            return res.status(400).json({ 
                error: 'Cannot modify request after forward shipment has been dispatched' 
            });
        }
        
        const updateData = {};
        
        // Update items if provided
        if (items && Array.isArray(items) && items.length > 0) {
            // Validate each item has required fields
            for (const item of items) {
                if (!item.replacementVariantId || !item.replacementProductTitle) {
                    console.log(`[ADMIN UPDATE] ${requestId} — Invalid item data: missing replacementVariantId or replacementProductTitle`);
                    return res.status(400).json({ 
                        error: 'Each item must have replacementVariantId and replacementProductTitle' 
                    });
                }
            }
            updateData.items = JSON.stringify(items);
            console.log(`[ADMIN UPDATE] ${requestId} — Updating ${items.length} item(s)`);
        }
        
        // Update customer phone if provided
        if (customerPhone !== undefined) {
            updateData.customer_phone = customerPhone;
            console.log(`[ADMIN UPDATE] ${requestId} — Updating customer phone`);
        }
        
        // Update shipping address fields if provided
        if (newAddress !== undefined) updateData.new_address = newAddress;
        if (newCity !== undefined) updateData.new_city = newCity;
        if (newPincode !== undefined) updateData.new_pincode = newPincode;
        if (newState !== undefined) updateData.new_state = newState;
        if (customerName !== undefined) updateData.customer_name = customerName;
        
        // Verify at least one field is being updated
        if (Object.keys(updateData).length === 0) {
            console.log(`[ADMIN UPDATE] ${requestId} — No fields to update`);
            return res.status(400).json({ 
                error: 'No valid fields to update' 
            });
        }
        
        // Add audit trail with optional admin notes
        const timestamp = new Date().toISOString();
        let auditEntry = `[${timestamp}] Exchange details modified by admin`;
        if (adminNotes && adminNotes.trim()) {
            auditEntry += ` — Note: ${adminNotes.trim()}`;
        }
        auditEntry += '\n';
        updateData.admin_notes = auditEntry + (existingRequest.admin_notes || '');
        updateData.updated_at = timestamp;
        
        console.log(`[ADMIN UPDATE] ${requestId} — Update data:`, updateData);
        
        // Perform update
        const { data, error } = await supabase
            .from('requests')
            .update(updateData)
            .eq('request_id', requestId)
            .select()
            .single();
        
        if (error) {
            console.error(`[ADMIN UPDATE] ${requestId} — Database update error:`, error);
            return res.status(500).json({ error: 'Failed to update request' });
        }
        
        console.log(`[ADMIN UPDATE] ${requestId} — ✅ Successfully updated`);
        
        res.json({ 
            success: true, 
            message: 'Request updated successfully',
            data: convertFromSnakeCase(data)
        });
    } catch (error) {
        console.error(`[ADMIN UPDATE] ${requestId} — Error:`, error);
        res.status(500).json({ error: 'Failed to update request' });
    }
});

// ── Admin: Manually create a request (bypasses eligibility + duplicate checks) ──
app.post('/api/admin/create-request', authenticateAdmin, async (req, res) => {
    const requestId = await generateUniqueRequestId();
    console.log(`[ADMIN CREATE] ${requestId} — Manual request creation started`);

    try {
        const { orderNumber, type, reason, comments, items, overrideExisting, customAddress, customCity, customState, customPincode } = req.body;

        if (!orderNumber || !type || !reason) {
            return res.status(400).json({ error: 'orderNumber, type, and reason are required' });
        }
        if (!['return', 'exchange'].includes(type)) {
            return res.status(400).json({ error: 'type must be "return" or "exchange"' });
        }

        // ── Fetch order from Shopify ──────────────────────────────────────────
        const shopifyResponse = await fetch(
            `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/orders.json?name=${encodeURIComponent(orderNumber)}&status=any&fields=id,name,email,customer,line_items,fulfillment_status,fulfillments`,
            { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN } }
        );
        const shopifyData = await shopifyResponse.json();
        const order = shopifyData.orders && shopifyData.orders[0];
        if (!order) {
            return res.status(404).json({ error: `Order ${orderNumber} not found in Shopify` });
        }

        const customerName = order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'N/A';
        const customerEmail = order.customer ? order.customer.email : (order.email || '');
        const customerPhone = order.customer ? order.customer.phone : '';

        // ── Optional: block if active request already exists (unless overrideExisting=true) ──
        if (!overrideExisting) {
            const existing = await getRequestsByOrderNumber(order.name);
            const active = existing.filter(r => r.status !== 'rejected' && r.status !== 'waiting_payment');
            if (active.length > 0) {
                return res.status(409).json({
                    error: `Order already has an active request (${active[0].requestId}). Pass overrideExisting: true to create anyway.`,
                    existingRequestId: active[0].requestId
                });
            }
        }

        // ── Build items list ──────────────────────────────────────────────────
        let parsedItems = [];
        if (items && items.length > 0) {
            parsedItems = items;
        } else {
            // Default: use all line items from Shopify
            parsedItems = (order.line_items || []).map(li => ({
                name: li.title,
                variant: li.variant_title || 'Default',
                quantity: li.quantity,
                price: li.price,
                image: null,
                lineItemId: li.id
            }));
        }

        // ── Schedule pickup via carrier (respects carrier_mode setting) ────────────────────────────────────
        let awbNumber = null, shipmentId = null, pickupDate = null, carrierUsed = null, fallbackReason = null;
        try {
            const shiprocketToken = await getShiprocketToken();
            if (shiprocketToken) {
                const pickupResult = await schedulePickup(shiprocketToken, requestId, order, parsedItems, type);
                if (pickupResult) {
                    awbNumber = pickupResult.awbNumber;
                    shipmentId = pickupResult.shipmentId;
                    pickupDate = pickupResult.pickupDate;
                    carrierUsed = pickupResult.carrier;
                    fallbackReason = pickupResult.fallbackReason;
                }
            }
        } catch (srErr) {
            console.warn(`[ADMIN CREATE] Pickup scheduling failed (non-fatal):`, srErr.message);
        }

        // ── Insert into DB ────────────────────────────────────────────────────
        // Use custom premium address if provided, otherwise fall back to Shopify order address
        let shippingAddress, shippingCity, shippingState, shippingPincode;
        if (customAddress && customCity && customState && customPincode) {
            shippingAddress = customAddress;
            shippingCity = customCity;
            shippingState = customState;
            shippingPincode = customPincode;
            console.log(`[ADMIN CREATE] ${requestId} Using custom premium address: ${customAddress}, ${customCity}, ${customState} ${customPincode}`);
        } else {
            const addr = order.shipping_address || (order.fulfillments && order.fulfillments[0] && order.fulfillments[0].destination);
            shippingAddress = addr
                ? [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country].filter(Boolean).join(', ')
                : '';
            shippingCity = addr ? (addr.city || '') : '';
            shippingState = addr ? (addr.province || '') : '';
            shippingPincode = addr ? (addr.zip || '') : '';
        }

        await createRequest({
            requestId,
            orderNumber: order.name,
            email: customerEmail,
            customerName,
            customerEmail,
            customerPhone,
            type,
            status: (awbNumber || shipmentId) ? 'scheduled' : 'pending',
            reason,
            comments: comments || '',
            items: parsedItems,
            shippingAddress,
            shippingCity,
            shippingState,
            shippingPincode,
            awbNumber,
            shipmentId,
            pickupDate,
            carrier: carrierUsed || 'shiprocket',
            carrierShipmentId: shipmentId,
            carrierAwb: awbNumber,
            carrierFallbackReason: fallbackReason,
            adminNotes: `Manually created by admin on ${new Date().toLocaleDateString('en-IN')}`
        });

        console.log(`[ADMIN CREATE] ${requestId} ✅ Created successfully (Carrier: ${carrierUsed || 'N/A'}, AWB: ${awbNumber || 'N/A'})`);

        res.json({
            success: true,
            requestId,
            awbNumber: awbNumber || null,
            shipmentId: shipmentId || null,
            pickupDate: pickupDate || null,
            carrier: carrierUsed || null,
            status: (awbNumber || shipmentId) ? 'scheduled' : 'pending',
            message: `Request ${requestId} created successfully`
        });

    } catch (error) {
        console.error(`[ADMIN CREATE] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── Admin: Lookup order for manual request creation (no eligibility check) ──
app.post('/api/admin/lookup-order-force', authenticateAdmin, async (req, res) => {
    try {
        const { orderNumber } = req.body;
        if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });

        let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(orderNumber)}&status=any&fields=id,name,email,customer,line_items,fulfillment_status,fulfillments,financial_status`);

        if (!shopifyData.orders || shopifyData.orders.length === 0) {
            const retryOrderNumber = orderNumber.startsWith('#') ? orderNumber.substring(1) : '#' + orderNumber;
            shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(retryOrderNumber)}&status=any&fields=id,name,email,customer,line_items,fulfillment_status,fulfillments,financial_status`);
        }
        const order = shopifyData.orders && shopifyData.orders[0];

        if (!order) return res.status(404).json({ error: `Order ${orderNumber} not found` });

        // Check for existing active request
        const existingRequests = await getRequestsByOrderNumber(order.name);
        const active = existingRequests.filter(r => r.status !== 'rejected');

        res.json({
            found: true,
            order: {
                name: order.name,
                email: order.customer ? order.customer.email : order.email,
                customerName: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'N/A',
                customerPhone: order.customer ? order.customer.phone : '',
                fulfillmentStatus: order.fulfillment_status,
                lineItems: (order.line_items || []).map(li => ({
                    id: li.id,
                    name: li.title,
                    variant: li.variant_title || 'Default',
                    quantity: li.quantity,
                    price: li.price,
                    // Build Your Combo: surfaced so an admin approving a
                    // return can see it was part of a bundle before typing
                    // a compensation amount. Shopify's REST API returns
                    // line_item.properties as an array of {name, value}
                    // pairs — verify this against one real bundle order
                    // before relying on it.
                    bundleId: Array.isArray(li.properties) ? (li.properties.find(p => p.name === '_bundle_id')?.value || null) : null,
                    bundleDiscount: Array.isArray(li.properties) ? (li.properties.find(p => p.name === '_bundle_discount')?.value || null) : null
                }))
            },
            existingRequests: active.map(r => ({ requestId: r.requestId, status: r.status, type: r.type }))
        });
    } catch (error) {
        console.error('Admin lookup-order-force error:', error);
        res.status(500).json({ error: error.message });
    }
});



// Sync Status Endpoint - lightweight status check (sync runs automatically in background)
app.get('/api/admin/sync-status', authenticateAdmin, async (req, res) => {
    try {
        res.json({
            success: true,
            isRunning: isSyncRunning,
            lastSync: lastSyncTimestamp,
            message: isSyncRunning ? 'Sync in progress' : 'Sync completed',
            schedule: 'Hourly (IST timezone)'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// Manual Sync Trigger - immediately trigger background sync
app.post('/api/admin/sync-status', authenticateAdmin, async (req, res) => {
    try {
        const { requestId, forceRetry } = req.body;
        
        // If requestId is provided, sync only that specific request
        if (requestId) {
            console.log(`[Manual Sync] Admin triggered sync for single request: ${requestId}`);
            
            const request = await getRequestById(requestId);
            if (!request) {
                return res.status(404).json({ 
                    success: false, 
                    error: `Request ${requestId} not found` 
                });
            }
            
            // Use higher retry count for manual sync if forceRetry is true
            const maxRetries = forceRetry ? 5 : 3;
            const result = await syncWithRetry(request, maxRetries);
            
            if (result.success) {
                return res.json({
                    success: true,
                    message: result.changed
                        ? `Successfully synced ${requestId} (status updated)`
                        : `Synced ${requestId} (no change)`,
                    requestId: requestId,
                    updated: result.changed ? 1 : 0,
                    attempts: result.attempts
                });
            } else {
                return res.json({
                    success: false,
                    message: `Failed to sync ${requestId} after ${result.attempts} attempts`,
                    requestId: requestId,
                    error: result.error,
                    attempts: result.attempts
                });
            }
        }
        
        // Full background sync
        if (isSyncRunning) {
            return res.json({
                success: false,
                message: 'Sync is already running in the background'
            });
        }

        console.log('[Manual Sync] Admin triggered full background sync...');
        
        // Wait for sync to complete and get metrics
        const syncResult = await performBackgroundSync();

        if (syncResult.success) {
            res.json({
                success: true,
                message: `Sync complete! ${syncResult.metrics.updated} updated, ${syncResult.metrics.success} checked, ${syncResult.metrics.failed} failed`,
                updated: syncResult.metrics.updated,
                metrics: syncResult.metrics
            });
        } else {
            res.json({
                success: false,
                message: 'Sync failed',
                error: syncResult.error,
                metrics: syncResult.metrics
            });
        }
    } catch (error) {
        console.error('[Manual Sync] Error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to trigger sync',
            details: error.message 
        });
    }
});

// Get Shopify usage sync status
app.get('/api/admin/shopify-sync-status', authenticateAdmin, async (req, res) => {
    try {
        res.json({
            success: true,
            isRunning: isShopifySyncRunning,
            lastSync: lastShopifySyncTimestamp,
            message: isShopifySyncRunning ? 'Shopify sync in progress' : 'Shopify sync completed',
            schedule: '4 times daily (6AM, 12PM, 6PM, 12AM IST)'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get Shopify sync status' });
    }
});

// Manually trigger Shopify usage sync
app.post('/api/admin/trigger-shopify-sync', authenticateAdmin, async (req, res) => {
    try {
        if (isShopifySyncRunning) {
            return res.json({
                success: false,
                message: 'Shopify sync is already running'
            });
        }

        // Run sync in background
        performShopifyUsageSync();

        res.json({
            success: true,
            message: 'Shopify usage sync started'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to trigger Shopify sync' });
    }
});



// Reject request (admin) - supports legacy endpoints
app.post(['/api/admin/reject', '/api/admin/reject-return', '/api/admin/reject-exchange'], authenticateAdmin, async (req, res) => {
    try {
        const { requestId, notes } = req.body;

        // A rejection reason is mandatory — it stays on the request so admins
        // can see why it was rejected when reviewing it later.
        const rejectionReason = (notes || '').toString().trim();
        if (!rejectionReason) {
            return res.status(400).json({ error: 'A rejection reason is required' });
        }

        const request = await updateRequestStatus(requestId, {
            status: 'rejected',
            adminNotes: rejectionReason
        });

        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        res.json({ success: true, request });

    } catch (error) {
        console.error('Reject request error:', error);
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

// Undo rejection (admin) - restore rejected request to pending status
app.post('/api/admin/undo-rejection', authenticateAdmin, async (req, res) => {
    try {
        const { requestId } = req.body;

        const requestDetails = await getRequestById(requestId);
        if (!requestDetails) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (requestDetails.status !== 'rejected') {
            return res.status(400).json({ error: 'Can only undo rejected requests' });
        }

        const adminNotes = (requestDetails.adminNotes || '') + 
            `\n[SYSTEM] Rejection undone by admin on ${new Date().toLocaleString('en-IN')}`;

        const request = await updateRequestStatus(requestId, {
            status: 'pending',
            adminNotes
        });

        res.json({ 
            success: true, 
            message: 'Request restored to pending status',
            request 
        });

    } catch (error) {
        console.error('Undo rejection error:', error);
        res.status(500).json({ error: 'Failed to undo rejection' });
    }
});

// ── Video Evidence Endpoints ──────────────────────────────────────────────────
// Customer submits pickup handover video link (shown when request is rejected)
app.post('/api/request/submit-pickup-video', async (req, res) => {
    try {
        const { requestId, videoUrl } = req.body;

        if (!requestId || !videoUrl) {
            return res.status(400).json({ error: 'requestId and videoUrl are required' });
        }

        // Basic URL validation
        try { new URL(videoUrl); } catch (_) {
            return res.status(400).json({ error: 'Please provide a valid video URL' });
        }

        const request = await getRequestById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const updated = await updateRequestStatus(requestId, {
            pickupVideoUrl: videoUrl,
            pickupVideoSubmittedAt: new Date().toISOString()
        });

        res.json({ success: true, request: updated });
    } catch (error) {
        console.error('Submit pickup video error:', error);
        res.status(500).json({ error: 'Failed to submit pickup video' });
    }
});

// Warehouse uploads unboxing video (file upload via Cloudinary)
app.post('/api/admin/upload-unboxing-video', authenticateAdmin, upload.single('unboxingVideo'), async (req, res) => {
    try {
        const { requestId } = req.body;

        if (!requestId) {
            return res.status(400).json({ error: 'requestId is required' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Video file is required' });
        }

        const request = await getRequestById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Determine video URL: Cloudinary gives req.file.path, memory storage gives nothing usable
        let videoUrl;
        if (req.file.path) {
            // Cloudinary storage — path is the secure URL
            videoUrl = req.file.path;
        } else {
            // Memory storage — upload to Cloudinary manually
            const b64 = Buffer.from(req.file.buffer).toString('base64');
            const dataUri = `data:${req.file.mimetype};base64,${b64}`;
            const uploadResult = await cloudinary.uploader.upload(dataUri, {
                folder: 'returns/unboxing',
                resource_type: 'video',
                format: req.file.originalname.split('.').pop() || 'mp4'
            });
            videoUrl = uploadResult.secure_url;
        }

        const updated = await updateRequestStatus(requestId, {
            unboxingVideoUrl: videoUrl,
            unboxingVideoSubmittedAt: new Date().toISOString()
        });

        res.json({ success: true, videoUrl, request: updated });
    } catch (error) {
        console.error('Upload unboxing video error:', error);
        res.status(500).json({ error: 'Failed to upload unboxing video' });
    }
});

// Warehouse can also submit an unboxing video URL (link instead of file)
app.post('/api/admin/submit-unboxing-video-url', authenticateAdmin, async (req, res) => {
    try {
        const { requestId, videoUrl } = req.body;

        if (!requestId || !videoUrl) {
            return res.status(400).json({ error: 'requestId and videoUrl are required' });
        }

        try { new URL(videoUrl); } catch (_) {
            return res.status(400).json({ error: 'Please provide a valid video URL' });
        }

        const request = await getRequestById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const updated = await updateRequestStatus(requestId, {
            unboxingVideoUrl: videoUrl,
            unboxingVideoSubmittedAt: new Date().toISOString()
        });

        res.json({ success: true, request: updated });
    } catch (error) {
        console.error('Submit unboxing video URL error:', error);
        res.status(500).json({ error: 'Failed to submit unboxing video' });
    }
});

// Delete requests (admin)
app.post('/api/admin/delete-requests', authenticateAdmin, async (req, res) => {
    try {
        const { requestIds } = req.body;

        if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
            return res.status(400).json({ error: 'Invalid request IDs' });
        }

        const result = await deleteRequests(requestIds);

        res.json({ success: true, count: result.count, message: `Deleted ${result.count || 0} requests` });
    } catch (error) {
        console.error('Delete requests error:', error);
        res.status(500).json({ error: 'Failed to delete requests' });
    }
});

// Bulk Initiate Pickup (Admin)
app.post('/api/admin/bulk-initiate-pickup', authenticateAdmin, async (req, res) => {
    // Disable the global 10s timeout for this long-running batch endpoint.
    // Allow up to 5 minutes to process the batch, AND remove the global
    // 'timeout' listener that would otherwise still fire 503 after our window
    // expires (res.setTimeout only changes the duration, not the listeners).
    res.removeAllListeners('timeout');
    res.setTimeout(5 * 60 * 1000);

    // Track client disconnect / response close so we stop the loop early
    // and never attempt to write to an already-closed response.
    let clientGone = false;
    const onClose = () => { clientGone = true; };
    req.on('close', onClose);
    res.on('close', onClose);

    try {
        const { requestIds } = req.body;
        if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
            if (!res.headersSent) return res.status(400).json({ error: 'Invalid or missing request IDs' });
            return;
        }

        if (!process.env.SHIPROCKET_EMAIL && !process.env.DELHIVERY_API_KEY && !ekartConfigured()) {
            if (!res.headersSent) return res.status(400).json({ error: 'No carrier configured. Please configure Shiprocket, Delhivery or Ekart.' });
            return;
        }

        // Get carrier mode from settings (supports separate pickup/dispatch settings)
        const carrierMode = await getCarrierMode('pickup');
        const carrierResolution = resolveCarrier(carrierMode, null, 'pickup');
        console.log(`[Bulk Pickup] Carrier mode: ${carrierMode}, Resolution:`, carrierResolution);

        const results = {
            total: requestIds.length,
            successful: [],
            failed: []
        };

        for (const requestId of requestIds) {
            // Stop processing if the client disconnected or response already sent (e.g. timeout)
            if (clientGone || res.headersSent) {
                console.warn(`[Bulk Pickup] Aborting remaining items: client disconnected or response already sent.`);
                break;
            }

            try {
                const requestDetails = await getRequestById(requestId);
                if (!requestDetails) {
                    results.failed.push({ id: requestId, error: 'Request not found' });
                    continue;
                }

                if (requestDetails.status !== 'pending') {
                    results.failed.push({ id: requestId, error: `Invalid status: ${requestDetails.status}` });
                    continue;
                }

                console.log(`[${requestId}] Admin BULK authorized pickup. Using carrier resolution...`);

                let shopifyOrder = null;
                try {
                    let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(requestDetails.orderNumber)}&status=any&limit=1`);
                    if (!shopifyData.orders || shopifyData.orders.length === 0) {
                        const alt = requestDetails.orderNumber.startsWith('#')
                            ? requestDetails.orderNumber.substring(1)
                            : '#' + requestDetails.orderNumber;
                        shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(alt)}&status=any&limit=1`);
                    }
                    shopifyOrder = shopifyData.orders && shopifyData.orders[0];
                } catch (err) {
                    console.warn(`[${requestId}] Bulk Shopify fetch failed:`, err.message);
                }

                // Use carrier resolution to determine which carrier to use
                const { primary: carrierToUse, useFallback, fallback: configuredFallback } = carrierResolution;
                let carrierUsed = null;
                let awbNumber = null;
                let shipmentId = null;
                let pickupDate = null;
                let fallbackReason = null;

                // Try the resolved primary carrier, then the fallback partner if enabled
                const bookingData = {
                    ...requestDetails,
                    requestId,
                    orderNumber: requestDetails.orderNumber,
                    customerPhone: requestDetails.customerPhone
                };

                let booking = null;
                try {
                    booking = await returnBookingAttempt(carrierToUse, bookingData, shopifyOrder);
                    console.log(`[${requestId}] ✅ Bulk ${carrierToUse} success: ShipmentID ${booking.shipmentId}, AWB ${booking.awbNumber || 'PENDING'}`);
                } catch (primaryError) {
                    // If fallback is enabled, try the fallback carrier
                    if (!useFallback) throw primaryError;

                    const fallbackCarrier = configuredFallback || getFallbackCarrier(carrierToUse);
                    fallbackReason = `${carrierToUse} failed: ${primaryError.message}`;
                    console.warn(`[${requestId}] ⚠️ Bulk ${carrierToUse} failed, falling back to ${fallbackCarrier}:`, primaryError.message);

                    try {
                        booking = await returnBookingAttempt(fallbackCarrier, bookingData, shopifyOrder);
                        console.log(`[${requestId}] ✅ Bulk ${fallbackCarrier} fallback success: AWB ${booking.awbNumber || 'PENDING'}`);
                    } catch (fallbackError) {
                        console.error(`[${requestId}] ❌ Bulk both carriers failed. Fallback error:`, fallbackError.message);
                        throw new Error(`Both carriers failed: ${primaryError.message} | ${fallbackError.message}`);
                    }
                }

                carrierUsed = booking.carrierUsed;
                awbNumber = booking.awbNumber;
                shipmentId = booking.shipmentId;
                pickupDate = booking.pickupDate;

                if (carrierUsed) {
                    let adminNotes = requestDetails.adminNotes || '';
                    adminNotes += `\nPickup scheduled (Bulk Action) via ${carrierUsed}: AWB ${awbNumber || 'Pending'}`;
                    if (fallbackReason) {
                        adminNotes += `\nFallback: ${fallbackReason}`;
                    }

                    await updateRequestStatus(requestId, {
                        shipmentId,
                        awbNumber,
                        pickupDate,
                        status: 'pickup_booked',
                        adminNotes,
                        carrier: carrierUsed,
                        carrierShipmentId: shipmentId,
                        carrierAwb: awbNumber,
                        carrierFallbackReason: fallbackReason || null
                    });

                    // ── Send approval WhatsApp message (non-blocking) ──
                    sendReturnExchangeApprovalWhatsApp({
                        phone: requestDetails.customerPhone,
                        requestId,
                        orderNumber: requestDetails.orderNumber,
                        type: requestDetails.type
                    }).then(waResult => {
                        if (waResult?.success) {
                            updateRequestStatus(requestId, {
                                whatsappSent: true,
                                whatsappMessageId: waResult.messageId || null,
                                whatsappSentAt: new Date().toISOString()
                            }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                        }
                    }).catch(() => {}); // fire-and-forget

                    results.successful.push(requestId);
                } else {
                    throw new Error('No carrier was used');
                }

            } catch (error) {
                console.error(`[${requestId}] Bulk initiate error:`, error.message);
                results.failed.push({ id: requestId, error: error.message });
            }
        }

        if (!res.headersSent) {
            res.json({
                success: true,
                results,
                message: `Processed ${results.total} requests: ${results.successful.length} successful, ${results.failed.length} failed.`
            });
        } else {
            console.warn('[Bulk Pickup] Response already sent (likely timeout). Skipping final res.json().');
        }

    } catch (error) {
        console.error('Bulk initiate pickup error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error while processing batch' });
        }
    } finally {
        req.off('close', onClose);
        res.off('close', onClose);
    }
});

// Finalize payment from frontend
app.post('/api/finalize-payment', async (req, res) => {
    const { requestId, paymentId, paymentAmount } = req.body;
    console.log(`[${requestId}] Frontend requesting finalization for payment ${paymentId}`);

    if (!requestId || !paymentId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const result = await finalizeRequestAfterPayment(requestId, paymentId, paymentAmount);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Razorpay Webhook
app.post('/api/razorpay-webhook', async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    console.log('📥 Received Razorpay Webhook');

    if (secret && signature) {
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(req.rawBody)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('❌ Razorpay Webhook Signature Mismatch');
            return res.status(400).send('Invalid signature');
        }
    } else if (!secret) {
        console.warn('⚠️ RAZORPAY_WEBHOOK_SECRET missing. Skipping signature verification (DEVELOPMENT ONLY)');
    }

    const event = req.body.event;
    const payload = req.body.payload;

    if (event === 'payment.captured' || event === 'payment.authorized') {
        const payment = payload.payment.entity;
        const requestId = payment.notes?.requestId;
        const paymentId = payment.id;
        const amount = payment.amount / 100;

        if (requestId && requestId.startsWith('REQ-')) {
            // Dedup guard: Razorpay often fires the same webhook twice simultaneously
            if (storage.processingPayments.has(paymentId)) {
                console.log(`[${requestId}] ⏭️ Webhook duplicate: payment ${paymentId} already being processed. Skipping.`);
            } else {
                storage.processingPayments.add(paymentId);
                console.log(`[${requestId}] 🛡️ Webhook Safety Net: Processing payment ${paymentId} (${amount})`);
                try {
                    await finalizeRequestAfterPayment(requestId, paymentId, amount);
                } finally {
                    storage.processingPayments.delete(paymentId);
                }
            }
        } else {
            console.log(`[Webhook] Payment ${paymentId} received but no requestId found in notes.`);
        }
    }

    // ── Payment Link Paid (agent-initiated links) ──
    if (event === 'payment_link.paid') {
        const paymentLink = payload.payment_link?.entity;
        if (paymentLink) {
            const requestId = paymentLink.notes?.requestId;
            const linkId = paymentLink.id;
            const amountPaid = (paymentLink.amount_paid || 0) / 100;

            if (requestId && requestId.startsWith('REQ-')) {
                if (storage.processingPayments.has(linkId)) {
                    console.log(`[${requestId}] ⏭️ Payment link webhook duplicate: ${linkId}. Skipping.`);
                } else {
                    storage.processingPayments.add(linkId);
                    console.log(`[${requestId}] 🎉 Payment link ${linkId} paid via main webhook! Amount: ₹${amountPaid}. Auto-approving...`);
                    try {
                        const request = await getRequestById(requestId);
                        if (request) {
                            const paymentId = payload.payment?.entity?.id || null;
                            await updateRequestStatus(requestId, {
                                agentPaymentStatus: 'paid',
                                agentPaymentPaidAt: new Date().toISOString(),
                                paymentId: paymentId || request.paymentId,
                                paymentAmount: amountPaid || request.paymentAmount
                            });

                            const approvalNotes = `Auto-approved via payment link.\nLink ID: ${linkId}\nAmount Paid: ₹${amountPaid}\nPaid at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
                            if (['pending', 'waiting_payment', 'pickup_pending'].includes(request.status)) {
                                await updateRequestStatus(requestId, {
                                    status: 'approved',
                                    adminNotes: (request.adminNotes || '') + '\n' + approvalNotes
                                });
                                sendReturnExchangeApprovalWhatsApp({
                                    phone: request.customerPhone,
                                    requestId,
                                    orderNumber: request.orderNumber,
                                    type: request.type
                                }).catch(() => {});
                                console.log(`[${requestId}] ✅ Auto-approved via main webhook`);
                            }
                        }
                    } catch (err) {
                        console.error(`[${requestId}] ❌ Auto-approval via main webhook failed:`, err.message);
                    } finally {
                        storage.processingPayments.delete(linkId);
                    }
                }
            }
        }
    }

    res.json({ status: 'ok' });
});

// ==================== AGENT PAYMENT LINKS ====================

/**
 * Generate a Razorpay payment link for a return/exchange request.
 * The link is sent to the customer via WhatsApp. Once paid, the request auto-approves.
 */
app.post('/api/admin/generate-payment-link', authenticateAdmin, async (req, res) => {
    const { requestId, amount, sendWhatsapp } = req.body;

    if (!requestId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'requestId and a positive amount are required' });
    }

    if (!razorpay) {
        return res.status(503).json({ error: 'Payment gateway is not configured. Contact the administrator.' });
    }

    try {
        const request = await getRequestById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Prevent duplicate active links
        if (request.agentPaymentLinkId && request.agentPaymentStatus === 'pending') {
            return res.status(409).json({
                error: 'A payment link is already active for this request. Wait for it to expire or cancel it first.',
                existingLink: request.agentPaymentLink
            });
        }

        // Already paid
        if (request.agentPaymentStatus === 'paid') {
            return res.status(409).json({ error: 'Payment for this request has already been completed.' });
        }

        const agentName = (req.operator && req.operator.username) || (req.user && req.user.username) || 'admin';
        const typeLabel = request.type === 'exchange' ? 'Exchange' : 'Return';
        const description = `Offcomfrt ${typeLabel} — ${request.requestId} (${request.orderNumber})`;

        // Create Razorpay Payment Link
        const paymentLinkData = {
            amount: Math.round(amount * 100), // Razorpay expects paise
            currency: 'INR',
            accept_partial: false,
            description: description,
            customer: {
                name: request.customerName || 'Customer',
                email: request.customerEmail || request.email || 'customer@offcomfrt.com',
                contact: request.customerPhone ? String(request.customerPhone).replace(/\D/g, '').slice(-10) : '9999999999'
            },
            notify: { sms: false, email: false },
            reminder_enable: true,
            notes: {
                requestId: request.requestId,
                orderNumber: request.orderNumber,
                type: request.type,
                initiatedBy: agentName,
                source: 'admin_dashboard'
            },
            callback_url: `https://exchange-return-tracking.onrender.com/api/payment-link-callback?requestId=${encodeURIComponent(request.requestId)}`,
            callback_method: 'get'
        };

        console.log(`[${requestId}] 💳 Agent ${agentName} generating payment link for ₹${amount}`);
        const paymentLink = await razorpay.paymentLink.create(paymentLinkData);

        const linkUrl = paymentLink.short_url || paymentLink.long_url;
        const linkId = paymentLink.id;

        // Persist link details to DB
        await updateRequestStatus(requestId, {
            agentPaymentLink: linkUrl,
            agentPaymentLinkId: linkId,
            agentPaymentAmount: amount,
            agentPaymentStatus: 'pending',
            agentPaymentInitiatedBy: agentName,
            agentPaymentInitiatedAt: new Date().toISOString()
        });

        console.log(`[${requestId}] ✅ Payment link created: ${linkUrl} (ID: ${linkId})`);

        // Send WhatsApp notification to customer (non-blocking)
        let whatsappResult = null;
        if (sendWhatsapp !== false && request.customerPhone) {
            const message = `Hi ${request.customerName || 'there'}! 👋\n\n` +
                `Your ${typeLabel} Request *${request.requestId}* for Order *${request.orderNumber}* requires a payment of *₹${amount}*.\n\n` +
                `Please complete the payment using this link:\n${linkUrl}\n\n` +
                `Once paid, your request will be automatically approved and processed. 🚀\n\n` +
                `Thank you!\nTeam Offcomfrt`;

            sendWhatsAppNotification(request.customerPhone, message, request.type, requestId)
                .then(() => console.log(`[${requestId}] ✅ Payment link WhatsApp sent to ${request.customerPhone}`))
                .catch(err => console.warn(`[${requestId}] ⚠️ Payment link WhatsApp failed:`, err.message));
        }

        res.json({
            success: true,
            requestId,
            paymentLink: linkUrl,
            paymentLinkId: linkId,
            amount,
            status: 'pending',
            message: `Payment link generated for ₹${amount}. ${sendWhatsapp !== false ? 'Customer notified via WhatsApp.' : ''}`
        });

    } catch (error) {
        console.error(`[${requestId}] ❌ Payment link generation failed:`, error.message);
        res.status(500).json({ error: 'Failed to generate payment link: ' + error.message });
    }
});

/**
 * Admin: Override payment for a waiting_payment request.
 * Records an out-of-band payment (UPI / bank / cash / manual gateway capture) with
 * full attribution, marks it paid, and auto-books the return pickup via the
 * configured carrier unless the admin defers or a pickup already exists.
 */
app.post('/api/admin/override-payment', authenticateAdmin, async (req, res) => {
    const { requestId } = req.body || {};
    const amount = parseFloat(req.body && req.body.amount);
    const method = String((req.body && req.body.method) || '').trim().toLowerCase();
    const reference = String((req.body && req.body.reference) || '').trim();
    const reason = String((req.body && req.body.reason) || 'other').trim().toLowerCase();
    const adminNotes = String((req.body && req.body.notes) || '').trim();
    const deferPickup = req.body && req.body.deferPickup === true;
    const sendWhatsapp = !req.body || req.body.sendWhatsapp !== false;

    const VALID_METHODS = ['upi', 'bank_transfer', 'cash', 'razorpay_manual', 'other'];
    const VALID_REASONS = ['gateway_down', 'paid_elsewhere', 'partial_payment', 'fee_waived_manual', 'other'];
    const METHOD_LABELS = {
        upi: 'UPI',
        bank_transfer: 'Bank Transfer / NEFT',
        cash: 'Cash',
        razorpay_manual: 'Razorpay (manual capture)',
        other: 'Other'
    };

    if (!requestId) return res.status(400).json({ error: 'requestId is required' });
    if (!(amount > 0)) return res.status(400).json({ error: 'A positive payment amount is required' });
    if (!VALID_METHODS.includes(method)) {
        return res.status(400).json({ error: `Invalid payment method. Allowed: ${VALID_METHODS.join(', ')}` });
    }
    if (!VALID_REASONS.includes(reason)) {
        return res.status(400).json({ error: `Invalid override reason. Allowed: ${VALID_REASONS.join(', ')}` });
    }
    if (method !== 'other' && !reference) {
        return res.status(400).json({ error: 'A payment reference (UTR / RRID / transaction ID) is required for this method' });
    }

    try {
        const request = await getRequestById(requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (request.status !== 'waiting_payment') {
            return res.status(400).json({ error: `Only waiting-payment requests can be overridden (current status: ${request.status})` });
        }
        if (request.agentPaymentStatus === 'paid') {
            return res.status(409).json({ error: 'Payment link for this request is already marked paid. Refresh the request — the webhook may have completed it.' });
        }

        // If a Razorpay payment link is still OPEN, block the override — the webhook
        // may complete it any moment and a manual record would be a false payment.
        if (razorpay && request.agentPaymentLinkId && request.agentPaymentStatus === 'pending') {
            try {
                const link = await razorpay.paymentLink.get(request.agentPaymentLinkId);
                const linkStatus = (link && link.status) || 'UNKNOWN';
                if (!['expired', 'cancelled', 'completed'].includes(String(linkStatus).toLowerCase())) {
                    return res.status(409).json({
                        error: `Payment link ${request.agentPaymentLinkId} is still ${linkStatus}. Wait for the webhook, cancel the link, or record the payment once it expires.`
                    });
                }
            } catch (linkErr) {
                console.warn(`[${requestId}] ⚠️ Could not verify payment link status (${linkErr.message}) — proceeding with manual override.`);
            }
        }

        // Optionally verify a Razorpay payment ID against the gateway. A bad ID
        // blocks the override; a gateway outage degrades to manual with a flag.
        let gatewayVerified = false;
        let gatewayWarn = null;
        const submittedPaymentId = String((req.body && req.body.paymentId) || '').trim();
        if (submittedPaymentId && submittedPaymentId.startsWith('pay_')) {
            if (!razorpay) {
                return res.status(503).json({ error: 'Razorpay is not configured; cannot verify the payment ID. Record it as a reference instead.' });
            }
            try {
                const payment = await razorpay.payments.fetch(submittedPaymentId);
                if (payment.status === 'captured' || payment.status === 'authorized') {
                    gatewayVerified = true;
                } else {
                    return res.status(400).json({ error: `Payment ${submittedPaymentId} is '${payment.status}', not captured. Override rejected.` });
                }
            } catch (payErr) {
                console.warn(`[${requestId}] ⚠️ Razorpay verification failed (${payErr.message}) — recording as manual override instead.`);
                gatewayWarn = `Could not verify ${submittedPaymentId} with Razorpay (${payErr.message})`;
            }
        }

        const actor = (req.operator && req.operator.username) || (req.user && req.user.username) || 'super-admin';
        const nowIso = new Date().toISOString();
        const refText = reference || (gatewayVerified ? submittedPaymentId : 'no reference provided');
        const reasonText = reason.replace(/_/g, ' ');

        let recordNotes = gatewayVerified
            ? `💳 PAYMENT OVERRIDE — ₹${amount} via ${METHOD_LABELS[method]} — GATEWAY-VERIFIED payment ${submittedPaymentId}\n`
            : `💳 PAYMENT OVERRIDE — ₹${amount} via ${METHOD_LABELS[method]} — Ref: ${refText} (${reasonText})\n`;
        if (gatewayWarn) recordNotes += `⚠️ ${gatewayWarn}\n`;
        recordNotes += `Recorded by ${actor} at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
        if (adminNotes) recordNotes += `\nAdmin note: ${adminNotes}`;

        // Payment clears the fee gate → request leaves waiting_payment.
        // Pickup is auto-booked below (→ pickup_booked) unless the admin defers or it fails (→ stays pending).
        const newStatus = 'pending';

        const historyEntry = {
            action: 'payment_override',
            amount,
            method,
            reference: refText,
            reason,
            gatewayVerified,
            notes: adminNotes || null,
            timestamp: nowIso,
            by: actor
        };
        const existingHistory = Array.isArray(request.requestHistory) ? [...request.requestHistory] : [];
        existingHistory.push(historyEntry);

        await updateRequestStatus(requestId, {
            status: newStatus,
            paymentId: gatewayVerified ? submittedPaymentId : (request.paymentId || `OVERRIDE-${Date.now()}`),
            paymentAmount: amount,
            ...(request.agentPaymentLinkId ? { agentPaymentStatus: 'paid', agentPaymentPaidAt: nowIso } : {}),
            paymentOverriddenAt: nowIso,
            paymentOverrideMethod: method,
            paymentOverrideReference: refText,
            paymentOverrideReason: reason,
            paymentOverrideNotes: adminNotes || null,
            paymentOverrideBy: actor,
            adminNotes: [request.adminNotes, recordNotes].filter(Boolean).join('\n'),
            requestHistory: existingHistory
        });
        console.log(`[${requestId}] 💳 Payment override by ${actor}: ₹${amount} via ${method} (Ref: ${refText}${gatewayVerified ? ', gateway-verified' : ''})`);

        // ── Auto-book the return pickup unless deferred / already booked (mirror of paid-submission flow) ──
        let pickup = null;
        const existingAwb = request.awbNumber || request.carrierAwb;
        const existingShipment = request.shipmentId || request.carrierShipmentId;
        if (deferPickup) {
            pickup = { attempted: false, skippedReason: 'Admin chose to review before booking pickup.' };
        } else if (existingAwb || existingShipment) {
            pickup = { attempted: false, reused: true, awbNumber: existingAwb, shipmentId: existingShipment, carrier: request.carrier };
            console.log(`[${requestId}] ♻️ Pickup already booked (AWB ${existingAwb || 'n/a'}) — reused, no duplicate order`);
        } else {
            try {
                const carrierMode = await getCarrierMode('pickup');
                const resolution = resolveCarrier(carrierMode, null, 'pickup');

                // Shopify order fetch is best-effort; stored request data is the fallback
                let shopifyOrder = null;
                try {
                    let shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(request.orderNumber)}&status=any&limit=1`);
                    if (!shopifyData.orders || shopifyData.orders.length === 0) {
                        const alt = request.orderNumber.startsWith('#') ? request.orderNumber.substring(1) : '#' + request.orderNumber;
                        shopifyData = await shopifyAPI(`orders.json?name=${encodeURIComponent(alt)}&status=any&limit=1`);
                    }
                    shopifyOrder = shopifyData.orders && shopifyData.orders[0];
                } catch (err) {
                    console.warn(`[${requestId}] Shopify fetch failed for override pickup:`, err.message);
                }

                let items = request.items;
                if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
                const bookingData = { ...request, requestId, items, customerPhone: request.customerPhone };

                let booking = null;
                let fallbackReason = null;
                try {
                    booking = await returnBookingAttempt(resolution.primary, bookingData, shopifyOrder);
                } catch (primaryError) {
                    if (!resolution.useFallback) throw primaryError;
                    const fallbackCarrier = resolution.fallback || getFallbackCarrier(resolution.primary);
                    fallbackReason = `${resolution.primary} failed: ${primaryError.message}`;
                    console.warn(`[${requestId}] ⚠️ ${resolution.primary} failed, falling back to ${fallbackCarrier}:`, primaryError.message);
                    booking = await returnBookingAttempt(fallbackCarrier, bookingData, shopifyOrder);
                }

                const updates = {
                    status: 'pickup_booked',
                    carrier: booking.carrierUsed,
                    carrierShipmentId: booking.shipmentId,
                    carrierAwb: booking.awbNumber,
                    shipmentId: booking.shipmentId,
                    awbNumber: booking.awbNumber,
                    pickupDate: booking.pickupDate,
                    adminNotes: `\nPickup auto-booked after payment override via ${booking.carrierUsed}: AWB ${booking.awbNumber || 'Pending'}`
                };
                if (fallbackReason) updates.carrierFallbackReason = fallbackReason;
                await updateRequestStatus(requestId, updates);
                pickup = { attempted: true, success: true, carrier: booking.carrierUsed, awbNumber: booking.awbNumber, shipmentId: booking.shipmentId, pickupDate: booking.pickupDate };
                console.log(`[${requestId}] ✅ Pickup booked after override: ${booking.carrierUsed} AWB ${booking.awbNumber || 'PENDING'}`);
            } catch (bookingError) {
                await updateRequestStatus(requestId, {
                    adminNotes: `\n⚠️ Pickup auto-booking failed after payment override: ${bookingError.message}. Book pickup manually via Approve.`
                }).catch(() => {});
                pickup = { attempted: true, success: false, error: bookingError.message };
                console.error(`[${requestId}] ❌ Pickup booking after payment override failed:`, bookingError.message);
            }
        }

        // ── Confirm payment (and pickup, if booked) to the customer via WhatsApp ──
        let whatsapp = { sent: false };
        if (sendWhatsapp && request.customerPhone) {
            try {
                let msg = `Hi ${request.customerName || 'there'}! 👋\n\nWe've received your payment of *₹${amount}* for ${request.type === 'exchange' ? 'Exchange' : 'Return'} Request *${requestId}* (Order ${request.orderNumber}). Thank you! ✅`;
                if (pickup && pickup.success && pickup.awbNumber) {
                    msg += `\n\n📦 Return pickup has been scheduled via ${pickup.carrier}. AWB: *${pickup.awbNumber}*.`;
                }
                msg += `\n\n— Team Offcomfrt`;
                await sendWhatsAppNotification(request.customerPhone, msg, request.type, requestId);
                whatsapp = { sent: true };
                updateRequestStatus(requestId, {
                    whatsappSent: true,
                    whatsappSentAt: new Date().toISOString()
                }).catch(() => {});
            } catch (waErr) {
                console.warn(`[${requestId}] ⚠️ Payment confirmation WhatsApp failed:`, waErr.message);
                whatsapp = { sent: false, error: waErr.message };
            }
        }

        const refreshed = await getRequestById(requestId).catch(() => null);
        res.json({
            success: true,
            requestId,
            override: {
                amount,
                method,
                reference: refText,
                reason,
                gatewayVerified,
                recordedBy: actor,
                recordedAt: nowIso
            },
            newStatus: (refreshed && refreshed.status) || (pickup && pickup.success ? 'pickup_booked' : newStatus),
            pickup,
            whatsapp,
            request: refreshed,
            message: `Payment of ₹${amount} recorded via ${METHOD_LABELS[method]}.${pickup && pickup.success ? ` Pickup booked via ${pickup.carrier} (AWB ${pickup.awbNumber || 'pending'}).` : ''}`
        });
    } catch (error) {
        console.error(`[${requestId || 'override-payment'}] ❌ Payment override failed:`, error);
        res.status(500).json({ error: 'Failed to record payment override: ' + error.message });
    }
});

/**
 * Razorpay Payment Link Webhook Handler
 * Handles payment_link.paid events to auto-approve requests.
 * Also extends the existing payment webhook above.
 */
app.post('/api/razorpay-payment-link-webhook', async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    console.log('📥 Received Razorpay Payment Link Webhook');

    if (secret && signature) {
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(req.rawBody || JSON.stringify(req.body))
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('❌ Payment Link Webhook Signature Mismatch');
            return res.status(400).send('Invalid signature');
        }
    } else if (!secret) {
        console.warn('⚠️ RAZORPAY_WEBHOOK_SECRET missing. Skipping signature verification (DEVELOPMENT ONLY)');
    }

    const event = req.body.event;
    const payload = req.body.payload;

    if (event === 'payment_link.paid') {
        const paymentLink = payload.payment_link?.entity;
        if (!paymentLink) {
            console.log('[Payment Link Webhook] No payment_link entity in payload');
            return res.json({ status: 'ok' });
        }

        const requestId = paymentLink.notes?.requestId;
        const linkId = paymentLink.id;
        const amountPaid = (paymentLink.amount_paid || 0) / 100; // Convert paise to rupees

        if (!requestId || !requestId.startsWith('REQ-')) {
            console.log(`[Payment Link Webhook] Link ${linkId} paid but no requestId in notes`);
            return res.json({ status: 'ok' });
        }

        // Dedup guard
        if (storage.processingPayments.has(linkId)) {
            console.log(`[${requestId}] ⏭️ Payment link webhook duplicate: ${linkId}. Skipping.`);
            return res.json({ status: 'ok' });
        }

        storage.processingPayments.add(linkId);
        console.log(`[${requestId}] 🎉 Payment link ${linkId} paid! Amount: ₹${amountPaid}. Auto-approving...`);

        try {
            const request = await getRequestById(requestId);
            if (!request) {
                console.error(`[${requestId}] ❌ Cannot auto-approve: Request not found`);
                return res.json({ status: 'ok' });
            }

            // Extract payment ID from the payment entity
            const paymentId = payload.payment?.entity?.id || null;

            // Update payment status to paid
            await updateRequestStatus(requestId, {
                agentPaymentStatus: 'paid',
                agentPaymentPaidAt: new Date().toISOString(),
                paymentId: paymentId || request.paymentId,
                paymentAmount: amountPaid || request.paymentAmount
            });

            // Auto-approve the request
            const approvalNotes = `Auto-approved via payment link.\nLink ID: ${linkId}\nAmount Paid: ₹${amountPaid}\nPaid at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

            if (request.status === 'pending' || request.status === 'waiting_payment' || request.status === 'pickup_pending') {
                // For exchanges, trigger forward shipment via the approve flow
                if (request.type === 'exchange') {
                    // Use the same approve logic for exchanges (creates forward shipment)
                    console.log(`[${requestId}] 🔄 Triggering exchange approval flow (forward shipment)...`);
                    await updateRequestStatus(requestId, {
                        status: 'approved',
                        adminNotes: (request.adminNotes || '') + '\n' + approvalNotes
                    });
                } else {
                    // For returns, just approve and let admin initiate pickup if needed
                    await updateRequestStatus(requestId, {
                        status: 'approved',
                        adminNotes: (request.adminNotes || '') + '\n' + approvalNotes
                    });
                }

                // Send approval WhatsApp to customer
                sendReturnExchangeApprovalWhatsApp({
                    phone: request.customerPhone,
                    requestId,
                    orderNumber: request.orderNumber,
                    type: request.type
                }).then(waResult => {
                    if (waResult?.success) {
                        updateRequestStatus(requestId, {
                            whatsappSent: true,
                            whatsappMessageId: waResult.messageId || null,
                            whatsappSentAt: new Date().toISOString()
                        }).catch(e => console.warn(`[${requestId}] WhatsApp status update failed:`, e.message));
                    }
                }).catch(() => {});

                console.log(`[${requestId}] ✅ Auto-approved successfully after payment link completion`);
            } else {
                console.log(`[${requestId}] ℹ️ Request already in status '${request.status}' — payment recorded but no status change`);
                await updateRequestStatus(requestId, {
                    adminNotes: (request.adminNotes || '') + '\n' + approvalNotes
                });
            }

            res.json({ status: 'ok', requestId, autoApproved: true });
        } catch (err) {
            console.error(`[${requestId}] ❌ Auto-approval failed:`, err.message);
            res.json({ status: 'ok', error: err.message }); // Return 200 to prevent Razorpay retries
        } finally {
            storage.processingPayments.delete(linkId);
        }
    } else {
        console.log(`[Payment Link Webhook] Unhandled event: ${event}`);
        res.json({ status: 'ok' });
    }
});

/**
 * Payment Link Callback (redirect after customer pays)
 * Lightweight GET handler — just shows a success page.
 */
app.get('/api/payment-link-callback', async (req, res) => {
    const { requestId } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html><head><title>Payment Successful</title>
        <style>body{font-family:'Inter',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb;}
        .card{text-align:center;padding:3rem;background:white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:420px;}
        .check{width:64px;height:64px;background:#22c55e;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;}
        .check svg{stroke:white;stroke-width:3;fill:none;}
        h1{font-size:1.5rem;margin:0 0 0.5rem;color:#111827;}p{color:#6b7280;font-size:0.95rem;line-height:1.6;}</style></head>
        <body><div class="card">
        <div class="check"><svg width="32" height="32" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
        <h1>Payment Successful!</h1>
        <p>Thank you! Your request <strong>${requestId || ''}</strong> has been received and will be processed automatically.</p>
        <p style="margin-top:1rem;font-size:0.85rem;">You can close this window.</p>
        </div></body></html>
    `);
});

// ==================== HEALTH CHECK ====================

app.get('/', (req, res) => {
    // Minimal health check - no sensitive information exposed
    res.json({
        service: 'Offcomfrt Returns & Exchanges',
        status: 'running',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// ==================== INFLUENCER ADMIN ENDPOINTS ====================

// Include new fields for self-signup applications
app.get('/api/influencer-admin/list', authenticateAdmin, async (req, res) => {
    try {
        const influencers = await getAllInfluencers();
        // DEBUG: Log first influencer's shipping fields to diagnose address loading
        if (influencers && influencers.length > 0) {
            const sample = influencers[0];
            console.log('[DEBUG] First influencer shipping fields from DB:', {
                id: sample.id,
                name: sample.name,
                shipping_address: sample.shipping_address,
                shipping_city: sample.shipping_city,
                shipping_state: sample.shipping_state,
                shipping_pin: sample.shipping_pin,
                shipping_landmark: sample.shipping_landmark,
                address_type: sample.address_type
            });
        }
        res.json({ success: true, influencers });
    } catch (error) {
        console.error('List influencers error:', error);
        res.status(500).json({ error: 'Failed to fetch influencers' });
    }
});

// Get single influencer details (for edit modal - fresh DB read)
app.get('/api/influencer-admin/detail/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }
        console.log('[DEBUG] Single influencer detail shipping fields from DB:', {
            id: influencer.id,
            name: influencer.name,
            shipping_address: influencer.shipping_address,
            shipping_city: influencer.shipping_city,
            shipping_state: influencer.shipping_state,
            shipping_pin: influencer.shipping_pin,
            shipping_landmark: influencer.shipping_landmark,
            address_type: influencer.address_type
        });
        res.json({ success: true, influencer });
    } catch (error) {
        console.error('Detail influencer error:', error);
        res.status(500).json({ error: 'Failed to fetch influencer' });
    }
});

// Add new influencer (Protected by Admin Auth)
app.post('/api/influencer-admin/add', authenticateAdmin, async (req, res) => {
    try {
        const { name, referralCode, commissionRate, discountValue, displayedCommissionRate, usageLimit, phone } = req.body;
        if (!name || !referralCode) {
            return res.status(400).json({ error: 'Name and referral code are required' });
        }

        // Generate a secure unique token for the link
        const linkToken = crypto.randomBytes(16).toString('hex');

        // Parse values
        const commission = commissionRate !== undefined ? parseFloat(commissionRate) : 7.00;
        const discount = discountValue !== undefined ? parseFloat(discountValue) : commission;
        const displayedCommission = displayedCommissionRate !== undefined ? parseFloat(displayedCommissionRate) : commission;
        const usage = usageLimit !== undefined && usageLimit !== '' ? parseInt(usageLimit) : null;

        // First create the influencer in Supabase
        const influencer = await createInfluencer({
            name,
            referralCode,
            linkToken,
            phone,
            commissionRate: commission,
            discountValue: discount,
            displayedCommissionRate: displayedCommission,
            usageLimit: usage
        });

        // Now create the Shopify discount code
        let shopifyIds = { priceRuleId: null, discountCodeId: null };
        let shopifyWarning = null;
        try {
            shopifyIds = await createShopifyDiscountCode(referralCode, discount, 'percentage', usage, `Influencer: ${name}`);
            
            // Update influencer with Shopify IDs
            await updateInfluencer(influencer.id, {
                shopifyPriceRuleId: shopifyIds.priceRuleId.toString(),
                shopifyDiscountCodeId: shopifyIds.discountCodeId.toString()
            });
        } catch (shopifyError) {
            // Log error but DON'T rollback - influencer is still valuable without Shopify sync
            console.error('Shopify discount creation failed (non-blocking):', shopifyError.message);
            
            // Check if it's a permission error
            if (shopifyError.message.includes('403') || shopifyError.message.includes('write_price_rules')) {
                shopifyWarning = 'Shopify discount code not created: Missing write_price_rules permission. Please enable discount permissions in your Shopify app settings, or create the code manually in Shopify admin.';
            } else {
                shopifyWarning = `Shopify discount code not created: ${shopifyError.message}. You can create it manually in Shopify admin.`;
            }
        }

        // Fetch updated influencer (with or without Shopify IDs)
        const updatedInfluencer = await getInfluencerById(influencer.id);

        res.json({ 
            success: true, 
            influencer: updatedInfluencer,
            warning: shopifyWarning 
        });
    } catch (error) {
        console.error('Add influencer error:', error);
        res.status(500).json({ error: 'Failed to add influencer. Code might already exist.' });
    }
});

// Update influencer (Protected by Admin Auth)
app.patch('/api/influencer-admin/update/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, referralCode, commissionRate, discountValue, displayedCommissionRate, usageLimit, phone, shippingAddress, shippingLandmark, shippingCity, shippingState, shippingPin } = req.body;

        // Get existing influencer to check for Shopify sync
        const existingInfluencer = await getInfluencerById(id);
        if (!existingInfluencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }

        // Update in Supabase first
        const updated = await updateInfluencer(id, {
            name,
            referralCode,
            commissionRate,
            discountValue,
            displayedCommissionRate,
            usageLimit,
            phone,
            shippingAddress,
            shippingLandmark,
            shippingCity,
            shippingState,
            shippingPin
        });

        // Sync with Shopify if discount code details changed
        const codeChanged = referralCode && referralCode !== existingInfluencer.referral_code;
        const discountChanged = discountValue !== undefined && parseFloat(discountValue) !== parseFloat(existingInfluencer.discount_value || existingInfluencer.commission_rate || 7);
        const usageChanged = usageLimit !== undefined && (usageLimit === '' ? null : parseInt(usageLimit)) !== existingInfluencer.usage_limit;

        if (codeChanged || discountChanged || usageChanged) {
            const priceRuleId = existingInfluencer.shopify_price_rule_id;

            if (priceRuleId) {
                // Update existing Shopify discount
                try {
                    const shopifyIds = await updateShopifyDiscountCode(
                        priceRuleId,
                        codeChanged ? referralCode : null,
                        discountChanged ? parseFloat(discountValue) : undefined,
                        usageChanged ? (usageLimit === '' ? null : parseInt(usageLimit)) : undefined
                    );

                    // Update discount code ID if code changed
                    if (shopifyIds.discountCodeId) {
                        await updateInfluencer(id, {
                            shopifyDiscountCodeId: shopifyIds.discountCodeId.toString()
                        });
                    }
                } catch (shopifyError) {
                    console.error('Shopify discount update failed:', shopifyError.message);
                    // Continue anyway - don't block the update if Shopify fails
                }
            } else {
                // Backfill: create new Shopify discount for older influencers
                try {
                    const finalCode = referralCode || existingInfluencer.referral_code;
                    const finalDiscount = discountValue !== undefined ? parseFloat(discountValue) : parseFloat(existingInfluencer.discount_value || existingInfluencer.commission_rate || 7);
                    const finalUsage = usageLimit !== undefined ? (usageLimit === '' ? null : parseInt(usageLimit)) : existingInfluencer.usage_limit;

                    const shopifyIds = await createShopifyDiscountCode(
                        finalCode,
                        finalDiscount,
                        finalUsage,
                        `Influencer: ${name || existingInfluencer.name}`
                    );

                    await updateInfluencer(id, {
                        shopifyPriceRuleId: shopifyIds.priceRuleId.toString(),
                        shopifyDiscountCodeId: shopifyIds.discountCodeId.toString()
                    });
                } catch (shopifyError) {
                    console.error('Shopify discount backfill failed:', shopifyError.message);
                    // Continue anyway
                }
            }
        }

        // Fetch final updated influencer
        const finalInfluencer = await getInfluencerById(id);
        res.json({ success: true, influencer: finalInfluencer });
    } catch (error) {
        console.error('Update influencer error:', error);
        res.status(500).json({ error: 'Failed to update influencer' });
    }
});

// Remove influencer (Protected by Admin Auth)
app.delete('/api/influencer-admin/remove/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get influencer to check for Shopify discount code
        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }

        // Disable Shopify discount code if it exists
        if (influencer.shopify_price_rule_id) {
            await disableShopifyDiscountCode(influencer.shopify_price_rule_id);
        }

        // Delete from Supabase
        await deleteInfluencer(id);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove influencer error:', error);
        res.status(500).json({ error: 'Failed to remove influencer' });
    }
});

// Get Influencer Stats for Admin (with date range filter)
app.get('/api/influencer-admin/stats/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { range } = req.query; // '30d', '90d', 'all'

        // Get influencer details
        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }

        const referralCode = influencer.referral_code;
        const commissionRate = parseFloat(influencer.commission_rate || 7);
        const displayedCommissionRate = parseFloat(influencer.displayed_commission_rate || commissionRate);
        console.log(`[Admin Influencer Stats] Fetching cached stats for ${influencer.name} (Code: ${referralCode})`);

        // FAST: Read pre-calculated stats from Supabase (no Shopify API calls!)

        const { data: influencerData, error } = await supabase
            .from('influencers')
            .select('total_revenue, total_orders, estimated_earnings, stats_last_updated, stats_date_range')
            .eq('id', id)
            .single();

        if (error) {
            console.error('[Admin Influencer Stats] Error fetching stats:', error);
            // Fallback: return zeros if stats columns don't exist yet
            return res.json({
                success: true,
                influencer: {
                    id: influencer.id,
                    name: influencer.name,
                    referralCode: influencer.referral_code,
                    commissionRate: commissionRate,
                    phone: influencer.phone
                },
                stats: {
                    totalRevenue: '0.00',
                    orderCount: 0,
                    aov: '0.00',
                    estimatedEarnings: '0.00',
                    commissionRate,
                    currency: 'INR',
                    dateRange: { from: null, to: null },
                    cached: false,
                    message: 'Stats columns not yet added. Run SQL migration and trigger sync.'
                },
                recentConversions: []
            });
        }

        const totalRevenue = parseFloat(influencerData.total_revenue || 0);
        const orderCount = parseInt(influencerData.total_orders || 0);
        const estimatedEarnings = parseFloat(influencerData.estimated_earnings || 0);
        const aov = orderCount > 0 ? (totalRevenue / orderCount) : 0;

        console.log(`[Admin Influencer Stats] ✅ Cached stats: ${orderCount} orders, ₹${totalRevenue} revenue`);

        res.json({
            success: true,
            influencer: {
                id: influencer.id,
                name: influencer.name,
                referralCode: influencer.referral_code,
                commissionRate: commissionRate,
                displayedCommissionRate: displayedCommissionRate,
                phone: influencer.phone
            },
            stats: {
                totalRevenue: totalRevenue.toFixed(2),
                orderCount,
                aov: aov.toFixed(2),
                estimatedEarnings: estimatedEarnings.toFixed(2),
                commissionRate,
                displayedCommissionRate: displayedCommissionRate,
                currency: 'INR',
                dateRange: {
                    from: influencerData.stats_date_range || 'last_60_days',
                    to: influencerData.stats_last_updated || null
                },
                cached: true,
                lastUpdated: influencerData.stats_last_updated
            },
            recentConversions: Array.isArray(influencer.recent_conversions_cache) ? influencer.recent_conversions_cache : []
        });

    } catch (error) {
        console.error('Admin influencer stats error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch influencer stats',
            details: error.message
        });
    }
});

// Get Recent Conversions for an Influencer (fetches actual order details from Shopify)
app.get('/api/influencer-admin/conversions/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { range } = req.query; // '30d', '90d', 'all'

        console.log(`[Admin Conversions] Fetching cached conversions for influencer ${id} (range: ${range || 'all'})`);

        // Get influencer details
        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }

        // Calculate date range for filter
        let createdAtMin = null;
        if (range === '30d') {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            createdAtMin = d.toISOString();
        } else if (range === '90d') {
            const d = new Date();
            d.setDate(d.getDate() - 90);
            createdAtMin = d.toISOString();
        }
        // 'all' => no date filter (return everything we have)


        // Fast path: if range='all' AND we have a cached JSON snapshot, return it immediately
        if (!createdAtMin && Array.isArray(influencer.recent_conversions_cache) && influencer.recent_conversions_cache.length > 0) {
            console.log(`[Admin Conversions] ✅ Returning cached snapshot (${influencer.recent_conversions_cache.length} items)`);
            return res.json({
                success: true,
                conversions: influencer.recent_conversions_cache,
                totalCount: parseInt(influencer.total_orders || influencer.recent_conversions_cache.length),
                cached: true,
                lastUpdated: influencer.recent_conversions_updated_at,
                dateRange: { from: null, to: new Date().toISOString() }
            });
        }

        // Build query against influencer_orders (indexed, fast)
        let query = supabase
            .from('influencer_orders')
            .select('shopify_order_id, order_name, total_price, currency, financial_status, customer_name, order_created_at, referral_code, cancelled_at', { count: 'exact' })
            .eq('influencer_id', id)
            .is('cancelled_at', null)
            .in('financial_status', ['paid', 'partially_paid', 'pending', 'authorized'])
            .order('order_created_at', { ascending: false })
            .limit(20);

        if (createdAtMin) {
            query = query.gte('order_created_at', createdAtMin);
        }

        const { data: orderRows, count, error: qErr } = await query;

        if (qErr) {
            console.error('[Admin Conversions] Query error:', qErr.message);
            return res.status(500).json({
                error: 'Failed to fetch conversions',
                details: qErr.message,
                hint: 'Make sure influencer_orders table exists (run supabase_migration_influencer_orders.sql)'
            });
        }

        const conversions = (orderRows || []).map(r => ({
            id: r.shopify_order_id,
            orderName: r.order_name,
            total: parseFloat(r.total_price).toFixed(2),
            currency: r.currency || 'INR',
            date: r.order_created_at,
            customerName: r.customer_name || 'Guest',
            discountCode: r.referral_code
        }));

        console.log(`[Admin Conversions] ✅ Returned ${conversions.length} of ${count} orders`);

        res.json({
            success: true,
            conversions,
            totalCount: count || conversions.length,
            cached: true,
            dateRange: {
                from: createdAtMin,
                to: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Admin conversions error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Failed to fetch conversions',
                details: error.message
            });
        }
    }
});

// ==================== INFLUENCER APPLICATION & PAYOUT ADMIN ENDPOINTS ====================

// Bulk approve multiple influencer applications
app.post('/api/influencer-admin/bulk-approve', authenticateAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Array of influencer IDs is required' });
        }

        const results = {
            success: [],
            failed: []
        };

        for (const id of ids) {
            try {
                const influencer = await getInfluencerById(id);
                if (!influencer) {
                    results.failed.push({ id, error: 'Influencer not found' });
                    continue;
                }

                if (influencer.status === 'active') {
                    results.success.push({ id, message: 'Already active' });
                    continue;
                }

                let discountCodeId = influencer.shopify_discount_code_id;
                let shopifyWarning = null;

                // Attach the live discount code in Shopify
                if (influencer.shopify_price_rule_id) {
                    try {
                        const result = await activateShopifyDiscountCode(influencer.shopify_price_rule_id, influencer.referral_code);
                        discountCodeId = result.discountCodeId ? String(result.discountCodeId) : discountCodeId;
                    } catch (shopifyError) {
                        console.error(`Shopify activation failed for ${id}:`, shopifyError.message);
                        shopifyWarning = `Shopify activation failed: ${shopifyError.message}`;
                    }
                } else {
                    // No draft price rule exists. Create a fresh code.
                    try {
                        const discount = parseFloat(influencer.discount_value || influencer.commission_rate || 7);
                        const usage = influencer.usage_limit || null;
                        const shopifyIds = await createShopifyDiscountCode(
                            influencer.referral_code,
                            discount,
                            'percentage',
                            usage,
                            `Influencer: ${influencer.name}`
                        );
                        await updateInfluencer(id, {
                            shopifyPriceRuleId: String(shopifyIds.priceRuleId),
                            shopifyDiscountCodeId: String(shopifyIds.discountCodeId)
                        });
                        discountCodeId = String(shopifyIds.discountCodeId);
                    } catch (shopifyError) {
                        console.error(`Shopify fresh-create failed for ${id}:`, shopifyError.message);
                        shopifyWarning = `Shopify code could not be created: ${shopifyError.message}`;
                    }
                }

                await updateInfluencer(id, {
                    status: 'active',
                    isActive: true,
                    approvedAt: new Date().toISOString(),
                    shopifyDiscountCodeId: discountCodeId || undefined
                });

                results.success.push({ id, warning: shopifyWarning });
            } catch (error) {
                console.error(`Bulk approve failed for ${id}:`, error);
                results.failed.push({ id, error: error.message });
            }
        }

        res.json({ 
            success: true, 
            results,
            summary: {
                total: ids.length,
                succeeded: results.success.length,
                failed: results.failed.length
            }
        });
    } catch (error) {
        console.error('Bulk approve error:', error);
        res.status(500).json({ error: 'Failed to bulk approve influencers' });
    }
});

// Bulk reject multiple influencer applications
app.post('/api/influencer-admin/bulk-reject', authenticateAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Array of influencer IDs is required' });
        }

        const results = {
            success: [],
            failed: []
        };

        for (const id of ids) {
            try {
                const influencer = await getInfluencerById(id);
                if (!influencer) {
                    results.failed.push({ id, error: 'Influencer not found' });
                    continue;
                }

                if (influencer.shopify_price_rule_id) {
                    await disableShopifyDiscountCode(influencer.shopify_price_rule_id);
                }

                await updateInfluencer(id, { status: 'rejected', isActive: false });
                results.success.push({ id });
            } catch (error) {
                console.error(`Bulk reject failed for ${id}:`, error);
                results.failed.push({ id, error: error.message });
            }
        }

        res.json({ 
            success: true, 
            results,
            summary: {
                total: ids.length,
                succeeded: results.success.length,
                failed: results.failed.length
            }
        });
    } catch (error) {
        console.error('Bulk reject error:', error);
        res.status(500).json({ error: 'Failed to bulk reject influencers' });
    }
});

// Approve a pending influencer application (attaches the Shopify discount code)
app.post('/api/influencer-admin/approve/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }
        if (influencer.status === 'active') {
            return res.json({ success: true, influencer, message: 'Already active' });
        }

        let discountCodeId = influencer.shopify_discount_code_id;
        let shopifyWarning = null;

        // Attach the live discount code in Shopify
        if (influencer.shopify_price_rule_id) {
            try {
                const result = await activateShopifyDiscountCode(influencer.shopify_price_rule_id, influencer.referral_code);
                discountCodeId = result.discountCodeId ? String(result.discountCodeId) : discountCodeId;
            } catch (shopifyError) {
                console.error('Shopify activation failed:', shopifyError.message);
                shopifyWarning = `Shopify activation failed: ${shopifyError.message}. You may need to attach the discount code manually.`;
            }
        } else {
            // No draft price rule exists (maybe initial draft creation failed). Create a fresh code.
            try {
                const discount = parseFloat(influencer.discount_value || influencer.commission_rate || 7);
                const usage = influencer.usage_limit || null;
                const shopifyIds = await createShopifyDiscountCode(
                    influencer.referral_code,
                    discount,
                    'percentage',
                    usage,
                    `Influencer: ${influencer.name}`
                );
                await updateInfluencer(id, {
                    shopifyPriceRuleId: String(shopifyIds.priceRuleId),
                    shopifyDiscountCodeId: String(shopifyIds.discountCodeId)
                });
                discountCodeId = String(shopifyIds.discountCodeId);
            } catch (shopifyError) {
                console.error('Shopify fresh-create failed on approve:', shopifyError.message);
                shopifyWarning = `Shopify code could not be created: ${shopifyError.message}`;
            }
        }

        await updateInfluencer(id, {
            status: 'active',
            isActive: true,
            approvedAt: new Date().toISOString(),
            shopifyDiscountCodeId: discountCodeId || undefined
        });

        const updated = await getInfluencerById(id);
        res.json({ success: true, influencer: updated, warning: shopifyWarning });
    } catch (error) {
        console.error('Approve influencer error:', error);
        res.status(500).json({ error: 'Failed to approve influencer' });
    }
});

// Reject a pending influencer application
app.post('/api/influencer-admin/reject/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }

        if (influencer.shopify_price_rule_id) {
            await disableShopifyDiscountCode(influencer.shopify_price_rule_id);
        }

        await updateInfluencer(id, { status: 'rejected', isActive: false });
        const updated = await getInfluencerById(id);
        res.json({ success: true, influencer: updated });
    } catch (error) {
        console.error('Reject influencer error:', error);
        res.status(500).json({ error: 'Failed to reject influencer' });
    }
});

// List payouts for an influencer (admin)
app.get('/api/influencer-admin/payouts/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const payouts = await listPayouts(id);
        res.json({ success: true, payouts });
    } catch (error) {
        console.error('List payouts error:', error);
        res.status(500).json({ error: 'Failed to fetch payouts', details: error.message });
    }
});

// Add a payout entry for an influencer (admin)
app.post('/api/influencer-admin/payouts/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { periodStart, periodEnd, amount, notes, currency, reference } = req.body;

        if (!periodStart || !periodEnd || amount === undefined || amount === null || amount === '') {
            return res.status(400).json({ error: 'periodStart, periodEnd, and amount are required' });
        }
        if (isNaN(parseFloat(amount)) || parseFloat(amount) < 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        if (new Date(periodStart) > new Date(periodEnd)) {
            return res.status(400).json({ error: 'periodStart cannot be after periodEnd' });
        }

        const influencer = await getInfluencerById(id);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }

        const payout = await createPayout({
            influencerId: id,
            periodStart,
            periodEnd,
            amount,
            currency: currency || 'INR',
            status: 'pending',
            reference,
            notes
        });
        res.json({ success: true, payout });
    } catch (error) {
        console.error('Create payout error:', error);
        res.status(500).json({ error: 'Failed to create payout', details: error.message });
    }
});

// Update payout status (admin: mark paid / cancel)
app.patch('/api/influencer-admin/payouts/item/:payoutId', authenticateAdmin, async (req, res) => {
    try {
        const { payoutId } = req.params;
        const { status, reference } = req.body;

        if (!['paid', 'pending', 'cancelled'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status (must be paid, pending, or cancelled)' });
        }

        const existing = await getPayoutById(payoutId);
        if (!existing) {
            return res.status(404).json({ error: 'Payout not found' });
        }

        const payout = await updatePayoutStatus(payoutId, status, reference);
        res.json({ success: true, payout });
    } catch (error) {
        console.error('Update payout error:', error);
        res.status(500).json({ error: 'Failed to update payout', details: error.message });
    }
});

// GET influencer admin notes
app.get('/api/influencer-admin/:id/notes', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        console.log('[Notes API] Fetching notes for influencer:', id, 'type:', typeof id);
        
        const { data: notes, error } = await supabase
            .from('admin_notes')
            .select('*')
            .eq('influencer_id', id)
            .order('created_at', { ascending: false });
        if (error) {
            console.error('[Notes API] Supabase error:', error);
            throw error;
        }
        console.log('[Notes API] Found', notes?.length || 0, 'notes');
        if (notes && notes.length > 0) {
            console.log('[Notes API] Latest note:', notes[0]);
        }
        res.json({ success: true, notes: notes || [] });
    } catch (error) {
        console.error('Get notes error:', error);
        res.json({ success: true, notes: [] });
    }
});

// POST influencer admin note
app.post('/api/influencer-admin/:id/notes', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { note } = req.body;
        if (!note) return res.status(400).json({ error: 'Note text is required' });
        const adminName = req.admin?.name || 'Admin';
        const { data, error } = await supabase
            .from('admin_notes')
            .insert({ influencer_id: id, admin_name: adminName, note_text: note })
            .select()
            .single();
        if (error) throw error;
        res.json({ success: true, note: data });
    } catch (error) {
        console.error('Add note error:', error);
        res.status(500).json({ error: 'Failed to add note' });
    }
});

// PATCH influencer target/tier
app.patch('/api/influencer-admin/:id/target', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { monthlyTarget, tierOverride } = req.body;
        const updates = {};
        if (monthlyTarget !== undefined) updates.monthly_target = parseInt(monthlyTarget);
        if (tierOverride !== undefined) updates.tier_override = parseInt(tierOverride);
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });
        const influencer = await updateInfluencer(id, updates);
        res.json({ success: true, influencer });
    } catch (error) {
        console.error('Update target error:', error);
        res.status(500).json({ error: 'Failed to update' });
    }
});

// ==================== INFLUENCER PORTAL ENDPOINTS ====================

// Verify Influencer Token & Get Profile
app.get('/api/influencer/auth/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const influencer = await getInfluencerByToken(token);

        if (!influencer) {
            return res.status(401).json({ error: 'Invalid or inactive influencer link' });
        }

        res.json({
            success: true,
            influencer: {
                name: influencer.name,
                referralCode: influencer.referral_code,
                hasPhone: !!influencer.phone,
                status: influencer.status || (influencer.is_active ? 'active' : 'suspended'),
                usageLimit: influencer.usage_limit || null,
                discountValue: influencer.discount_value || influencer.commission_rate || 7
            }
        });
    } catch (error) {
        console.error('Influencer auth error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Verify Phone Number for Influencer Login
app.post('/api/influencer/verify', async (req, res) => {
    try {
        const { token, phone } = req.body;
        const influencer = await getInfluencerByToken(token);

        if (!influencer) {
            return res.status(401).json({ error: 'Invalid or inactive influencer link' });
        }

        // Normalize both phones to 10-digit format for comparison
        // Database may have 91XXXXXXXXXX (12 digits) or XXXXXXXXXX (10 digits)
        const cleanDbPhone = (influencer.phone || '').replace(/\D/g, '');
        const cleanInputPhone = (phone || '').replace(/\D/g, '');
        
        // Extract last 10 digits from database phone (handles both 91-prefixed and raw formats)
        const dbPhone10 = cleanDbPhone.length >= 10 ? cleanDbPhone.slice(-10) : cleanDbPhone;
        const inputPhone10 = cleanInputPhone.length >= 10 ? cleanInputPhone.slice(-10) : cleanInputPhone;

        if (inputPhone10 === dbPhone10 && dbPhone10.length >= 10) {
            res.json({ success: true });
        } else {
            res.status(401).json({ error: 'Incorrect phone number. Please check and try again.' });
        }
    } catch (error) {
        console.error('Influencer verify error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Get Performance Stats for Influencer (with pagination + date range)
app.get('/api/influencer/stats/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { range, startDate, endDate } = req.query; // '30d', '90d', 'custom', or 'all'

        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid or inactive influencer link' });
        }

        const referralCode = influencer.referral_code;
        const commissionRate = parseFloat(influencer.commission_rate || 7);
        console.log(`[Influencer Stats] Fetching cached stats for ${influencer.name} (Code: ${referralCode}, Range: ${range || 'all'})`);

        // Determine date range
        let createdAtMin = null;
        let createdAtMax = null;
        if (range === '30d') {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            createdAtMin = d.toISOString();
        } else if (range === '90d') {
            const d = new Date();
            d.setDate(d.getDate() - 90);
            createdAtMin = d.toISOString();
        } else if (range === 'custom' && startDate && endDate) {
            createdAtMin = new Date(startDate).toISOString();
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            createdAtMax = end.toISOString();
        }
        // 'all' => no date filter


        // Fast path for range='all': use pre-aggregated stats + cached conversions
        if (!createdAtMin && !createdAtMax) {
            const totalRevenue = parseFloat(influencer.total_revenue || 0);
            const orderCount = parseInt(influencer.total_orders || 0);
            const estimatedEarnings = parseFloat(influencer.estimated_earnings || 0);
            const aov = orderCount > 0 ? (totalRevenue / orderCount) : 0;
            const recentConversions = Array.isArray(influencer.recent_conversions_cache)
                ? influencer.recent_conversions_cache.map(c => ({
                    id: c.id,
                    name: c.orderName,
                    total: c.total,
                    currency: c.currency,
                    date: c.date
                }))
                : [];

            console.log(`[Influencer Stats] ✅ Cached all-time stats: ${orderCount} orders, ₹${totalRevenue.toFixed(2)}`);

            return res.json({
                success: true,
                stats: {
                    totalRevenue: totalRevenue.toFixed(2),
                    orderCount,
                    aov: aov.toFixed(2),
                    estimatedEarnings: estimatedEarnings.toFixed(2),
                    commissionRate,
                    currency: recentConversions[0]?.currency || 'INR'
                },
                recentConversions,
                cached: true,
                lastUpdated: influencer.stats_last_updated
            });
        }

        // Date-range query: aggregate from influencer_orders
        let query = supabase
            .from('influencer_orders')
            .select('shopify_order_id, order_name, total_price, currency, order_created_at')
            .eq('influencer_id', influencer.id)
            .is('cancelled_at', null)
            .in('financial_status', ['paid', 'partially_paid', 'pending', 'authorized'])
            .order('order_created_at', { ascending: false });

        if (createdAtMin) query = query.gte('order_created_at', createdAtMin);
        if (createdAtMax) query = query.lte('order_created_at', createdAtMax);

        const { data: orderRows, error: qErr } = await query;

        if (qErr) {
            console.error('[Influencer Stats] Query error:', qErr.message);
            return res.status(500).json({
                error: 'Failed to fetch performance data',
                details: qErr.message,
                hint: 'Make sure influencer_orders table exists (run supabase_migration_influencer_orders.sql)'
            });
        }

        const orders = orderRows || [];
        const totalRevenue = orders.reduce((s, r) => s + parseFloat(r.total_price || 0), 0);
        const orderCount = orders.length;
        const aov = orderCount > 0 ? (totalRevenue / orderCount) : 0;
        const estimatedEarnings = totalRevenue * (commissionRate / 100);

        const recentConversions = orders.slice(0, 20).map(r => ({
            id: r.shopify_order_id,
            name: r.order_name,
            total: r.total_price,
            currency: r.currency,
            date: r.order_created_at
        }));

        console.log(`[Influencer Stats] ✅ Filtered stats: ${orderCount} orders, ₹${totalRevenue.toFixed(2)}`);

        res.json({
            success: true,
            stats: {
                totalRevenue: totalRevenue.toFixed(2),
                orderCount,
                aov: aov.toFixed(2),
                estimatedEarnings: estimatedEarnings.toFixed(2),
                commissionRate,
                currency: orders[0]?.currency || 'INR'
            },
            recentConversions,
            cached: true
        });

    } catch (error) {
        console.error('Influencer stats error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Failed to fetch performance data',
                details: error.message
            });
        }
    }
});

// ==================== INFLUENCER SELF-SIGNUP (PUBLIC) ====================

// Helper: normalize and reserve a unique referral code
function normalizeReferralCode(raw) {
    return String(raw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 20);
}

// POST /api/influencer/apply - Public self-signup
app.post('/api/influencer/apply', async (req, res) => {
    try {
        const {
            name,
            phone,
            email,
            instagramHandle,
            youtubeHandle,
            followerCount,
            followerTier,
            niche,
            city,
            whyJoin,
            preferredCode,
            payoutUpi,
            contentWeeklyCount,
            heightCm,
            weightKg,
            shippingAddress,
            shippingCity,
            shippingState,
            shippingPin,
            shippingLandmark,
            addressType,
            selectedProducts
        } = req.body || {};

        if (!name || !phone || !email || !instagramHandle || !preferredCode) {
            return res.status(400).json({
                error: 'Missing required fields',
                field: !name ? 'name' : !phone ? 'phone' : !email ? 'email' : !instagramHandle ? 'instagramHandle' : 'preferredCode'
            });
        }
        if (followerCount === null || followerCount === undefined || followerCount < 0) {
            return res.status(400).json({ error: 'Please enter a valid follower count', field: 'followerCount' });
        }
        if (!niche) {
            return res.status(400).json({ error: 'Please select a niche', field: 'niche' });
        }
        if (!contentWeeklyCount || contentWeeklyCount < 1) {
            return res.status(400).json({ error: 'Please enter content delivery commitment', field: 'contentWeekly' });
        }
        if (!heightCm || heightCm < 100) {
            return res.status(400).json({ error: 'Please enter a valid height', field: 'heightCm' });
        }
        if (!weightKg || weightKg < 30) {
            return res.status(400).json({ error: 'Please enter a valid weight', field: 'weightKg' });
        }
        if (!shippingAddress || !shippingCity || !shippingState || !shippingPin) {
            return res.status(400).json({ error: 'Complete shipping address is required' });
        }
        if (shippingPin && shippingPin.length !== 6) {
            return res.status(400).json({ error: 'PIN code must be 6 digits', field: 'shippingPin' });
        }
        if (!selectedProducts || !Array.isArray(selectedProducts) || selectedProducts.length === 0) {
            return res.status(400).json({ error: 'Please select at least 1 product', field: 'selectedProducts' });
        }
        const cleanPhone = String(phone).replace(/\D/g, '');
        if (cleanPhone.length < 10) {
            return res.status(400).json({ error: 'Phone must be at least 10 digits', field: 'phone' });
        }
        const cleanEmail = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return res.status(400).json({ error: 'Invalid email address', field: 'email' });
        }

        let finalCode = normalizeReferralCode(preferredCode);
        if (finalCode.length < 4) {
            return res.status(400).json({ error: 'Referral code must be at least 4 alphanumeric characters', field: 'preferredCode' });
        }

        // Duplicate checks
        if (await isEmailTaken(cleanEmail)) {
            return res.status(409).json({ error: 'This email is already registered.', field: 'email' });
        }
        if (await isPhoneTaken(cleanPhone)) {
            return res.status(409).json({ error: 'This phone number is already registered.', field: 'phone' });
        }

        // Referral code: try preferred first, then one suffixed retry
        if (await isReferralCodeTaken(finalCode)) {
            const suffix = String(Math.floor(100 + Math.random() * 900));
            const retryCode = (finalCode + suffix).slice(0, 20);
            if (await isReferralCodeTaken(retryCode)) {
                return res.status(409).json({
                    error: 'That referral code is taken. Please choose a different one.',
                    field: 'preferredCode'
                });
            }
            finalCode = retryCode;
        }

        // ── Create influencer (pending) ──
        const linkToken = crypto.randomBytes(16).toString('hex');
        const followers = followerCount !== undefined && followerCount !== ''
            ? parseInt(followerCount) || 0
            : null;

        // Calculate tier, monthly target, and validate product limit
        const appFollowerNum = parseInt(followerCount) || 0;
        let appTierInfo = { tier: 'Rising Star', limit: 2 };
        if (appFollowerNum >= 500000) appTierInfo = { tier: 'Top Tier Creator', limit: 5 };
        else if (appFollowerNum >= 100000) appTierInfo = { tier: 'Established Influencer', limit: 4 };
        else if (appFollowerNum >= 50000) appTierInfo = { tier: 'Growing Creator', limit: 3 };
        
        if (selectedProducts.length > appTierInfo.limit) {
            return res.status(400).json({ error: 'Your tier allows only ' + appTierInfo.limit + ' products', field: 'selectedProducts' });
        }

        const monthlyTarget = (parseInt(contentWeeklyCount) || 3) * 4;

        const influencer = await createInfluencer({
            name: String(name).trim(),
            referralCode: finalCode,
            linkToken,
            phone: cleanPhone,
            commissionRate: 7,
            discountValue: 7,
            usageLimit: null,
            isActive: false,
            status: 'pending',
            email: cleanEmail,
            instagramHandle: String(instagramHandle).trim(),
            youtubeHandle: youtubeHandle ? String(youtubeHandle).trim() : null,
            followerCount: followers,
            followerTier: followerTier || tierInfo.tier,
            niche: niche ? String(niche).trim() : null,
            city: city ? String(city).trim() : null,
            whyJoin: whyJoin ? String(whyJoin).trim().slice(0, 1000) : null,
            payoutUpi: payoutUpi ? String(payoutUpi).trim() : null,
            appliedAt: new Date().toISOString(),
            contentWeeklyCount: parseInt(contentWeeklyCount) || 3,
            monthlyTarget: monthlyTarget,
            heightCm: parseFloat(heightCm) || null,
            weightKg: parseFloat(weightKg) || null,
            shippingAddress: String(shippingAddress).trim(),
            shippingCity: String(shippingCity).trim(),
            shippingState: String(shippingState).trim(),
            shippingPin: String(shippingPin).trim(),
            shippingLandmark: shippingLandmark ? String(shippingLandmark).trim() : null,
            addressType: addressType || 'home',
            selectedProducts: JSON.stringify(selectedProducts)
        });

        // ── Auto-create product requests for selected products ──
        try {
            for (const product of selectedProducts) {
                const selectedSize = product.size || 'Not specified';
                await createProductRequest({
                    influencerId: influencer.id,
                    productTitle: product.title || product.productTitle || 'Unknown Product',
                    productImageUrl: product.image || product.imageUrl || product.productImageUrl || null,
                    shopifyProductId: product.id || product.shopifyProductId || null,
                    shopifyVariantId: product.variantId || product.shopifyVariantId || null,
                    reason: `Selected during application - Tier: ${appTierInfo.tier} | Size: ${selectedSize}`,
                    shippingFullName: String(name).trim(),
                    shippingAddressLine1: String(shippingAddress).trim(),
                    shippingAddressLine2: shippingLandmark ? String(shippingLandmark).trim() : null,
                    shippingCity: String(shippingCity).trim(),
                    shippingState: String(shippingState).trim(),
                    shippingPincode: String(shippingPin).trim(),
                    shippingPhone: cleanPhone
                });
            }
            console.log(`Created ${selectedProducts.length} product request(s) for influencer ${influencer.id}`);
        } catch (productRequestError) {
            console.error('Failed to create product requests (non-blocking):', productRequestError);
            // Don't fail the application if product request creation fails
        }

        // ── Create DRAFT Shopify price rule (no discount_code attached yet) ──
        let shopifyWarning = null;
        try {
            const draft = await createShopifyDiscountDraft(finalCode, 7, null, `Influencer (Pending): ${name}`);
            await updateInfluencer(influencer.id, {
                shopifyPriceRuleId: String(draft.priceRuleId)
            });
        } catch (shopifyError) {
            console.error('Shopify draft creation failed (non-blocking):', shopifyError.message);
            shopifyWarning = 'Your application is received, but our discount system is temporarily unavailable. Our team will create your code manually.';
        }

        // Build portal URL
        const storeBase = process.env.SHOPIFY_STORE_DOMAIN
            ? `https://${process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '')}`
            : (process.env.STORE_BASE_URL || '');
        const portalUrl = `${storeBase}/pages/influencer-portal?token=${linkToken}`;

        return res.json({
            success: true,
            status: 'pending',
            referralCode: finalCode,
            portalUrl,
            warning: shopifyWarning,
            message: 'Application received. Your code will be activated within 24 hours.'
        });
    } catch (error) {
        console.error('Influencer apply error:', error);
        res.status(500).json({ error: 'Failed to submit application. Please try again later.' });
    }
});

// GET /api/influencer/products - Fetch ALL available products from Shopify with pagination
app.get('/api/influencer/products', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const search = (req.query.search || '').trim().toLowerCase();
        
        // Fetch ALL active products from Shopify (uses cache)
        const allProducts = await fetchAllShopifyProducts();
        
        // Filter to only products with inventory > 0
        let products = filterProductsWithInventory(allProducts)
            .map(p => {
                const availableVariants = p.variants;
                const firstVariant = availableVariants[0];
                return {
                    id: String(p.id),
                    title: p.title,
                    image: p.image ? p.image.src : (p.images && p.images.length > 0 ? p.images[0].src : null),
                    price: firstVariant ? firstVariant.price : '0.00',
                    available: true,
                    sizes: availableVariants.map(v => ({
                        id: String(v.id),
                        title: v.title || 'Default',
                        stock: v.inventory_quantity
                    }))
                };
            });
        
        // Apply search filter if provided
        if (search) {
            products = products.filter(p => p.title.toLowerCase().includes(search));
        }
        
        const totalProducts = products.length;
        const totalPages = Math.ceil(totalProducts / limit);
        const startIdx = (page - 1) * limit;
        const paginatedProducts = products.slice(startIdx, startIdx + limit);
        
        return res.json({
            success: true,
            products: paginatedProducts,
            pagination: {
                page,
                limit,
                totalProducts,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        });
    } catch (error) {
        console.error('Products fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch products', products: [], pagination: { page: 1, totalProducts: 0, totalPages: 0 } });
    }
});

// GET /api/influencer/tiers - Get tier configuration
app.get('/api/influencer/tiers', async (req, res) => {
    const tiers = [
        { name: 'Rising Star', minFollowers: 0, maxFollowers: 49999, productLimit: 2, tierColor: '#3b82f6' },
        { name: 'Growing Creator', minFollowers: 50000, maxFollowers: 99999, productLimit: 3, tierColor: '#22c55e' },
        { name: 'Established Influencer', minFollowers: 100000, maxFollowers: 499999, productLimit: 4, tierColor: '#a855f7' },
        { name: 'Top Tier Creator', minFollowers: 500000, maxFollowers: null, productLimit: 5, tierColor: '#f59e0b' }
    ];
    return res.json({ success: true, tiers });
});

// GET /api/influencer/payouts/:token - Influencer-facing payout history
app.get('/api/influencer/payouts/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid or inactive influencer link' });
        }

        const payouts = await listPayouts(influencer.id);

        // Summary metrics
        let totalPaid = 0;
        let pendingAmount = 0;
        let paidCount = 0;
        let pendingCount = 0;
        let lastPeriodEnd = null;
        for (const p of payouts) {
            const amt = parseFloat(p.amount || 0);
            if (p.status === 'paid') { totalPaid += amt; paidCount += 1; }
            if (p.status === 'pending') { pendingAmount += amt; pendingCount += 1; }
            if (p.period_end && (!lastPeriodEnd || p.period_end > lastPeriodEnd)) {
                lastPeriodEnd = p.period_end;
            }
        }

        let nextExpected = null;
        if (lastPeriodEnd) {
            const d = new Date(lastPeriodEnd);
            d.setDate(d.getDate() + 7);
            nextExpected = d.toISOString().slice(0, 10);
        }

        res.json({
            success: true,
            currency: payouts[0]?.currency || 'INR',
            summary: {
                totalPaid: totalPaid.toFixed(2),
                pendingAmount: pendingAmount.toFixed(2),
                paidCount,
                pendingCount,
                nextExpected
            },
            payouts: payouts.map(p => ({
                id: p.id,
                period_start: p.period_start,
                period_end: p.period_end,
                amount: parseFloat(p.amount).toFixed(2),
                currency: p.currency || 'INR',
                status: p.status,
                paid_at: p.paid_at,
                reference: p.reference,
                notes: p.notes
            }))
        });
    } catch (error) {
        console.error('Influencer payouts fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch payouts' });
    }
});

// ==================== INFLUENCER ANALYTICS & SHIPMENTS ====================

// Admin: Create manual shipment with Delhivery booking (MUST be before /:influencerId to avoid route conflict)
app.post('/api/influencer-admin/shipments/manual', authenticateAdmin, async (req, res) => {
    try {
        const {
            influencerId,
            productTitle,
            productImageUrl,
            reelDueDate,
            isMonthlyTarget,
            shippingFullName,
            shippingAddressLine1,
            shippingAddressLine2,
            shippingCity,
            shippingState,
            shippingPincode,
            shippingPhone,
            notes
        } = req.body;
        
        // Validate required fields
        if (!influencerId || !productTitle || !reelDueDate || !shippingFullName || 
            !shippingAddressLine1 || !shippingCity || !shippingState || !shippingPincode || !shippingPhone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Validate pincode format
        if (!/^[0-9]{6}$/.test(shippingPincode)) {
            return res.status(400).json({ error: 'Invalid pincode format' });
        }
        
        // Validate phone format
        if (!/^[0-9]{10}$/.test(shippingPhone)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }
        
        // Get influencer for Delhivery booking
        const influencer = await getInfluencerById(influencerId);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }
        
        // Create shipment record (pass camelCase keys as expected by createShipment)
        const shipment = await createShipment({
            influencerId: influencerId,
            productTitle: productTitle,
            productImageUrl: productImageUrl || null,
            sentAt: new Date().toISOString(),
            reelDueDate: reelDueDate,
            notes: notes || null
        });
        
        // Auto-book via Delhivery
        let delhiveryResult = null;
        try {
            const delhiveryShipmentData = {
                requestId: `INF-${String(shipment.id).substring(0, 8)}`,
                customerName: shippingFullName,
                customerAddress: shippingAddressLine1 + (shippingAddressLine2 ? ', ' + shippingAddressLine2 : ''),
                customerCity: shippingCity,
                customerState: shippingState,
                customerPincode: shippingPincode,
                customerPhone: shippingPhone,
                items: [{ name: productTitle, quantity: 1, price: 0 }]
            };
            
            delhiveryResult = await createDelhiveryForwardOrder(delhiveryShipmentData, null);
            
            // Update shipment with Delhivery details
            if (delhiveryResult && delhiveryResult.waybill) {
                await updateShipment(shipment.id, {
                    delhivery_awb: delhiveryResult.waybill,
                    delhivery_shipment_id: delhiveryResult.shipment_id
                });
            }
        } catch (delhiveryError) {
            console.error('Delhivery booking failed for manual shipment:', delhiveryError.message);
            // Don't fail the request, shipment is created even if Delhivery fails
        }
        
        res.json({ 
            success: true, 
            shipment,
            delhivery: delhiveryResult
        });
    } catch (error) {
        console.error('Create manual shipment error:', error);
        res.status(500).json({ error: 'Failed to create shipment' });
    }
});

// List ALL shipments (admin - all influencers)
app.get('/api/influencer-admin/shipments/all', authenticateAdmin, async (req, res) => {
    try {
        const shipments = await listShipments();
        
        // Enrich with influencer data
        const enriched = await Promise.all(
            shipments.map(async (s) => {
                const influencer = await getInfluencerById(s.influencer_id);
                return {
                    ...s,
                    influencers: influencer ? {
                        name: influencer.name,
                        referral_code: influencer.referral_code,
                        phone: influencer.phone
                    } : null
                };
            })
        );
        
        res.json({ success: true, shipments: enriched });
    } catch (error) {
        console.error('List all shipments error:', error);
        res.json({ success: true, shipments: [] });
    }
});

// Create shipment from product inventory (admin)
app.post('/api/influencer-admin/shipments', authenticateAdmin, async (req, res) => {
    try {
        const {
            influencerId,
            products, // Array of {productTitle, productImageUrl, shopifyProductId, variantId, size, quantity}
            sentAt,
            reelDueDate, // Optional for inventory-based shipments
            isMonthlyTarget,
            notes,
            // Shipping address fields
            shippingFullName,
            shippingAddressLine1,
            shippingAddressLine2,
            shippingCity,
            shippingState,
            shippingPincode,
            shippingPhone
        } = req.body;
        
        // Validate required fields
        if (!influencerId || !products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'influencerId and products array are required' });
        }
        
        if (!sentAt) {
            return res.status(400).json({ error: 'sentAt is required' });
        }
        
        // Reel due date is optional for inventory-based shipments
        // If not provided, set to null
        
        const influencer = await getInfluencerById(influencerId);
        if (!influencer) {
            return res.status(404).json({ error: 'Influencer not found' });
        }
        
        // Check if we have any address data to work with
        const hasAnyAddress = shippingAddressLine1 || influencer.shipping_address || influencer.city;
        
        // If no address data at all, return error
        if (!hasAnyAddress && !shippingFullName) {
            return res.status(400).json({ 
                error: 'No shipping address found. Please provide shipping address or update influencer profile.',
                needsAddress: true,
                influencer: {
                    id: influencer.id,
                    name: influencer.name,
                    phone: influencer.phone,
                    existingAddress: influencer.shipping_address,
                    existingCity: influencer.city,
                    existingState: influencer.shipping_state,
                    existingPincode: influencer.shipping_pin,
                    existingPhone: influencer.phone
                }
            });
        }
        
        // Resolve shipping address — prioritize request body, fall back to influencer DB fields
        let shipFullName = shippingFullName || influencer.shipping_name || influencer.name || '';
        let shipAddress1 = shippingAddressLine1 || influencer.shipping_address || '';
        let shipAddress2 = shippingAddressLine2 || influencer.shipping_address_line2 || '';
        let shipCity = shippingCity || influencer.city || '';
        let shipState = shippingState || influencer.shipping_state || '';
        let shipPincode = shippingPincode || influencer.shipping_pin || '';
        let shipPhone = shippingPhone || influencer.phone || '';
        
        // Parse city/state/pincode from combined address string if missing
        // Indian address format: "street, area, CITY, STATE, PINCODE"
        const fullAddress = [shipAddress1, shipAddress2].filter(Boolean).join(', ');
        if (fullAddress && (!shipPincode || !shipCity || !shipState)) {
            const addrParts = fullAddress.split(',').map(s => s.trim()).filter(Boolean);
            if (addrParts.length >= 3) {
                const pincodeIdx = addrParts.findIndex(p => /^\d{6}$/.test(p));
                if (pincodeIdx > 0) {
                    if (!shipPincode) shipPincode = addrParts[pincodeIdx];
                    if (!shipState && pincodeIdx >= 2) shipState = addrParts[pincodeIdx - 1];
                    if (!shipCity && pincodeIdx >= 3) shipCity = addrParts[pincodeIdx - 2];
                } else {
                    const lastPart = addrParts[addrParts.length - 1];
                    const isCountry = /^(india|IN)$/i.test(lastPart);
                    const endIdx = isCountry ? addrParts.length - 2 : addrParts.length - 1;
                    if (!shipState && endIdx >= 1) shipState = addrParts[endIdx];
                    if (!shipCity && endIdx >= 2) shipCity = addrParts[endIdx - 1];
                }
            }
        }
        
        // Clean phone number
        let phoneDigits = String(shipPhone).replace(/\D/g, '');
        if (phoneDigits.length === 12 && phoneDigits.startsWith('91')) phoneDigits = phoneDigits.substring(2);
        if (phoneDigits.length > 10) phoneDigits = phoneDigits.slice(-10);
        shipPhone = phoneDigits.length >= 10 ? phoneDigits : '9999999999';
        
        const hasCompleteAddress = shipFullName && shipAddress1 && shipCity && shipState && shipPincode && shipPhone;
        
        // Create ONE combined shipment record for all products
        const productTitles = products.map(p => p.size ? `${p.productTitle} (${p.size})` : p.productTitle);
        const combinedTitle = productTitles.join(', ');
        const firstProduct = products[0];
        
        const shipment = await createShipment({
            influencerId: influencerId,
            productTitle: combinedTitle,
            productImageUrl: firstProduct.productImageUrl || null,
            shopifyProductId: firstProduct.shopifyProductId || null,
            sentAt: sentAt,
            reelDueDate: reelDueDate || null,
            notes: products.length > 1
                ? `Multi-product shipment: ${productTitles.join('; ')}${notes ? '. Notes: ' + notes : ''}`
                : (notes || null)
        });
        
        // Create ONE Delhivery order with ALL products
        let delhiveryResult = null;
        
        if (hasCompleteAddress) {
            try {
                console.log(`[Shipment ${shipment.id}] Creating Delhivery forward order for ${products.length} product(s)...`);
        
                const delhiveryShipmentData = {
                    requestId: `INF-${String(shipment.id).padStart(6, '0')}`,
                    customerName: shipFullName,
                    shippingAddress: shipAddress1 + (shipAddress2 ? ', ' + shipAddress2 : ''),
                    shippingCity: shipCity,
                    shippingState: shipState,
                    shippingPincode: shipPincode,
                    customerPhone: shipPhone,
                    items: products.map(p => ({
                        name: p.size ? `${p.productTitle} (${p.size})` : p.productTitle,
                        quantity: 1,
                        price: 0
                    }))
                };
        
                delhiveryResult = await createDelhiveryForwardOrder(delhiveryShipmentData, null);
        
                if (delhiveryResult && delhiveryResult.waybill) {
                    console.log(`[Shipment ${shipment.id}] \u2705 Delhivery AWB: ${delhiveryResult.waybill}`);
                    if (delhiveryResult.waybills && delhiveryResult.waybills.length > 1) {
                        console.log(`[Shipment ${shipment.id}] \ud83d\udce6 Multi-product: ${delhiveryResult.waybills.length} packages - AWBs: ${delhiveryResult.waybills.join(', ')}`);
                    }
        
                    const { updateShipment } = require('./config/db-helpers');
                    await updateShipment(shipment.id, {
                        tracking_awb: delhiveryResult.waybill,
                        carrier: 'delhivery',
                        delhivery_shipment_id: delhiveryResult.shipment_id
                    });
        
                    shipment.tracking_awb = delhiveryResult.waybill;
                    shipment.carrier = 'delhivery';
                    shipment.delhivery_shipment_id = delhiveryResult.shipment_id;

                    // Save shipping address back to influencer DB for future auto-fill
                    if (!influencer.shipping_address || influencer.shipping_address !== shipAddress1) {
                        const { updateInfluencer } = require('./config/db-helpers');
                        await updateInfluencer(influencerId, {
                            shippingAddress: shipAddress1,
                            shippingCity: shipCity,
                            shippingState: shipState,
                            shippingPin: shipPincode,
                            shippingLandmark: shipAddress2 || null
                        }).catch(err => console.warn(`[Shipment ${shipment.id}] Could not save address to influencer:`, err.message));
                        console.log(`[Shipment ${shipment.id}] \ud83d\udcbe Saved shipping address to influencer DB`);
                    }
                }
            } catch (delhiveryError) {
                console.error(`[Shipment ${shipment.id}] \u274c Delhivery booking failed:`, delhiveryError.message);
            }
        } else {
            console.warn(`[Shipment ${shipment.id}] \u26a0\ufe0f Skipping Delhivery booking - incomplete shipping address`);
            console.warn(`   Name: ${shipFullName}, Address: ${shipAddress1}, City: ${shipCity}, State: ${shipState}, Pin: ${shipPincode}, Phone: ${shipPhone}`);
        }
        
        const createdShipments = [shipment];
        
        res.json({ 
            success: true, 
            shipments: createdShipments,
            message: products.length > 1
                ? `Combined shipment created for ${products.length} products${delhiveryResult?.waybill ? ' with Delhivery AWB ' + delhiveryResult.waybill : ''}`
                : 'Shipment created successfully'
        });
    } catch (error) {
        console.error('Create shipment from inventory error:', error);
        res.status(500).json({ error: 'Failed to create shipment' });
    }
});

// Create shipment for specific influencer (admin) - DEPRECATED, use /api/influencer-admin/shipments instead
app.post('/api/influencer-admin/shipments/:influencerId', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId } = req.params;
        const { productTitle, productImageUrl, shopifyProductId, sentAt, reelDueDate, notes } = req.body;
        if (!productTitle || !sentAt) {
            return res.status(400).json({ error: 'productTitle and sentAt are required' });
        }
        // reelDueDate is now optional
        const influencer = await getInfluencerById(influencerId);
        if (!influencer) return res.status(404).json({ error: 'Influencer not found' });
        const shipment = await createShipment({ influencerId, productTitle, productImageUrl, shopifyProductId, sentAt, reelDueDate: reelDueDate || null, notes });
        res.json({ success: true, shipment });
    } catch (error) {
        console.error('Create shipment error:', error);
        res.status(500).json({ error: 'Failed to create shipment' });
    }
});

// List shipments (admin)
app.get('/api/influencer-admin/shipments/:influencerId', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId } = req.params;
        const shipments = await listShipmentsByInfluencer(influencerId);
        // Compute overdue at read time
        const today = new Date().toISOString().split('T')[0];
        const enriched = shipments.map(s => {
            if (s.reel_status === 'pending' && s.reel_due_date < today) {
                return { ...s, reel_status: 'overdue' };
            }
            return s;
        });
        res.json({ success: true, shipments: enriched });
    } catch (error) {
        console.error('List shipments error:', error);
        res.status(500).json({ error: 'Failed to fetch shipments' });
    }
});

// Update shipment (admin)
app.patch('/api/influencer-admin/shipments/:shipmentId', authenticateAdmin, async (req, res) => {
    try {
        const { shipmentId } = req.params;
        const existing = await getShipmentById(shipmentId);
        if (!existing) return res.status(404).json({ error: 'Shipment not found' });
        const shipment = await updateShipment(shipmentId, req.body);
        res.json({ success: true, shipment });
    } catch (error) {
        console.error('Update shipment error:', error);
        res.status(500).json({ error: 'Failed to update shipment' });
    }
});

// Delete shipment (admin)
app.delete('/api/influencer-admin/shipments/:shipmentId', authenticateAdmin, async (req, res) => {
    try {
        const { shipmentId } = req.params;
        await deleteShipment(shipmentId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete shipment error:', error);
        res.status(500).json({ error: 'Failed to delete shipment' });
    }
});

// ==================== PAYOUTS (MONTHLY) ====================

async function generatePayoutsForMonth(month) {

    const startDate = `${month}-01T00:00:00Z`;
    const endD = new Date(startDate);
    endD.setMonth(endD.getMonth() + 1);
    const endDate = endD.toISOString();

    const { data: rows, error } = await supabase
        .from('influencer_orders')
        .select('influencer_id, total_price')
        .gte('order_created_at', startDate)
        .lt('order_created_at', endDate);

    if (error) throw error;

    const aggregated = {};
    for (const row of rows) {
        if (!aggregated[row.influencer_id]) {
            aggregated[row.influencer_id] = { ordersCount: 0, revenue: 0 };
        }
        aggregated[row.influencer_id].ordersCount++;
        aggregated[row.influencer_id].revenue += parseFloat(row.total_price || 0);
    }

    const results = [];
    for (const [infId, agg] of Object.entries(aggregated)) {
        const influencer = await getInfluencerById(infId);
        if (!influencer) continue;
        const commissionRate = parseFloat(influencer.commission_rate || 10);
        const amountDue = (agg.revenue * commissionRate) / 100;

        // Skip if already paid
        const { data: existing } = await supabase
            .from('influencer_payouts')
            .select('status')
            .eq('influencer_id', infId)
            .eq('month', month)
            .single();
        if (existing && existing.status === 'paid') continue;

        const payout = await upsertPayout({
            influencerId: infId,
            month,
            ordersCount: agg.ordersCount,
            revenueAmount: agg.revenue,
            commissionRate,
            amountDue,
            status: 'pending'
        });
        results.push(payout);
    }
    return results;
}

// Generate payouts for a month (admin)
app.post('/api/influencer-admin/payouts/generate', authenticateAdmin, async (req, res) => {
    try {
        const { month } = req.body;
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ error: 'month in YYYY-MM format is required' });
        }
        const results = await generatePayoutsForMonth(month);
        res.json({ success: true, generated: results.length, payouts: results });
    } catch (error) {
        console.error('Generate payouts error:', error);
        res.status(500).json({ error: 'Failed to generate payouts' });
    }
});

// ==================== ANALYTICS AGGREGATE ====================

async function getAnalyticsForInfluencer(influencer, range = 'all') {

    let createdAtMin = null;
    if (range === '30d') {
        const d = new Date(); d.setDate(d.getDate() - 30); createdAtMin = d.toISOString();
    } else if (range === '90d') {
        const d = new Date(); d.setDate(d.getDate() - 90); createdAtMin = d.toISOString();
    } else if (range === '6m') {
        const d = new Date(); d.setMonth(d.getMonth() - 6); createdAtMin = d.toISOString();
    }

    // Summary from influencer_orders
    let orderQuery = supabase.from('influencer_orders').select('total_price').eq('influencer_id', influencer.id);
    let countQuery = supabase.from('influencer_orders').select('*', { count: 'exact', head: true }).eq('influencer_id', influencer.id);
    let monthlyQuery = supabase.from('influencer_orders').select('order_created_at, total_price').eq('influencer_id', influencer.id);

    if (createdAtMin) {
        orderQuery = orderQuery.gte('order_created_at', createdAtMin);
        countQuery = countQuery.gte('order_created_at', createdAtMin);
        monthlyQuery = monthlyQuery.gte('order_created_at', createdAtMin);
    }

    const [{ data: orders }, { count: orderCount }, { data: monthlyRows }] = await Promise.all([orderQuery, countQuery, monthlyQuery]);

    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const commissionRate = parseFloat(influencer.commission_rate || 10);
    const displayedCommissionRate = parseFloat(influencer.displayed_commission_rate || commissionRate);
    const aov = orderCount > 0 ? totalRevenue / orderCount : 0;
    const estimatedEarnings = (totalRevenue * displayedCommissionRate) / 100;

    // Monthly aggregation
    const monthlyMap = {};
    for (const row of (monthlyRows || [])) {
        const m = row.order_created_at ? row.order_created_at.substring(0, 7) : 'unknown';
        if (!monthlyMap[m]) monthlyMap[m] = { month: m, orders: 0, revenue: 0 };
        monthlyMap[m].orders++;
        monthlyMap[m].revenue += parseFloat(row.total_price || 0);
    }
    const monthly = Object.values(monthlyMap).sort((a, b) => b.month.localeCompare(a.month)).map(m => ({
        ...m,
        commission: parseFloat(((m.revenue * commissionRate) / 100).toFixed(2)),
        revenue: parseFloat(m.revenue.toFixed(2))
    }));

    // Shipments
    const shipments = await listShipmentsByInfluencer(influencer.id);
    const today = new Date().toISOString().split('T')[0];
    let pending = 0, received = 0, overdue = 0;
    const enrichedShipments = shipments.map(s => {
        let status = s.reel_status;
        if (status === 'pending' && s.reel_due_date < today) status = 'overdue';
        if (status === 'pending') pending++;
        else if (status === 'received') received++;
        else if (status === 'overdue') overdue++;
        return { ...s, reel_status: status };
    });

    // Payouts
    const payouts = await listPayoutsByInfluencer(influencer.id);
    let totalPaid = 0, totalPendingAmount = 0;
    payouts.forEach(p => {
        if (p.status === 'paid') totalPaid += parseFloat(p.amount_due || 0);
        else totalPendingAmount += parseFloat(p.amount_due || 0);
    });

    // Recent orders (last 10)
    let recentOrdersQuery = supabase
        .from('influencer_orders')
        .select('shopify_order_id, order_name, total_price, currency, financial_status, customer_name, order_created_at, referral_code')
        .eq('influencer_id', influencer.id)
        .is('cancelled_at', null)
        .in('financial_status', ['paid', 'partially_paid', 'pending', 'authorized'])
        .order('order_created_at', { ascending: false })
        .limit(10);
    
    if (createdAtMin) {
        recentOrdersQuery = recentOrdersQuery.gte('order_created_at', createdAtMin);
    }
    
    const { data: recentOrderRows } = await recentOrdersQuery;
    const recentOrders = (recentOrderRows || []).map(r => ({
        id: r.shopify_order_id,
        orderName: r.order_name,
        total: parseFloat(r.total_price).toFixed(2),
        currency: r.currency || 'INR',
        date: r.order_created_at,
        customerName: r.customer_name || 'Guest',
        discountCode: r.referral_code
    }));

    return {
        influencer: {
            id: influencer.id,
            name: influencer.name,
            referral_code: influencer.referral_code,
            commission_rate: commissionRate,
            displayed_commission_rate: displayedCommissionRate
        },
        summary: {
            totalRevenue: parseFloat(totalRevenue.toFixed(2)),
            totalOrders: orderCount || 0,
            aov: parseFloat(aov.toFixed(2)),
            estimatedEarnings: parseFloat(estimatedEarnings.toFixed(2)),
            commissionRate: displayedCommissionRate
        },
        monthly,
        recentOrders,
        shipments: {
            total: enrichedShipments.length,
            pending,
            received,
            overdue,
            items: enrichedShipments
        },
        payouts: {
            totalPaid: parseFloat(totalPaid.toFixed(2)),
            totalPending: parseFloat(totalPendingAmount.toFixed(2)),
            items: payouts
        }
    };
}

// Admin analytics
app.get('/api/influencer-admin/analytics/:influencerId', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId } = req.params;
        const { range } = req.query;
        const influencer = await getInfluencerById(influencerId);
        if (!influencer) return res.status(404).json({ error: 'Influencer not found' });
        const analytics = await getAnalyticsForInfluencer(influencer, range);
        res.json({ success: true, ...analytics });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Influencer analytics
app.get('/api/influencer/analytics/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { range } = req.query;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        const analytics = await getAnalyticsForInfluencer(influencer, range);
        res.json({ success: true, ...analytics });
    } catch (error) {
        console.error('Influencer analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ==================== LEADERBOARD ====================

async function getLeaderboard(range = 'all', limit = 10, currentToken = null) {

    let createdAtMin = null;
    if (range === '30d') { const d = new Date(); d.setDate(d.getDate() - 30); createdAtMin = d.toISOString(); }
    else if (range === '90d') { const d = new Date(); d.setDate(d.getDate() - 90); createdAtMin = d.toISOString(); }
    else if (range === '6m') { const d = new Date(); d.setMonth(d.getMonth() - 6); createdAtMin = d.toISOString(); }

    let query = supabase
        .from('influencer_orders')
        .select('influencer_id, total_price')
        .order('order_created_at', { ascending: false });
    if (createdAtMin) query = query.gte('order_created_at', createdAtMin);

    const { data: orders, error } = await query;
    if (error) throw error;

    const aggregated = {};
    for (const row of (orders || [])) {
        if (!aggregated[row.influencer_id]) aggregated[row.influencer_id] = { revenue: 0, orders: 0 };
        aggregated[row.influencer_id].revenue += parseFloat(row.total_price || 0);
        aggregated[row.influencer_id].orders++;
    }

    let currentInfluencerId = null;
    if (currentToken) {
        const currentInf = await getInfluencerByToken(currentToken);
        if (currentInf) currentInfluencerId = currentInf.id;
    }

    const rows = Object.entries(aggregated).map(([id, agg]) => ({
        influencerId: parseInt(id),
        revenue: parseFloat(agg.revenue.toFixed(2)),
        orders: agg.orders
    })).sort((a, b) => b.revenue - a.revenue);

    const leaderboard = [];
    for (let i = 0; i < Math.min(rows.length, limit); i++) {
        const row = rows[i];
        const influencer = await getInfluencerById(row.influencerId);
        if (!influencer) continue;
        leaderboard.push({
            rank: i + 1,
            id: influencer.id,
            name: influencer.name,
            referral_code: influencer.referral_code,
            revenue: row.revenue,
            orders: row.orders,
            current_user: influencer.id === currentInfluencerId
        });
    }

    // If current influencer not in top N, find their rank
    if (currentInfluencerId && !leaderboard.find(r => r.id === currentInfluencerId)) {
        const idx = rows.findIndex(r => r.influencerId === currentInfluencerId);
        if (idx >= 0) {
            const influencer = await getInfluencerById(currentInfluencerId);
            leaderboard.push({
                rank: idx + 1,
                id: influencer.id,
                name: influencer.name,
                referral_code: influencer.referral_code,
                revenue: rows[idx].revenue,
                orders: rows[idx].orders,
                current_user: true
            });
        }
    }

    return leaderboard;
}

// Admin leaderboard
app.get('/api/influencer-admin/leaderboard', authenticateAdmin, async (req, res) => {
    try {
        const { range = 'all', limit = 10 } = req.query;
        const leaderboard = await getLeaderboard(range, parseInt(limit));
        res.json({ success: true, leaderboard });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// Influencer leaderboard
app.get('/api/influencer/leaderboard/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { range = 'all', limit = 10 } = req.query;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        const leaderboard = await getLeaderboard(range, parseInt(limit), token);
        res.json({ success: true, leaderboard });
    } catch (error) {
        console.error('Influencer leaderboard error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// ==================== INFLUENCER SELF-SUBMIT ====================

// Influencer submit reel URL
app.patch('/api/influencer/shipments/:token/:shipmentId', async (req, res) => {
    try {
        const { token, shipmentId } = req.params;
        const { reelUrl } = req.body;
        if (!reelUrl) return res.status(400).json({ error: 'reelUrl is required' });

        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });

        const shipment = await getShipmentById(shipmentId);
        if (!shipment || shipment.influencer_id !== influencer.id) {
            return res.status(404).json({ error: 'Shipment not found' });
        }

        const updated = await updateShipment(shipmentId, {
            reelUrl,
            reelStatus: 'received',
            reelReceivedAt: new Date().toISOString()
        });
        res.json({ success: true, shipment: updated });
    } catch (error) {
        console.error('Influencer submit reel error:', error);
        res.status(500).json({ error: 'Failed to submit reel' });
    }
});

// Influencer list shipments
app.get('/api/influencer/shipments/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        const shipments = await listShipmentsByInfluencer(influencer.id);
        const today = new Date().toISOString().split('T')[0];
        const enriched = shipments.map(s => {
            if (s.reel_status === 'pending' && s.reel_due_date < today) {
                return { ...s, reel_status: 'overdue' };
            }
            return s;
        });
        res.json({ success: true, shipments: enriched });
    } catch (error) {
        console.error('Influencer shipments error:', error);
        res.status(500).json({ error: 'Failed to fetch shipments' });
    }
});

// Influencer get/update own shipping address
app.get('/api/influencer/shipping-address/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });

        res.json({
            success: true,
            shippingAddress: {
                shipping_address: influencer.shipping_address || '',
                shipping_landmark: influencer.shipping_landmark || '',
                shipping_city: influencer.shipping_city || '',
                shipping_state: influencer.shipping_state || '',
                shipping_pin: influencer.shipping_pin || '',
                address_type: influencer.address_type || 'home'
            }
        });
    } catch (error) {
        console.error('Get shipping address error:', error);
        res.status(500).json({ error: 'Failed to fetch shipping address' });
    }
});

app.patch('/api/influencer/shipping-address/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });

        const { shippingAddress, shippingLandmark, shippingCity, shippingState, shippingPin, addressType } = req.body;

        // Validate required fields
        if (!shippingAddress || !shippingCity || !shippingState || !shippingPin) {
            return res.status(400).json({ error: 'Complete shipping address is required' });
        }
        if (shippingPin && shippingPin.length !== 6) {
            return res.status(400).json({ error: 'PIN code must be 6 digits' });
        }

        const updated = await updateInfluencer(influencer.id, {
            shippingAddress: String(shippingAddress).trim(),
            shippingLandmark: shippingLandmark ? String(shippingLandmark).trim() : null,
            shippingCity: String(shippingCity).trim(),
            shippingState: String(shippingState).trim(),
            shippingPin: String(shippingPin).trim(),
            addressType: addressType || 'home'
        });

        res.json({ success: true, message: 'Shipping address updated', shippingAddress: updated });
    } catch (error) {
        console.error('Update shipping address error:', error);
        res.status(500).json({ error: 'Failed to update shipping address' });
    }
});

// Influencer get monthly reel target
app.get('/api/influencer/reel-targets/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { month, year } = req.query;
        
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        
        const now = new Date();
        const targetMonth = month ? parseInt(month) : now.getMonth() + 1;
        const targetYear = year ? parseInt(year) : now.getFullYear();
        
        // Get target from database
        const targets = await getReelTargetsByInfluencer(influencer.id, {
            month: targetMonth,
            year: targetYear
        });
        
        // Get progress for this target
        const progress = await getReelTargetProgress(influencer.id, targetMonth, targetYear);
        
        res.json({
            success: true,
            target: targets.length > 0 ? targets[0] : null,
            progress
        });
    } catch (error) {
        console.error('Influencer reel targets error:', error);
        res.status(500).json({ error: 'Failed to fetch reel targets' });
    }
});

// Influencer list payouts
app.get('/api/influencer/payouts/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        const payouts = await listPayoutsByInfluencer(influencer.id);
        res.json({ success: true, payouts });
    } catch (error) {
        console.error('Influencer payouts error:', error);
        res.status(500).json({ error: 'Failed to fetch payouts' });
    }
});

// ==================== REEL TARGETS & PRODUCT REQUESTS ====================

// Admin: Set monthly reel target
app.post('/api/influencer-admin/reel-targets/:influencerId', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId } = req.params;
        const { month, year, targetCount, notes } = req.body;
        
        if (!month || !year || !targetCount) {
            return res.status(400).json({ error: 'month, year, and targetCount are required' });
        }
        
        const influencer = await getInfluencerById(influencerId);
        if (!influencer) return res.status(404).json({ error: 'Influencer not found' });
        
        const target = await createReelTarget({ influencerId, month, year, targetCount, notes });
        const progress = await getReelTargetProgress(influencerId, month, year);
        
        res.json({ success: true, target: { ...target, ...progress } });
    } catch (error) {
        console.error('Create reel target error:', error);
        res.status(500).json({ error: 'Failed to create reel target' });
    }
});

// Admin: Get reel targets for influencer
app.get('/api/influencer-admin/reel-targets/:influencerId', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId } = req.params;
        const { month, year, limit } = req.query;
        
        const filters = {};
        if (month) filters.month = parseInt(month);
        if (year) filters.year = parseInt(year);
        if (limit) filters.limit = parseInt(limit);
        
        const targets = await getReelTargetsByInfluencer(influencerId, filters);
        res.json({ success: true, targets });
    } catch (error) {
        console.error('Get reel targets error:', error);
        res.status(500).json({ error: 'Failed to fetch reel targets' });
    }
});

// Admin: Get all reel targets for dashboard
app.get('/api/influencer-admin/reel-targets', authenticateAdmin, async (req, res) => {
    try {
        const { month, year } = req.query;
        
        if (!month || !year) {
            return res.status(400).json({ error: 'month and year are required' });
        }
        
        const influencers = await getAllInfluencers();
        const activeInfluencers = influencers.filter(i => i.is_active !== false);
        
        const targets = await Promise.all(
            activeInfluencers.map(async (influencer) => {
                const progress = await getReelTargetProgress(influencer.id, parseInt(month), parseInt(year));
                return {
                    influencerId: influencer.id,
                    influencerName: influencer.name,
                    referralCode: influencer.referral_code,
                    ...progress
                };
            })
        );
        
        const summary = {
            totalInfluencers: targets.length,
            onTrack: targets.filter(t => t.completionPercentage >= 50 && t.completionPercentage < 100).length,
            behind: targets.filter(t => t.completionPercentage < 50).length,
            completed: targets.filter(t => t.completionPercentage >= 100).length,
            averageCompletion: targets.length > 0 
                ? (targets.reduce((sum, t) => sum + t.completionPercentage, 0) / targets.length).toFixed(2)
                : 0
        };
        
        res.json({ success: true, summary, targets });
    } catch (error) {
        console.error('Get all reel targets error:', error);
        res.status(500).json({ error: 'Failed to fetch reel targets' });
    }
});

// Admin: Create/update monthly reel target (without influencerId in path)
app.post('/api/influencer-admin/reel-targets', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId, month, year, targetCount, notes } = req.body;
        
        if (!influencerId || !month || !year || !targetCount) {
            return res.status(400).json({ error: 'influencerId, month, year, and targetCount are required' });
        }
        
        const target = await createReelTarget({
            influencerId,
            month: parseInt(month),
            year: parseInt(year),
            targetCount: parseInt(targetCount),
            notes
        });
        
        res.json({ success: true, target });
    } catch (error) {
        console.error('Create reel target error:', error);
        res.status(500).json({ error: 'Failed to create reel target' });
    }
});

// Admin: Browse Shopify products
app.get('/api/influencer-admin/shopify-products', authenticateAdmin, async (req, res) => {
    try {
        const { search, limit = 20, page = 1 } = req.query;
        const parsedLimit = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const parsedPage = Math.max(1, parseInt(page) || 1);
        
        // Validate Shopify config before making call
        if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_STORE) {
            return res.status(500).json({ error: 'Shopify not configured', success: false, products: [] });
        }
        
        // Fetch ALL active products from Shopify (uses cache)
        const allProducts = await fetchAllShopifyProducts();
        
        // Filter to only products with inventory
        let products = filterProductsWithInventory(allProducts)
            .map(p => {
                const availableVariants = p.variants;
                return {
                    id: p.id,
                    shopifyId: p.id,
                    title: p.title,
                    handle: p.handle,
                    description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').substring(0, 200) : '',
                    images: (p.images || []).slice(0, 3).map(img => ({
                        src: img.src,
                        alt: img.alt || p.title
                    })),
                    variants: availableVariants.map(v => ({
                        id: v.id,
                        title: v.title,
                        price: v.price,
                        sku: v.sku,
                        inventoryQuantity: v.inventory_quantity,
                        available: true
                    })),
                    totalStock: availableVariants.reduce((sum, v) => sum + v.inventory_quantity, 0),
                    productType: p.product_type,
                    vendor: p.vendor,
                    tags: p.tags || []
                };
            });
        
        // Client-side search filter
        if (search) {
            const q = search.toLowerCase();
            products = products.filter(p => 
                p.title.toLowerCase().includes(q) || 
                (p.handle && p.handle.toLowerCase().includes(q)) ||
                (p.productType && p.productType.toLowerCase().includes(q))
            );
        }
        
        const totalProducts = products.length;
        const totalPages = Math.ceil(totalProducts / parsedLimit);
        const startIdx = (parsedPage - 1) * parsedLimit;
        const paginatedProducts = products.slice(startIdx, startIdx + parsedLimit);
        
        res.json({
            success: true,
            products: paginatedProducts,
            pagination: {
                page: parsedPage,
                limit: parsedLimit,
                totalProducts,
                totalPages,
                hasNextPage: parsedPage < totalPages,
                hasPrevPage: parsedPage > 1
            }
        });
    } catch (error) {
        console.error('Shopify products fetch error:', error.message, error.stack);
        res.status(502).json({ error: 'Failed to fetch Shopify products', details: error.message, success: false, products: [] });
    }
});

// Admin: List product requests
app.get('/api/influencer-admin/product-requests', authenticateAdmin, async (req, res) => {
    try {
        const { status, influencerId, search, limit, page } = req.query;
        
        const filters = {};
        if (status) filters.status = status;
        if (influencerId) filters.influencerId = influencerId;
        if (search) filters.search = search;
        if (limit) filters.limit = limit;
        if (page) filters.page = page;
        
        const result = await getProductRequests(filters);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Get product requests error:', error);
        res.status(500).json({ error: 'Failed to fetch product requests' });
    }
});

// Admin: Approve product request with auto-ship
app.post('/api/influencer-admin/product-requests/:requestId/approve', authenticateAdmin, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { adminNotes, autoShip = true } = req.body;
        
        const request = await getProductRequestById(requestId);
        if (!request) return res.status(404).json({ error: 'Product request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request is not in pending status' });
        }
        
        let delhiveryResult = null;
        
        if (autoShip) {
            // Create Delhivery shipment
            const shipmentData = {
                requestId: `INF-${requestId.substring(0, 8)}`,
                customerName: request.shipping_full_name,
                customerAddress: request.shipping_address_line1 + (request.shipping_address_line2 ? ' ' + request.shipping_address_line2 : ''),
                customerCity: request.shipping_city,
                customerState: request.shipping_state,
                customerPincode: request.shipping_pincode,
                customerPhone: request.shipping_phone,
                items: [{
                    name: request.product_title,
                    quantity: 1,
                    price: 0 // Influencer product is free
                }]
            };
            
            try {
                delhiveryResult = await createDelhiveryForwardOrder(shipmentData, null);
            } catch (delhiveryError) {
                console.error('Delhivery booking failed, but request approved:', delhiveryError);
                // Continue with approval even if Delhivery fails
            }
        }
        
        const updates = {
            status: 'approved',
            approvedAt: new Date().toISOString(),
            adminNotes: adminNotes || null
        };
        
        if (delhiveryResult) {
            updates.delhiveryAwb = delhiveryResult.waybill;
            updates.delhiveryShipmentId = delhiveryResult.shipment_id;
        }
        
        const updated = await updateProductRequest(requestId, updates);
        
        res.json({
            success: true,
            request: updated,
            shipment: delhiveryResult ? {
                awb: delhiveryResult.waybill,
                shipmentId: delhiveryResult.shipment_id,
                trackingUrl: `https://www.delhivery.com/track?wb=${delhiveryResult.waybill}`
            } : null
        });
    } catch (error) {
        console.error('Approve product request error:', error);
        res.status(500).json({ error: 'Failed to approve product request' });
    }
});

// Admin: Bulk approve product requests as combined shipments (same influencer + same address = single shipment)
app.post('/api/influencer-admin/product-requests/bulk-approve', authenticateAdmin, async (req, res) => {
    try {
        const { requestIds, adminNotes } = req.body;

        if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
            return res.status(400).json({ error: 'requestIds array is required' });
        }

        // Fetch all requests
        const requests = [];
        for (const id of requestIds) {
            const req_ = await getProductRequestById(id);
            if (!req_) {
                return res.status(404).json({ error: `Product request ${id} not found` });
            }
            if (req_.status !== 'pending') {
                return res.status(400).json({ error: `Request ${id} is not pending (status: ${req_.status})` });
            }
            requests.push(req_);
        }

        // Group by influencer_id + shipping address
        const groups = {};
        for (const r of requests) {
            const addrKey = [
                r.shipping_full_name,
                r.shipping_address_line1,
                r.shipping_address_line2 || '',
                r.shipping_city,
                r.shipping_state,
                r.shipping_pincode,
                r.shipping_phone
            ].join('|');
            const groupKey = `${r.influencer_id}::${addrKey}`;
            if (!groups[groupKey]) groups[groupKey] = [];
            groups[groupKey].push(r);
        }

        const results = { success: [], failed: [], shipments: [] };

        for (const [groupKey, groupRequests] of Object.entries(groups)) {
            const [influencerId] = groupKey.split('::');
            const first = groupRequests[0];

            try {
                // Build combined items list from all requests in group
                const items = groupRequests.map(r => ({
                    name: r.product_title,
                    quantity: 1,
                    price: 0
                }));

                // Create single Delhivery shipment for all items
                const combinedRequestId = groupRequests.map(r => r.id.substring(0, 6)).join('-');
                const shipmentData = {
                    requestId: `INF-${combinedRequestId}`,
                    customerName: first.shipping_full_name,
                    customerAddress: first.shipping_address_line1 + (first.shipping_address_line2 ? ' ' + first.shipping_address_line2 : ''),
                    customerCity: first.shipping_city,
                    customerState: first.shipping_state,
                    customerPincode: first.shipping_pincode,
                    customerPhone: first.shipping_phone,
                    items: items
                };

                let delhiveryResult = null;
                try {
                    delhiveryResult = await createDelhiveryForwardOrder(shipmentData, null);
                } catch (delhiveryError) {
                    console.error('Delhivery booking failed for group:', delhiveryError);
                }

                // Update all requests in group with shared shipment info
                const updates = {
                    status: 'approved',
                    approvedAt: new Date().toISOString(),
                    adminNotes: adminNotes || `Bulk approved with ${groupRequests.length} product(s) in single shipment`
                };

                if (delhiveryResult) {
                    updates.delhiveryAwb = delhiveryResult.waybill;
                    updates.delhiveryShipmentId = delhiveryResult.shipment_id;
                }

                for (const r of groupRequests) {
                    try {
                        await updateProductRequest(r.id, updates);
                        results.success.push(r.id);
                    } catch (updateErr) {
                        results.failed.push({ id: r.id, error: updateErr.message });
                    }
                }

                results.shipments.push({
                    groupKey,
                    influencerId,
                    requestCount: groupRequests.length,
                    products: groupRequests.map(r => r.product_title),
                    awb: delhiveryResult?.waybill || null,
                    shipmentId: delhiveryResult?.shipment_id || null
                });

            } catch (groupErr) {
                for (const r of groupRequests) {
                    results.failed.push({ id: r.id, error: groupErr.message });
                }
            }
        }

        res.json({
            success: true,
            results,
            summary: {
                total: requestIds.length,
                succeeded: results.success.length,
                failed: results.failed.length,
                shipmentsCreated: results.shipments.length
            }
        });
    } catch (error) {
        console.error('Bulk approve product requests error:', error);
        res.status(500).json({ error: 'Failed to bulk approve product requests' });
    }
});

// Admin: Reject product request
app.post('/api/influencer-admin/product-requests/:requestId/reject', authenticateAdmin, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { rejectionReason, adminNotes } = req.body;
        
        if (!rejectionReason || rejectionReason.length < 10) {
            return res.status(400).json({ error: 'rejectionReason must be at least 10 characters' });
        }
        
        const request = await getProductRequestById(requestId);
        if (!request) return res.status(404).json({ error: 'Product request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request is not in pending status' });
        }
        
        const updated = await updateProductRequest(requestId, {
            status: 'rejected',
            rejectedAt: new Date().toISOString(),
            rejectionReason,
            adminNotes: adminNotes || null
        });
        
        res.json({ success: true, request: updated });
    } catch (error) {
        console.error('Reject product request error:', error);
        res.status(500).json({ error: 'Failed to reject product request' });
    }
});

// Influencer: Submit product request
app.post('/api/influencer/product-requests/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { 
            productTitle, productImageUrl, shopifyProductId, shopifyVariantId,
            reason, shippingFullName, shippingAddressLine1, shippingAddressLine2,
            shippingCity, shippingState, shippingPincode, shippingPhone 
        } = req.body;
        
        if (!productTitle || productTitle.length < 3) {
            return res.status(400).json({ error: 'productTitle must be at least 3 characters' });
        }
        if (!reason || reason.length < 10) {
            return res.status(400).json({ error: 'reason must be at least 10 characters' });
        }
        if (!shippingPincode || shippingPincode.length !== 6) {
            return res.status(400).json({ error: 'Invalid pincode (must be 6 digits)' });
        }
        if (!shippingPhone || shippingPhone.length !== 10) {
            return res.status(400).json({ error: 'Invalid phone number (must be 10 digits)' });
        }
        
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        
        const request = await createProductRequest({
            influencerId: influencer.id,
            productTitle,
            productImageUrl: productImageUrl || null,
            shopifyProductId: shopifyProductId || null,
            shopifyVariantId: shopifyVariantId || null,
            reason,
            shippingFullName,
            shippingAddressLine1,
            shippingAddressLine2: shippingAddressLine2 || null,
            shippingCity,
            shippingState,
            shippingPincode,
            shippingPhone
        });
        
        res.status(201).json({ success: true, request });
    } catch (error) {
        console.error('Submit product request error:', error);
        res.status(500).json({ error: 'Failed to submit product request' });
    }
});

// Influencer: List my product requests
app.get('/api/influencer/product-requests/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { status, limit = 20 } = req.query;
        
        const influencer = await getInfluencerByToken(token);
        if (!influencer) return res.status(401).json({ error: 'Invalid token' });
        
        const filters = { influencerId: influencer.id, limit };
        if (status) filters.status = status;
        
        const result = await getProductRequests(filters);
        
        // Remove sensitive admin fields from response
        const sanitizedRequests = result.requests.map(r => ({
            id: r.id,
            productTitle: r.product_title,
            productImageUrl: r.product_image_url,
            reason: r.reason,
            status: r.status,
            delhiveryAwb: r.delhivery_awb,
            trackingUrl: r.delhivery_tracking_url,
            shippedAt: r.shipped_at,
            createdAt: r.created_at,
            rejectionReason: r.rejection_reason
        }));
        
        res.json({ success: true, requests: sanitizedRequests });
    } catch (error) {
        console.error('Get influencer product requests error:', error);
        res.status(500).json({ error: 'Failed to fetch product requests' });
    }
});

// Influencer: Browse Shopify products (inventory)
app.get('/api/influencer/:token/shopify-products', async (req, res) => {
    try {
        const { token } = req.params;
        const { search, limit = 20, page = 1 } = req.query;
        const parsedLimit = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const parsedPage = Math.max(1, parseInt(page) || 1);
        
        // Validate Shopify config before making call
        if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_STORE) {
            return res.status(500).json({ error: 'Shopify not configured', success: false, products: [] });
        }
        
        // Verify influencer exists
        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid token', success: false, products: [] });
        }
        
        // Fetch ALL active products from Shopify (uses cache)
        const allProducts = await fetchAllShopifyProducts();
        
        // Filter to only products with inventory
        let products = filterProductsWithInventory(allProducts)
            .map(p => {
                const availableVariants = p.variants;
                return {
                    id: p.id,
                    shopifyId: p.id,
                    title: p.title,
                    handle: p.handle,
                    description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').substring(0, 200) : '',
                    images: (p.images || []).slice(0, 3).map(img => ({
                        src: img.src,
                        alt: img.alt || p.title
                    })),
                    variants: availableVariants.map(v => ({
                        id: v.id,
                        title: v.title,
                        price: v.price,
                        sku: v.sku,
                        inventoryQuantity: v.inventory_quantity,
                        available: true
                    })),
                    totalStock: availableVariants.reduce((sum, v) => sum + v.inventory_quantity, 0),
                    productType: p.product_type,
                    vendor: p.vendor,
                    tags: p.tags || []
                };
            });
        
        // Client-side search filter
        if (search) {
            const q = search.toLowerCase();
            products = products.filter(p => 
                p.title.toLowerCase().includes(q) || 
                (p.handle && p.handle.toLowerCase().includes(q)) ||
                (p.productType && p.productType.toLowerCase().includes(q))
            );
        }
        
        const totalProducts = products.length;
        const totalPages = Math.ceil(totalProducts / parsedLimit);
        const startIdx = (parsedPage - 1) * parsedLimit;
        const paginatedProducts = products.slice(startIdx, startIdx + parsedLimit);
        
        res.json({
            success: true,
            products: paginatedProducts,
            pagination: {
                page: parsedPage,
                limit: parsedLimit,
                totalProducts,
                totalPages,
                hasNextPage: parsedPage < totalPages,
                hasPrevPage: parsedPage > 1
            }
        });
    } catch (error) {
        console.error('Shopify products fetch error:', error.message, error.stack);
        res.status(502).json({ 
            error: 'Failed to fetch Shopify products',
            details: error.message,
            success: false,
            products: []
        });
    }
});

// Admin: List all shipments (for Shipments & Reels page)
app.get('/api/influencer-admin/shipments', authenticateAdmin, async (req, res) => {
    try {
        const shipments = await listShipments();
        
        // Enrich with influencer data
        const enriched = await Promise.all(
            shipments.map(async (s) => {
                const influencer = await getInfluencerById(s.influencer_id);
                return {
                    ...s,
                    influencers: influencer ? {
                        name: influencer.name,
                        referral_code: influencer.referral_code,
                        phone: influencer.phone
                    } : null
                };
            })
        );
        
        res.json({ success: true, shipments: enriched });
    } catch (error) {
        console.error('List shipments error:', error);
        res.status(500).json({ error: 'Failed to fetch shipments' });
    }
});

// Admin: Get single shipment details
app.get('/api/influencer-admin/shipment-detail/:shipmentId', authenticateAdmin, async (req, res) => {
    try {
        const { shipmentId } = req.params;
        const shipment = await getShipmentById(shipmentId);
        
        if (!shipment) {
            return res.status(404).json({ error: 'Shipment not found' });
        }
        
        // Enrich with influencer data
        const influencer = await getInfluencerById(shipment.influencer_id);
        const enriched = {
            ...shipment,
            influencers: influencer ? {
                name: influencer.name,
                referral_code: influencer.referral_code,
                phone: influencer.phone
            } : null
        };
        
        res.json({ success: true, shipment: enriched });
    } catch (error) {
        console.error('Get shipment error:', error);
        res.status(500).json({ error: 'Failed to fetch shipment' });
    }
});

// Admin: Update reel status
app.post('/api/influencer-admin/shipments/:shipmentId/reel-status', authenticateAdmin, async (req, res) => {
    try {
        const { shipmentId } = req.params;
        const { reelStatus } = req.body;
        
        if (!['pending', 'received', 'overdue', 'submitted'].includes(reelStatus)) {
            return res.status(400).json({ error: 'Invalid reel status' });
        }
        
        const updated = await updateShipment(shipmentId, {
            reel_status: reelStatus,
            reel_received_at: reelStatus === 'received' ? new Date().toISOString() : null
        });
        
        res.json({ success: true, shipment: updated });
    } catch (error) {
        console.error('Update reel status error:', error);
        res.status(500).json({ error: 'Failed to update reel status' });
    }
});

// (Manual shipment route moved above /:influencerId to prevent route conflict)

// ==================== MESSAGING SYSTEM ====================

// ── Admin Messaging Endpoints ──

// Send message (admin to influencer or broadcast)
app.post('/api/admin/messages', authenticateAdmin, async (req, res) => {
    try {
        const { recipientType, recipientId, subject, content, isBroadcast } = req.body;
        
        if (!content) {
            return res.status(400).json({ error: 'Message content is required' });
        }

        if (!isBroadcast && !recipientId) {
            return res.status(400).json({ error: 'Recipient is required for direct messages' });
        }

        const message = await createMessage({
            senderType: 'admin',
            senderId: null,
            recipientType: isBroadcast ? 'all' : recipientType,
            recipientId: isBroadcast ? null : recipientId,
            subject,
            content,
            isBroadcast: isBroadcast || false
        });

        res.json({ success: true, message });
    } catch (error) {
        console.error('Admin send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Get all messages (with optional influencer filter)
app.get('/api/admin/messages', authenticateAdmin, async (req, res) => {
    try {
        const { influencerId, type } = req.query;
        const messages = await getAdminMessages({ influencerId, type });
        res.json({ success: true, messages });
    } catch (error) {
        console.error('Admin get messages error:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Mark message as read (admin side)
app.post('/api/admin/messages/:messageId/read', authenticateAdmin, async (req, res) => {
    try {
        const message = await markMessageAsRead(req.params.messageId);
        res.json({ success: true, message });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// ── Influencer Messaging Endpoints ──

// Send message (influencer to admin)
app.post('/api/influencer/messages', async (req, res) => {
    try {
        const { token, content, subject } = req.body;
        
        if (!token || !content) {
            return res.status(400).json({ error: 'Token and content are required' });
        }

        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        const message = await createMessage({
            senderType: 'influencer',
            senderId: influencer.id,
            recipientType: 'admin',
            recipientId: null,
            subject,
            content,
            isBroadcast: false
        });

        res.json({ success: true, message });
    } catch (error) {
        console.error('Influencer send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Get influencer's messages
app.get('/api/influencer/messages', async (req, res) => {
    try {
        const { token, unreadOnly } = req.query;
        
        if (!token) {
            return res.status(400).json({ error: 'Token is required' });
        }

        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        const messages = await getInfluencerMessages(influencer.id, { unreadOnly: unreadOnly === 'true' });
        res.json({ success: true, messages });
    } catch (error) {
        console.error('Influencer get messages error:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Mark message as read (influencer side)
app.post('/api/influencer/messages/:messageId/read', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ error: 'Token is required' });
        }

        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        const message = await markMessageAsRead(req.params.messageId);
        res.json({ success: true, message });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// Get unread message count
app.get('/api/influencer/messages/unread-count', async (req, res) => {
    try {
        const { token } = req.query;
        
        if (!token) {
            return res.status(400).json({ error: 'Token is required' });
        }

        const influencer = await getInfluencerByToken(token);
        if (!influencer) {
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        const count = await getUnreadMessageCount(influencer.id);
        res.json({ success: true, count });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get unread count' });
    }
});

// ==================== MARKETING DASHBOARD ====================
// All marketing routes are isolated from return/exchange logic.
// They use the same authenticateAdmin middleware and Supabase client.

// ── Customer Intelligence ──

// GET /api/admin/marketing/customers - List customers with filters
app.get('/api/admin/marketing/customers', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getMarketingCustomers(req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Customers list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// GET /api/admin/marketing/customers/stats - Customer statistics (SMART)
app.get('/api/admin/marketing/customers/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await marketingDB.getSmartCustomerStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[Marketing] Customer stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch customer stats' });
    }
});

// POST /api/admin/marketing/customers/recompute-segments - Smart recompute all segments
app.post('/api/admin/marketing/customers/recompute-segments', authenticateAdmin, async (req, res) => {
    try {
        console.log('[Marketing] Starting smart segment recomputation...');
        const result = await marketingDB.recomputeAllCustomerSegments();
        await marketingDB.createAuditLog({
            action: 'recomputed',
            entityType: 'customer',
            actor: req.user?.sub || 'admin',
            details: { total: result.total, updated: result.updated },
            ipAddress: req.ip
        });
        res.json({ success: true, ...result, message: `Recomputed ${result.total} customers, ${result.updated} updated` });
    } catch (error) {
        console.error('[Marketing] Recompute error:', error.message);
        res.status(500).json({ error: 'Recompute failed: ' + error.message });
    }
});

// GET /api/admin/marketing/customers/segments - List all segments
app.get('/api/admin/marketing/customers/segments', authenticateAdmin, async (req, res) => {
    try {
        const segments = await marketingDB.getCustomerSegments();
        res.json({ success: true, segments });
    } catch (error) {
        console.error('[Marketing] Segments error:', error.message);
        res.status(500).json({ error: 'Failed to fetch segments' });
    }
});

// GET /api/admin/marketing/customers/segments/:name - Get customers by segment
app.get('/api/admin/marketing/customers/segments/:name', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getCustomersBySegment(req.params.name, req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Segment customers error:', error.message);
        res.status(500).json({ error: 'Failed to fetch segment customers' });
    }
});

// GET /api/admin/marketing/customers/:id - Get single customer
app.get('/api/admin/marketing/customers/:id', authenticateAdmin, async (req, res) => {
    try {
        const customer = await marketingDB.getMarketingCustomerById(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        const orders = await marketingDB.getCustomerOrders(req.params.id);
        res.json({ success: true, customer, orders });
    } catch (error) {
        console.error('[Marketing] Customer detail error:', error.message);
        res.status(500).json({ error: 'Failed to fetch customer' });
    }
});

// PUT /api/admin/marketing/customers/:id - Update customer
app.put('/api/admin/marketing/customers/:id', authenticateAdmin, async (req, res) => {
    try {
        const updated = await marketingDB.updateMarketingCustomer(req.params.id, req.body);
        await marketingDB.createAuditLog({
            action: 'updated',
            entityType: 'customer',
            entityId: parseInt(req.params.id),
            actor: req.user?.sub || 'admin',
            newValues: req.body,
            ipAddress: req.ip
        });
        res.json({ success: true, customer: updated });
    } catch (error) {
        console.error('[Marketing] Customer update error:', error.message);
        res.status(500).json({ error: 'Failed to update customer' });
    }
});

// POST /api/admin/marketing/customers/sync - Trigger customer sync from Shopify (INCREMENTAL)
app.post('/api/admin/marketing/customers/sync', authenticateAdmin, async (req, res) => {
    try {
        const forceFull = req.body?.forceFull === true;
        console.log('[Marketing] Starting customer sync from Shopify...');
        const shopifyStore = process.env.SHOPIFY_STORE;
        const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

        if (!shopifyStore || !accessToken) {
            return res.status(400).json({ error: 'Shopify not configured' });
        }

        // Determine if this is an incremental sync
        let lastSyncTime = null;
        if (!forceFull) {
            lastSyncTime = await marketingDB.getLastCustomerSyncTime();
        }
        const isIncremental = !!lastSyncTime;
        console.log(`[Marketing] Sync mode: ${isIncremental ? 'INCREMENTAL' : 'FULL'}${isIncremental ? ` (since ${lastSyncTime})` : ''}`);

        let totalSynced = 0;
        let totalSkipped = 0;
        let phonesRecovered = 0;
        let cursor = null;
        let pagesFetched = 0;
        const BATCH_SIZE = 50; // Upsert in batches of 50

        do {
            // Build URL - use updated_at_min for incremental sync
            let url = `https://${shopifyStore}/admin/api/2024-01/customers.json?limit=250`;
            if (isIncremental && lastSyncTime) {
                url += `&updated_at_min=${lastSyncTime}`;
            }
            if (cursor) url += `&page_info=${cursor}`;

            const response = await fetch(url, {
                headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No body');
                console.error('[Marketing] Shopify API error:', response.status, response.statusText, errorBody);
                throw new Error(`Shopify API ${response.status} ${response.statusText}: ${errorBody}`);
            }

            const data = await response.json();
            const customers = data.customers || [];

            if (customers.length === 0) {
                console.log('[Marketing] No more customers to fetch');
                break;
            }

            // Process customers into batch, skipping null/invalid emails
            const batch = [];
            for (const c of customers) {
                // Skip customers without valid email (guest/phone-only accounts)
                if (!c.email || typeof c.email !== 'string' || !c.email.includes('@')) {
                    totalSkipped++;
                    continue;
                }

                const totalOrders = c.orders_count || 0;
                const totalSpent = parseFloat(c.total_spent || 0);
                const avgOrderValue = totalOrders > 0 ? totalSpent / totalOrders : 0;

                // Smart server-side segmentation using RFM analysis
                const customerData = {
                    total_spent: totalSpent,
                    total_orders: totalOrders,
                    last_order_date: c.last_order_id ? new Date().toISOString() : null,
                    first_order_date: c.created_at || null
                };
                const segment = marketingDB.smartSegment(customerData);
                const tier = marketingDB.smartTier(totalSpent);
                const healthScore = marketingDB.computeHealthScore(customerData);
                const churnRisk = marketingDB.computeChurnRisk(customerData);

                // Extract phone: prefer top-level, fallback to default_address.phone
                const customerPhone = c.phone || c.default_address?.phone || null;
                if (!c.phone && c.default_address?.phone) phonesRecovered++;

                batch.push({
                    shopifyCustomerId: c.id,
                    firstName: c.first_name,
                    lastName: c.last_name,
                    email: c.email,
                    phone: customerPhone,
                    totalOrders,
                    totalSpent,
                    averageOrderValue: avgOrderValue,
                    lastOrderDate: c.last_order_name ? new Date().toISOString() : null,
                    firstOrderDate: c.created_at || null,
                    tags: c.tags ? c.tags.split(',').map(t => t.trim()) : [],
                    location: c.default_address ? `${c.default_address.city || ''}, ${c.default_address.province || ''}`.trim() : null,
                    acceptsMarketing: c.accepts_marketing || false,
                    verifiedEmail: c.verified_email || false,
                    segment,
                    lifetimeValueTier: tier,
                    healthScore,
                    churnRisk
                });

                // Upsert in batches
                if (batch.length >= BATCH_SIZE) {
                    try {
                        await marketingDB.batchUpsertMarketingCustomers(batch);
                        totalSynced += batch.length;
                    } catch (batchErr) {
                        console.error('[Marketing] Batch upsert error:', batchErr.message);
                        // Fallback: try one-by-one for this batch
                        for (const item of batch) {
                            try {
                                await marketingDB.upsertMarketingCustomer(item);
                                totalSynced++;
                            } catch (e) {
                                console.error(`[Marketing] Skip customer ${item.email}: ${e.message}`);
                                totalSkipped++;
                            }
                        }
                    }
                    batch.length = 0; // Clear batch
                }
            }

            // Upsert remaining items in final batch
            if (batch.length > 0) {
                try {
                    await marketingDB.batchUpsertMarketingCustomers(batch);
                    totalSynced += batch.length;
                } catch (batchErr) {
                    console.error('[Marketing] Final batch upsert error:', batchErr.message);
                    for (const item of batch) {
                        try {
                            await marketingDB.upsertMarketingCustomer(item);
                            totalSynced++;
                        } catch (e) {
                            console.error(`[Marketing] Skip customer ${item.email}: ${e.message}`);
                            totalSkipped++;
                        }
                    }
                }
            }

            console.log(`[Marketing] Page ${pagesFetched + 1}: processed ${customers.length} customers (${totalSynced} synced, ${totalSkipped} skipped)`);

            // Extract cursor from Link header for next page
            const linkHeader = response.headers.get('link');
            cursor = null;
            if (linkHeader) {
                const nextMatch = linkHeader.match(/page_info=([^&>]+)>; rel="next"/);
                if (nextMatch) cursor = nextMatch[1];
            }
            pagesFetched++;
        } while (cursor && pagesFetched < 100); // Safety limit: max 100 pages

        await marketingDB.createAuditLog({
            action: 'synced',
            entityType: 'customer',
            actor: req.user?.sub || 'admin',
            details: { totalSynced, totalSkipped, phonesRecovered, mode: isIncremental ? 'incremental' : 'full' },
            ipAddress: req.ip
        });

        const mode = isIncremental ? 'incremental' : 'full';
        res.json({ success: true, totalSynced, totalSkipped, phonesRecovered, mode, message: `Synced ${totalSynced} customers (${mode})${totalSkipped > 0 ? `, ${totalSkipped} skipped (no email)` : ''}${phonesRecovered > 0 ? `, ${phonesRecovered} phones recovered from address` : ''}` });
    } catch (error) {
        console.error('[Marketing] Customer sync error:', error.message);
        res.status(500).json({ error: 'Customer sync failed: ' + error.message });
    }
});

// ── Templates ──

// GET /api/admin/marketing/templates - List all templates
app.get('/api/admin/marketing/templates', authenticateAdmin, async (req, res) => {
    try {
        // Parse isActive filter - convert string to boolean
        const filters = { ...req.query };
        if (filters.isActive !== undefined) {
            filters.isActive = filters.isActive === 'true';
        }
        
        const templates = await marketingDB.getMarketingTemplates(filters);
        
        // Enrich with usage stats
        for (const t of templates) {
            // Count campaigns using this template
            const { count: campaignCount } = await supabase
                .from('marketing_campaigns').select('*', { count: 'exact', head: true })
                .eq('template_id', t.id);
            
            // Count abandoned carts using this template
            const { count: cartCount } = await supabase
                .from('marketing_abandoned_carts').select('*', { count: 'exact', head: true })
                .eq('message_template_id', t.id);
            
            t.campaign_usage = campaignCount || 0;
            t.cart_usage = cartCount || 0;
        }
        
        res.json({ success: true, templates });
    } catch (error) {
        console.error('[Marketing] Templates list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

// GET /api/admin/marketing/templates/:id - Get template by ID
app.get('/api/admin/marketing/templates/:id', authenticateAdmin, async (req, res) => {
    try {
        const template = await marketingDB.getMarketingTemplateById(req.params.id);
        if (!template) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true, template });
    } catch (error) {
        console.error('[Marketing] Template detail error:', error.message);
        res.status(500).json({ error: 'Failed to fetch template' });
    }
});

// POST /api/admin/marketing/templates - Create template
app.post('/api/admin/marketing/templates', authenticateAdmin, async (req, res) => {
    try {
        const { name, category, language, header, headerType, body, footer, buttons, variables } = req.body;
        if (!name || !body) {
            return res.status(400).json({ error: 'Template name and body are required' });
        }
        const template = await marketingDB.createMarketingTemplate({
            name, category, language, header, headerType, body, footer, buttons, variables,
            createdBy: req.user?.sub || 'admin'
        });
        await marketingDB.createAuditLog({
            action: 'created', entityType: 'template', entityId: template.id, entityName: name,
            actor: req.user?.sub || 'admin', newValues: req.body, ipAddress: req.ip
        });
        res.json({ success: true, template });
    } catch (error) {
        console.error('[Marketing] Template create error:', error.message);
        res.status(500).json({ error: 'Failed to create template' });
    }
});

// PUT /api/admin/marketing/templates/:id - Update template
app.put('/api/admin/marketing/templates/:id', authenticateAdmin, async (req, res) => {
    try {
        const existing = await marketingDB.getMarketingTemplateById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Template not found' });

        const updated = await marketingDB.updateMarketingTemplate(req.params.id, req.body);
        await marketingDB.createAuditLog({
            action: 'updated', entityType: 'template', entityId: parseInt(req.params.id),
            actor: req.user?.sub || 'admin', previousValues: existing, newValues: req.body, ipAddress: req.ip
        });
        res.json({ success: true, template: updated });
    } catch (error) {
        console.error('[Marketing] Template update error:', error.message);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

// DELETE /api/admin/marketing/templates/:id - Soft delete template
app.delete('/api/admin/marketing/templates/:id', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.deleteMarketingTemplate(req.params.id);
        await marketingDB.createAuditLog({
            action: 'deleted', entityType: 'template', entityId: parseInt(req.params.id),
            actor: req.user?.sub || 'admin', ipAddress: req.ip
        });
        res.json(result);
    } catch (error) {
        console.error('[Marketing] Template delete error:', error.message);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// POST /api/admin/marketing/templates/:id/submit-meta - Submit template to Meta for approval
app.post('/api/admin/marketing/templates/:id/submit-meta', authenticateAdmin, async (req, res) => {
    try {
        const template = await marketingDB.getMarketingTemplateById(req.params.id);
        if (!template) return res.status(404).json({ error: 'Template not found' });

        if (!metaWhatsApp.isMetaConfigured()) {
            return res.status(400).json({ error: 'Meta Cloud API not configured. Set META_ACCESS_TOKEN and META_PHONE_NUMBER_ID.' });
        }

        const result = await metaWhatsApp.submitTemplateToMeta(template);
        if (result.success) {
            await marketingDB.updateMarketingTemplate(req.params.id, {
                metaTemplateId: result.templateId,
                metaStatus: 'PENDING'
            });
            await marketingDB.createAuditLog({
                action: 'template_submitted', entityType: 'template', entityId: parseInt(req.params.id),
                actor: req.user?.sub || 'admin', details: { metaTemplateId: result.templateId }, ipAddress: req.ip
            });
        }
        res.json({ success: result.success, error: result.error });
    } catch (error) {
        console.error('[Marketing] Template submit error:', error.message);
        res.status(500).json({ error: 'Failed to submit template to Meta' });
    }
});

// GET /api/admin/marketing/templates/:id/meta-status - Check template status on Meta
app.get('/api/admin/marketing/templates/:id/meta-status', authenticateAdmin, async (req, res) => {
    try {
        const template = await marketingDB.getMarketingTemplateById(req.params.id);
        if (!template) return res.status(404).json({ error: 'Template not found' });

        const result = await metaWhatsApp.getTemplateStatusFromMeta(template.name);
        if (result.success && result.status) {
            await marketingDB.updateMarketingTemplate(req.params.id, {
                metaStatus: result.status,
                metaRejectionReason: result.rejectionReason
            });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Template status check error:', error.message);
        res.status(500).json({ error: 'Failed to check template status' });
    }
});

// GET /api/admin/marketing/meta/templates - List all templates from Meta
app.get('/api/admin/marketing/meta/templates', authenticateAdmin, async (req, res) => {
    try {
        const result = await metaWhatsApp.listMetaTemplates(req.query.limit || 50);
        res.json(result);
    } catch (error) {
        console.error('[Marketing] Meta templates list error:', error.message);
        res.status(500).json({ error: 'Failed to list Meta templates' });
    }
});

// POST /api/admin/marketing/templates/sync-from-meta - Sync templates from Meta to local DB
app.post('/api/admin/marketing/templates/sync-from-meta', authenticateAdmin, async (req, res) => {
    try {
        // Check which specific credentials are missing
        const missing = [];
        if (!process.env.META_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN === 'your_meta_access_token_here') {
            missing.push('META_ACCESS_TOKEN');
        }
        if (!process.env.META_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID === 'your_phone_number_id_here') {
            missing.push('META_PHONE_NUMBER_ID');
        }
        if (!process.env.META_WABA_ID || process.env.META_WABA_ID === 'your_waba_id_here') {
            missing.push('META_WABA_ID');
        }
        
        if (missing.length > 0) {
            return res.status(400).json({ 
                error: `Meta Cloud API credentials not configured. Missing: ${missing.join(', ')}. Add them in your .env file. Get credentials from https://developers.facebook.com > Your App > WhatsApp > API Setup`,
                missingCredentials: missing
            });
        }

        if (!metaWhatsApp.isMetaConfigured()) {
            return res.status(400).json({ error: 'Meta Cloud API not properly configured. Check META_ACCESS_TOKEN and META_PHONE_NUMBER_ID in .env' });
        }

        // Fetch all templates from Meta
        const result = await metaWhatsApp.listMetaTemplates(100);
        
        if (!result.success || !result.templates) {
            return res.status(500).json({ error: result.error || 'Failed to fetch templates from Meta' });
        }

        const metaTemplates = result.templates;
        let created = 0;
        let updated = 0;
        let skipped = 0;

        for (const metaTemplate of metaTemplates) {
            try {
                // Extract template components
                const components = metaTemplate.components || [];
                
                let header = null;
                let headerType = 'text';
                let body = '';
                let footer = null;
                let buttons = [];
                let variables = [];

                // Parse components
                for (const component of components) {
                    if (component.type === 'HEADER') {
                        headerType = (component.format || 'TEXT').toLowerCase();
                        if (headerType === 'text' && component.text) {
                            header = component.text;
                        }
                    } else if (component.type === 'BODY') {
                        body = component.text || '';
                        // Extract variables from example
                        if (component.example?.body_text?.[0]) {
                            const examples = component.example.body_text[0];
                            const varRegex = /\{\{(\d+)\}\}/g;
                            let match;
                            let varIndex = 0;
                            while ((match = varRegex.exec(body)) !== null) {
                                varIndex++;
                                variables.push({
                                    name: match[1],
                                    type: 'text',
                                    example: examples[varIndex - 1] || 'example'
                                });
                            }
                        }
                    } else if (component.type === 'FOOTER') {
                        footer = component.text || null;
                    } else if (component.type === 'BUTTONS') {
                        buttons = (component.buttons || []).map(btn => ({
                            type: btn.type || 'QUICK_REPLY',
                            text: btn.text,
                            url: btn.url || null,
                            phone_number: btn.phone_number || null
                        }));
                    }
                }

                // Determine category from Meta template category
                const category = (metaTemplate.category || 'MARKETING').toLowerCase();
                
                // Check if template already exists
                const existing = await marketingDB.getMarketingTemplateByName(metaTemplate.name);
                
                if (existing) {
                    // Update existing template
                    await marketingDB.updateMarketingTemplate(existing.id, {
                        name: metaTemplate.name,
                        category: category,
                        language: metaTemplate.language || 'en',
                        status: metaTemplate.status === 'APPROVED' ? 'approved' : 'pending_approval',
                        header: header,
                        headerType: headerType,
                        body: body,
                        footer: footer,
                        buttons: buttons,
                        variables: variables,
                        metaTemplateId: metaTemplate.id,
                        metaStatus: metaTemplate.status || 'PENDING',
                        metaRejectionReason: metaTemplate.rejection_reason || null,
                        metaLastSyncedAt: new Date().toISOString(),
                        isActive: true
                    });
                    updated++;
                } else {
                    // Create new template
                    await marketingDB.createMarketingTemplate({
                        name: metaTemplate.name,
                        category: category,
                        language: metaTemplate.language || 'en',
                        status: metaTemplate.status === 'APPROVED' ? 'approved' : 'pending_approval',
                        header: header,
                        headerType: headerType,
                        body: body,
                        footer: footer,
                        buttons: buttons,
                        variables: variables,
                        metaTemplateId: metaTemplate.id,
                        metaStatus: metaTemplate.status || 'PENDING',
                        metaRejectionReason: metaTemplate.rejection_reason || null,
                        metaLastSyncedAt: new Date().toISOString(),
                        isActive: true
                    });
                    created++;
                }
            } catch (error) {
                console.error(`[Sync] Error processing template ${metaTemplate.name}:`, error.message);
                skipped++;
            }
        }

        // Log the sync action
        await marketingDB.createAuditLog({
            action: 'templates_synced_from_meta',
            actor: req.user?.sub || 'admin',
            details: { created, updated, skipped, total: metaTemplates.length },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: `Synced ${metaTemplates.length} templates from Meta`,
            created,
            updated,
            skipped
        });
    } catch (error) {
        console.error('[Marketing] Sync from Meta error:', error.message);
        res.status(500).json({ error: 'Failed to sync templates from Meta' });
    }
});

// ── Campaigns ──

// GET /api/admin/marketing/campaigns - List campaigns
app.get('/api/admin/marketing/campaigns', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getMarketingCampaigns(req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Campaigns list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// GET /api/admin/marketing/campaigns/:id - Get campaign by ID
app.get('/api/admin/marketing/campaigns/:id', authenticateAdmin, async (req, res) => {
    try {
        const campaign = await marketingDB.getMarketingCampaignById(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const recipientStats = await marketingDB.getCampaignRecipientStats(req.params.id);
        res.json({ success: true, campaign, recipientStats });
    } catch (error) {
        console.error('[Marketing] Campaign detail error:', error.message);
        res.status(500).json({ error: 'Failed to fetch campaign' });
    }
});

// POST /api/admin/marketing/campaigns - Create campaign
app.post('/api/admin/marketing/campaigns', authenticateAdmin, async (req, res) => {
    try {
        const { name, description, type, templateId, segmentFilter, recipientCount,
                excludedCustomers, scheduledAt, sendWindowStart, sendWindowEnd,
                timezone, budget, costPerMessage, notes, tags } = req.body;

        if (!name) return res.status(400).json({ error: 'Campaign name is required' });

        const campaign = await marketingDB.createMarketingCampaign({
            name, description, type, templateId, segmentFilter, recipientCount,
            excludedCustomers, scheduledAt, sendWindowStart, sendWindowEnd,
            timezone, budget, costPerMessage, notes, tags,
            createdBy: req.user?.sub || 'admin'
        });

        await marketingDB.createAuditLog({
            action: 'created', entityType: 'campaign', entityId: campaign.id, entityName: name,
            actor: req.user?.sub || 'admin', newValues: req.body, ipAddress: req.ip
        });
        res.json({ success: true, campaign });
    } catch (error) {
        console.error('[Marketing] Campaign create error:', error.message);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

// PUT /api/admin/marketing/campaigns/:id - Update campaign (only draft/scheduled)
app.put('/api/admin/marketing/campaigns/:id', authenticateAdmin, async (req, res) => {
    try {
        const existing = await marketingDB.getMarketingCampaignById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Campaign not found' });
        if (!['draft', 'scheduled'].includes(existing.status)) {
            return res.status(400).json({ error: 'Can only edit draft or scheduled campaigns' });
        }

        const updated = await marketingDB.updateMarketingCampaign(req.params.id, req.body);
        await marketingDB.createAuditLog({
            action: 'updated', entityType: 'campaign', entityId: parseInt(req.params.id),
            actor: req.user?.sub || 'admin', previousValues: existing, newValues: req.body, ipAddress: req.ip
        });
        res.json({ success: true, campaign: updated });
    } catch (error) {
        console.error('[Marketing] Campaign update error:', error.message);
        res.status(500).json({ error: 'Failed to update campaign' });
    }
});

// POST /api/admin/marketing/campaigns/:id/recipients - Add recipients to campaign
app.post('/api/admin/marketing/campaigns/:id/recipients', authenticateAdmin, async (req, res) => {
    try {
        const campaign = await marketingDB.getMarketingCampaignById(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        if (campaign.status !== 'draft') {
            return res.status(400).json({ error: 'Can only add recipients to draft campaigns' });
        }

        const { recipients } = req.body;
        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ error: 'Recipients array is required' });
        }

        const added = await marketingDB.addCampaignRecipients(req.params.id, recipients);
        res.json({ success: true, count: added.length });
    } catch (error) {
        console.error('[Marketing] Add recipients error:', error.message);
        res.status(500).json({ error: 'Failed to add recipients' });
    }
});

// GET /api/admin/marketing/campaigns/:id/recipients - Get campaign recipients
app.get('/api/admin/marketing/campaigns/:id/recipients', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getCampaignRecipients(req.params.id, req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Recipients list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch recipients' });
    }
});

// POST /api/admin/marketing/campaigns/:id/launch - Launch campaign (send messages)
app.post('/api/admin/marketing/campaigns/:id/launch', authenticateAdmin, async (req, res) => {
    try {
        const campaign = await marketingDB.getMarketingCampaignById(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
            return res.status(400).json({ error: 'Can only launch draft or scheduled campaigns' });
        }
        if (!campaign.template_id) {
            return res.status(400).json({ error: 'Campaign must have a template assigned before launching' });
        }

        // Get template
        const template = await marketingDB.getMarketingTemplateById(campaign.template_id);
        if (!template) return res.status(400).json({ error: 'Campaign template not found' });

        // Update status to sending
        await marketingDB.updateMarketingCampaign(req.params.id, { status: 'sending' });

        await marketingDB.createAuditLog({
            action: 'launched', entityType: 'campaign', entityId: parseInt(req.params.id),
            entityName: campaign.name, actor: req.user?.sub || 'admin', ipAddress: req.ip
        });

        // Launch async send (non-blocking)
        sendCampaignAsync(req.params.id, campaign, template, req.user?.sub || 'admin');

        res.json({ success: true, message: 'Campaign launch initiated. Messages will be sent in background.' });
    } catch (error) {
        console.error('[Marketing] Campaign launch error:', error.message);
        res.status(500).json({ error: 'Failed to launch campaign' });
    }
});

// POST /api/admin/marketing/campaigns/:id/pause - Pause campaign
app.post('/api/admin/marketing/campaigns/:id/pause', authenticateAdmin, async (req, res) => {
    try {
        const campaign = await marketingDB.getMarketingCampaignById(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        if (campaign.status !== 'sending') {
            return res.status(400).json({ error: 'Can only pause sending campaigns' });
        }

        const updated = await marketingDB.updateMarketingCampaign(req.params.id, { status: 'paused' });
        await marketingDB.createAuditLog({
            action: 'paused', entityType: 'campaign', entityId: parseInt(req.params.id),
            entityName: campaign.name, actor: req.user?.sub || 'admin', ipAddress: req.ip
        });
        res.json({ success: true, campaign: updated });
    } catch (error) {
        console.error('[Marketing] Campaign pause error:', error.message);
        res.status(500).json({ error: 'Failed to pause campaign' });
    }
});

// POST /api/admin/marketing/campaigns/:id/cancel - Cancel campaign
app.post('/api/admin/marketing/campaigns/:id/cancel', authenticateAdmin, async (req, res) => {
    try {
        const campaign = await marketingDB.getMarketingCampaignById(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const updated = await marketingDB.updateMarketingCampaign(req.params.id, { status: 'cancelled' });
        await marketingDB.createAuditLog({
            action: 'cancelled', entityType: 'campaign', entityId: parseInt(req.params.id),
            entityName: campaign.name, actor: req.user?.sub || 'admin', ipAddress: req.ip
        });
        res.json({ success: true, campaign: updated });
    } catch (error) {
        console.error('[Marketing] Campaign cancel error:', error.message);
        res.status(500).json({ error: 'Failed to cancel campaign' });
    }
});

// GET /api/admin/marketing/campaigns/:id/stats - Campaign stats
app.get('/api/admin/marketing/campaigns/:id/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await marketingDB.getCampaignRecipientStats(req.params.id);
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[Marketing] Campaign stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch campaign stats' });
    }
});

// ── Campaign Async Sender (background) ──

async function sendCampaignAsync(campaignId, campaign, template, actor) {
    try {
        const { data: recipients } = await supabase
            .from('marketing_campaign_recipients')
            .select('*')
            .eq('campaign_id', campaignId)
            .in('status', ['pending']);

        if (!recipients || recipients.length === 0) {
            await marketingDB.updateMarketingCampaign(campaignId, { status: 'sent' });
            await marketingDB.createCampaignSnapshot(campaignId);
            return;
        }

        console.log(`[Marketing Campaign] Sending ${recipients.length} messages for campaign ${campaignId}`);

        const batchSize = 50;
        const batchDelay = 2000;
        let sentCount = 0;
        let failedCount = 0;

        for (let i = 0; i < recipients.length; i += batchSize) {
            // Check if campaign was paused/cancelled
            const current = await marketingDB.getMarketingCampaignById(campaignId);
            if (current && (current.status === 'paused' || current.status === 'cancelled')) {
                console.log(`[Marketing Campaign] Campaign ${campaignId} ${current.status}. Stopping send.`);
                break;
            }

            const batch = recipients.slice(i, i + batchSize);
            const sendPromises = batch.map(async (recipient) => {
                try {
                    // Mark as queued
                    await marketingDB.updateCampaignRecipient(recipient.id, {
                        status: 'queued',
                        queuedAt: new Date().toISOString()
                    });

                    // Send via Meta WhatsApp (falls back to existing bot)
                    const result = await metaWhatsApp.sendTemplateMessage(
                        recipient.phone,
                        template.name,
                        recipient.template_variables ? Object.values(recipient.template_variables) : [],
                        template.language || 'en'
                    );

                    if (result.success) {
                        await marketingDB.updateCampaignRecipient(recipient.id, {
                            status: 'sent',
                            metaMessageId: result.messageId,
                            metaConversationId: result.conversationId || null,
                            metaPricingCategory: result.pricingCategory || null,
                            sentAt: new Date().toISOString()
                        });
                        sentCount++;
                    } else {
                        await marketingDB.updateCampaignRecipient(recipient.id, {
                            status: 'failed',
                            errorMessage: result.error,
                            failedAt: new Date().toISOString()
                        });
                        failedCount++;
                    }
                } catch (err) {
                    await marketingDB.updateCampaignRecipient(recipient.id, {
                        status: 'failed',
                        errorMessage: err.message,
                        failedAt: new Date().toISOString()
                    });
                    failedCount++;
                }
            });

            await Promise.all(sendPromises);
            console.log(`[Marketing Campaign] Batch ${Math.floor(i / batchSize) + 1}: sent=${sentCount}, failed=${failedCount}`);

            // Delay between batches
            if (i + batchSize < recipients.length) {
                await new Promise(resolve => setTimeout(resolve, batchDelay));
            }
        }

        // Mark campaign as sent
        await marketingDB.updateMarketingCampaign(campaignId, { status: 'sent' });
        await marketingDB.createCampaignSnapshot(campaignId);

        await marketingDB.createAuditLog({
            action: 'sent',
            entityType: 'campaign',
            entityId: parseInt(campaignId),
            entityName: campaign.name,
            actorType: 'system',
            actor: 'campaign-sender',
            details: { sentCount, failedCount, totalRecipients: recipients.length }
        });

        console.log(`[Marketing Campaign] Campaign ${campaignId} complete. Sent: ${sentCount}, Failed: ${failedCount}`);
    } catch (error) {
        console.error(`[Marketing Campaign] Fatal error for campaign ${campaignId}:`, error.message);
        await marketingDB.updateMarketingCampaign(campaignId, { status: 'failed' }).catch(() => {});
    }
}

// ── Coupon Management ──

// GET /api/admin/marketing/coupons - List coupons
app.get('/api/admin/marketing/coupons', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getMarketingCoupons(req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Coupons list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// GET /api/admin/marketing/coupons/stats - Coupon statistics
app.get('/api/admin/marketing/coupons/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await marketingDB.getCouponStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[Marketing] Coupon stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch coupon stats' });
    }
});

// GET /api/admin/marketing/coupons/:id - Get coupon by ID
app.get('/api/admin/marketing/coupons/:id', authenticateAdmin, async (req, res) => {
    try {
        const coupon = await marketingDB.getMarketingCouponById(req.params.id);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ success: true, coupon });
    } catch (error) {
        console.error('[Marketing] Coupon fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch coupon' });
    }
});

// POST /api/admin/marketing/coupons - Create coupon
app.post('/api/admin/marketing/coupons', authenticateAdmin, async (req, res) => {
    try {
        const { code, name, description, discountType, discountValue, minPurchaseAmount, 
                maxDiscountAmount, appliesTo, usageLimit, usageLimitPerCustomer, 
                applicableProducts, applicableCollections, segmentTarget, campaignId,
                startsAt, expiresAt } = req.body;

        if (!code || !discountValue) {
            return res.status(400).json({ error: 'Code and discount value are required' });
        }

        const coupon = await marketingDB.createMarketingCoupon({
            code, name, description, discountType, discountValue, minPurchaseAmount,
            maxDiscountAmount, appliesTo, usageLimit, usageLimitPerCustomer,
            applicableProducts, applicableCollections, segmentTarget, campaignId,
            startsAt, expiresAt, createdBy: req.adminUser || 'admin'
        });

        await marketingDB.createAuditLog({
            action: 'created', entityType: 'coupon', entityId: coupon.id,
            entityName: coupon.code, actor: req.adminUser || 'admin',
            newValues: coupon, ipAddress: req.ip, userAgent: req.get('user-agent')
        });

        res.json({ success: true, coupon });
    } catch (error) {
        console.error('[Marketing] Coupon create error:', error.message);
        res.status(500).json({ error: 'Failed to create coupon' });
    }
});

// PUT /api/admin/marketing/coupons/:id - Update coupon
app.put('/api/admin/marketing/coupons/:id', authenticateAdmin, async (req, res) => {
    try {
        const existing = await marketingDB.getMarketingCouponById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Coupon not found' });

        const coupon = await marketingDB.updateMarketingCoupon(req.params.id, req.body);

        await marketingDB.createAuditLog({
            action: 'updated', entityType: 'coupon', entityId: parseInt(req.params.id),
            entityName: coupon.code, actor: req.adminUser || 'admin',
            previousValues: existing, newValues: coupon,
            changedFields: Object.keys(req.body),
            ipAddress: req.ip, userAgent: req.get('user-agent')
        });

        res.json({ success: true, coupon });
    } catch (error) {
        console.error('[Marketing] Coupon update error:', error.message);
        res.status(500).json({ error: 'Failed to update coupon' });
    }
});

// DELETE /api/admin/marketing/coupons/:id - Soft delete coupon
app.delete('/api/admin/marketing/coupons/:id', authenticateAdmin, async (req, res) => {
    try {
        const existing = await marketingDB.getMarketingCouponById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Coupon not found' });

        await marketingDB.deleteMarketingCoupon(req.params.id);

        await marketingDB.createAuditLog({
            action: 'deleted', entityType: 'coupon', entityId: parseInt(req.params.id),
            entityName: existing.code, actor: req.adminUser || 'admin',
            previousValues: existing,
            ipAddress: req.ip, userAgent: req.get('user-agent')
        });

        res.json({ success: true, message: 'Coupon deleted' });
    } catch (error) {
        console.error('[Marketing] Coupon delete error:', error.message);
        res.status(500).json({ error: 'Failed to delete coupon' });
    }
});

// POST /api/admin/marketing/coupons/:id/sync-shopify - Sync coupon to Shopify as discount code
app.post('/api/admin/marketing/coupons/:id/sync-shopify', authenticateAdmin, async (req, res) => {
    try {
        const coupon = await marketingDB.getMarketingCouponById(req.params.id);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });

        // Build Shopify price rule payload
        const priceRule = {
            price_rule: {
                title: coupon.name || coupon.code,
                target_type: 'line_item',
                target_selection: coupon.applies_to === 'all' ? 'all' : 'entitled',
                allocation_method: 'across',
                value_type: coupon.discount_type === 'percentage' ? 'percentage' : 'fixed_amount',
                value: coupon.discount_type === 'fixed_amount' ? -Math.abs(parseFloat(coupon.discount_value)) : parseFloat(coupon.discount_value),
                allocation_limit: coupon.max_discount_amount ? parseFloat(coupon.max_discount_amount) : undefined,
                customer_selection: coupon.segment_target ? 'segment' : 'all',
                starts_at: coupon.starts_at || new Date().toISOString(),
                ends_at: coupon.expires_at || null,
                usage_limit: coupon.usage_limit || null,
                once_per_customer: coupon.usage_limit_per_customer === 1
            }
        };

        // Set minimum purchase requirement
        if (parseFloat(coupon.min_purchase_amount) > 0) {
            priceRule.price_rule.customer_selection = 'all';
            priceRule.price_rule.prerequisite_subtotal_range = {
                greater_than_or_equal_to: parseFloat(coupon.min_purchase_amount).toString()
            };
        }

        // Create price rule
        const ruleResult = await shopifyAPI('price_rules.json', {
            method: 'POST',
            body: JSON.stringify(priceRule)
        });

        const priceRuleId = ruleResult.price_rule.id;

        // Create discount code
        const codeResult = await shopifyAPI(`price_rules/${priceRuleId}/discount_codes.json`, {
            method: 'POST',
            body: JSON.stringify({ discount_code: { code: coupon.code, price_rule_id: priceRuleId } })
        });

        // Update coupon with Shopify IDs
        const updated = await marketingDB.updateMarketingCoupon(req.params.id, {
            shopifyPriceRuleId: priceRuleId,
            shopifyDiscountCodeId: codeResult.discount_code.id,
            shopifySyncStatus: 'synced',
            shopifySyncedAt: new Date().toISOString()
        });

        await marketingDB.createAuditLog({
            action: 'synced', entityType: 'coupon', entityId: parseInt(req.params.id),
            entityName: coupon.code, actor: req.adminUser || 'admin',
            details: { shopifyPriceRuleId: priceRuleId, shopifyDiscountCodeId: codeResult.discount_code.id },
            ipAddress: req.ip, userAgent: req.get('user-agent')
        });

        res.json({ success: true, coupon: updated, message: 'Coupon synced to Shopify' });
    } catch (error) {
        console.error('[Marketing] Coupon Shopify sync error:', error.message);
        await marketingDB.updateMarketingCoupon(req.params.id, {
            shopifySyncStatus: 'failed', shopifySyncError: error.message
        }).catch(() => {});
        res.status(500).json({ error: 'Failed to sync coupon to Shopify', details: error.message });
    }
});

// GET /api/admin/marketing/coupons/:id/usage - Get coupon usage history
app.get('/api/admin/marketing/coupons/:id/usage', authenticateAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('marketing_coupon_usage')
            .select('*').eq('coupon_id', req.params.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, usage: data || [] });
    } catch (error) {
        console.error('[Marketing] Coupon usage error:', error.message);
        res.status(500).json({ error: 'Failed to fetch coupon usage' });
    }
});


// ── Abandoned Cart Recovery ──

// GET /api/admin/marketing/abandoned-carts - List abandoned carts
app.get('/api/admin/marketing/abandoned-carts', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getAbandonedCarts(req.query);
        // Enrich customer_name: resolve real names from Shopify for email-derived names
        if (result.data && result.data.length > 0) {
            // Deduplicate by email — only lookup each unique email once
            const cartsNeedingLookup = result.data.filter(c => c.customer_name && !c.customer_name.includes(' ') && c.customer_email);
            const uniqueEmails = [...new Set(cartsNeedingLookup.map(c => c.customer_email))];
            // Resolve names for unique emails only (sequential to respect Shopify rate limits)
            const emailToName = new Map();
            for (const email of uniqueEmails) {
                // Check cache first to skip API calls entirely
                const cached = _customerNameCache.get(email);
                if (cached && (Date.now() - cached.ts < CUSTOMER_NAME_CACHE_TTL)) {
                    if (cached.name) emailToName.set(email, cached.name);
                    continue;
                }
                try {
                    const resolved = await resolveCustomerDisplayName({ customer_email: email, customer_name: null });
                    if (resolved && resolved !== 'there') emailToName.set(email, resolved);
                } catch (e) { /* ignore */ }
            }
            // Apply resolved names to all matching carts
            for (const cart of cartsNeedingLookup) {
                const resolved = emailToName.get(cart.customer_email);
                if (resolved && resolved !== cart.customer_name) {
                    cart.customer_name = resolved;
                    // Persist resolved name to DB so future lookups skip Shopify
                    supabase.from('marketing_abandoned_carts').update({ customer_name: resolved }).eq('id', cart.id).then(() => {}).catch(() => {});
                }
            }
        }
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Abandoned carts list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch abandoned carts' });
    }
});

// GET /api/admin/marketing/abandoned-carts/stats - Abandoned cart statistics
app.get('/api/admin/marketing/abandoned-carts/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await marketingDB.getAbandonedCartStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[Marketing] Abandoned cart stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch abandoned cart stats' });
    }
});

// GET /api/admin/marketing/abandoned-carts/recovered - List recovered carts
app.get('/api/admin/marketing/abandoned-carts/recovered', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getRecoveredCarts(req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Recovered carts list error:', error.message);
        res.status(500).json({ error: 'Failed to fetch recovered carts' });
    }
});

// GET /api/admin/marketing/abandoned-carts/recovered/stats - Recovered cart statistics
app.get('/api/admin/marketing/abandoned-carts/recovered/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await marketingDB.getRecoveredCartStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[Marketing] Recovered cart stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch recovered cart stats' });
    }
});

// POST /api/admin/marketing/abandoned-carts/scan-recoveries - Manual trigger to scan Shopify orders for recovery matching
app.post('/api/admin/marketing/abandoned-carts/scan-recoveries', authenticateAdmin, async (req, res) => {
    try {
        const result = await scanShopifyOrdersForRecoveries();
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Scan recoveries error:', error.message);
        res.status(500).json({ error: 'Failed to scan for recoveries' });
    }
});

// GET /api/admin/marketing/abandoned-carts/:id - Get cart by ID
app.get('/api/admin/marketing/abandoned-carts/:id', authenticateAdmin, async (req, res) => {
    try {
        const cart = await marketingDB.getAbandonedCartById(req.params.id);
        if (!cart) return res.status(404).json({ error: 'Cart not found' });
        res.json({ success: true, cart });
    } catch (error) {
        console.error('[Marketing] Abandoned cart fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch abandoned cart' });
    }
});

// POST /api/admin/marketing/abandoned-carts - Create abandoned cart (from checkout webhook or API)
app.post('/api/admin/marketing/abandoned-carts', authenticateAdmin, async (req, res) => {
    try {
        const { cartToken, customerEmail, customerPhone, customerName, shopifyCustomerId,
                checkoutId, checkoutUrl, cartValue, currency, items } = req.body;

        if (!cartToken) return res.status(400).json({ error: 'Cart token is required' });

        // Check if cart with this token already exists
        const { data: existing } = await supabase
            .from('marketing_abandoned_carts')
            .select('id').eq('cart_token', cartToken).limit(1);

        if (existing && existing.length > 0) {
            return res.json({ success: true, message: 'Cart already tracked', cartId: existing[0].id });
        }

        const cart = await marketingDB.createAbandonedCart({
            cartToken, customerEmail, customerPhone, customerName, shopifyCustomerId,
            checkoutId, checkoutUrl, cartValue, currency, items, source: 'api'
        });

        await marketingDB.createAuditLog({
            action: 'created', entityType: 'abandoned_cart', entityId: cart.id,
            entityName: `Cart ${cartToken.substring(0, 8)}`, actor: 'system', actorType: 'system',
            newValues: { cartToken, cartValue, customerEmail },
            ipAddress: req.ip, userAgent: req.get('user-agent')
        });

        res.json({ success: true, cart });
    } catch (error) {
        console.error('[Marketing] Abandoned cart create error:', error.message);
        res.status(500).json({ error: 'Failed to create abandoned cart' });
    }
});

// POST /api/admin/marketing/abandoned-carts/:id/send-reminder - Send WhatsApp reminder
app.post('/api/admin/marketing/abandoned-carts/:id/send-reminder', authenticateAdmin, async (req, res) => {
    try {
        const cart = await marketingDB.getAbandonedCartById(req.params.id);
        if (!cart) return res.status(404).json({ error: 'Cart not found' });
        if (!cart.customer_phone) return res.status(400).json({ error: 'No phone number for this cart' });

        const { reminderType, templateId } = req.body; // 'first', 'second', 'final' + optional templateId

        // Use directly-selected templateId if provided, otherwise fall back to settings
        let template;
        if (templateId) {
            template = await marketingDB.getMarketingTemplateById(templateId);
            if (template && template.status !== 'approved') {
                return res.status(400).json({ error: 'Selected template is not approved' });
            }
        }

        // Get linked template from settings
        if (!template) {
            const settingKey = `abandoned_cart_${reminderType}_template_id`;
            const templateSetting = await marketingDB.getMarketingSetting(settingKey);
            if (templateSetting) {
                template = await marketingDB.getMarketingTemplateById(templateSetting);
            }
        }
        
        // Fallback to search if no linked template
        if (!template) {
            const templates = await marketingDB.getMarketingTemplates({ category: 'utility', status: 'approved' });
            template = templates.find(t => t.name && t.name.toLowerCase().includes('abandoned')) || templates[0];
        }
        
        if (!template) {
            return res.status(400).json({ error: 'No approved template found for abandoned cart reminders' });
        }

        // Build variables pool from cart data
        // Resolve display name: try customer_name -> Shopify lookup -> email prefix -> 'there'
        const displayName = await resolveCustomerDisplayName(cart);
        // Add UTM tracking to checkout URL for smart recovery attribution
        const rawCheckoutUrl = cart.checkout_url || 'https://offcomfrt.com';
        const utmParams = `utm_source=whatsapp&utm_medium=abandoned_cart&utm_campaign=reminder_${reminderType || 'manual'}&utm_content=cart_${cart.id}`;
        const trackedCheckoutUrl = rawCheckoutUrl.includes('?')
            ? `${rawCheckoutUrl}&${utmParams}`
            : `${rawCheckoutUrl}?${utmParams}`;
        const varPool = [
            displayName,
            `${cart.items?.length || 0} item(s)`,
            `₹${cart.cart_value}`,
            trackedCheckoutUrl,
            cart.customer_phone || '',
            cart.customer_email || ''
        ];

        // Try to fetch template from Meta to build proper per-component parameters
        let prebuiltComponents = null;
        let totalParamCount = 0;
        try {
            const metaResult = await metaWhatsApp.getMetaTemplateByName(template.name);
            if (metaResult.success && metaResult.template) {
                // Count total placeholders across ALL components (header + body + button)
                const allComponents = metaResult.template.components || [];
                for (const comp of allComponents) {
                    if (comp.type === 'HEADER' && comp.text) {
                        totalParamCount += (comp.text.match(/\{\{\d+\}\}/g) || []).length;
                    } else if (comp.type === 'BODY' && comp.text) {
                        totalParamCount += (comp.text.match(/\{\{\d+\}\}/g) || []).length;
                    } else if (comp.type === 'BUTTONS') {
                        for (const btn of (comp.buttons || [])) {
                            if (btn.type === 'URL' && btn.url) {
                                totalParamCount += (btn.url.match(/\{\{\d+\}\}/g) || []).length;
                            }
                        }
                    }
                }
                // Build properly structured components (header, body, button each get their own params)
                prebuiltComponents = metaWhatsApp.buildTemplateComponents(metaResult.template, varPool);
                console.log(`[Send Reminder] Meta template "${template.name}" has ${totalParamCount} total params across ${prebuiltComponents.length} component(s)`);
            }
        } catch (e) {
            console.warn('[Send Reminder] Could not fetch Meta template details:', e.message);
        }

        // Build variables array matching expected parameter count
        let variables;
        if (totalParamCount > 0) {
            variables = varPool.slice(0, totalParamCount);
        } else {
            const templateVariables = template.variables || [];
            variables = templateVariables.map(v => {
                const name = String(v.name);
                switch (name) {
                    case '1': return varPool[0];
                    case '2': return varPool[1];
                    case '3': return varPool[2];
                    case '4': return varPool[3];
                    case '5': return varPool[4];
                    case '6': return varPool[5];
                    default: return v.example || '';
                }
            });
            if (variables.length === 0) {
                variables = varPool.slice(0, 4);
            }
        }

        console.log(`[Send Reminder] Sending ${variables.length} params for template "${template.name}":`, variables);
        
        // Send via Meta WhatsApp with template
        const sendResult = await metaWhatsApp.sendTemplateMessage(
            cart.customer_phone,
            template.name,
            variables,
            template.language || 'en',
            prebuiltComponents
        );

        // Update cart with template reference and reminder tracking
        const now = new Date().toISOString();
        const updates = { 
            lastReminderAt: now,
            messageTemplateId: template.id
        };
        
        // Update specific reminder timestamp
        if (reminderType === 'first') updates.firstReminderAt = now;
        else if (reminderType === 'second') updates.secondReminderAt = now;
        else if (reminderType === 'final') updates.finalReminderAt = now;
        
        await marketingDB.updateAbandonedCart(cart.id, updates);
        
        // Increment template usage count
        await marketingDB.updateMarketingTemplate(template.id, {
            usageCount: (template.usage_count || 0) + 1,
            lastUsedAt: now
        });

        res.json({ success: true, messageId: sendResult.messageId, templateName: template.name });
    } catch (error) {
        console.error('[Send Reminder] Error:', error);
        res.status(500).json({ error: 'Failed to send reminder' });
    }
});

// POST /api/admin/marketing/abandoned-carts/:id/mark-recovered - Mark cart as recovered
app.post('/api/admin/marketing/abandoned-carts/:id/mark-recovered', authenticateAdmin, async (req, res) => {
    try {
        const { recoveredOrderId, recoveredOrderName, recoveredAmount } = req.body;
        const now = new Date().toISOString();

        // Get current cart to compute recovery time
        const cart = await marketingDB.getAbandonedCartById(req.params.id);
        if (!cart) return res.status(404).json({ error: 'Cart not found' });

        const timeToRecovery = cart.created_at
            ? ((Date.now() - new Date(cart.created_at).getTime()) / (1000 * 60 * 60)).toFixed(2)
            : null;

        await marketingDB.updateAbandonedCart(req.params.id, {
            recoveryStatus: 'recovered',
            recoveredAt: now,
            recoveredOrderId: recoveredOrderId || null,
            recoveredOrderName: recoveredOrderName || null,
            recoveredAmount: recoveredAmount || cart.cart_value || 0,
            recoveryChannel: 'direct',
            recoveryDetectedAt: now,
            recoveryDetectionMethod: 'manual',
            timeToRecoveryHours: timeToRecovery ? parseFloat(timeToRecovery) : null
        });

        await marketingDB.createAuditLog({
            action: 'recovered',
            entityType: 'abandoned_cart',
            entityId: parseInt(req.params.id),
            entityName: `Cart ${cart.cart_token?.substring(0, 8) || req.params.id}`,
            actor: req.adminUser || 'admin',
            actorType: 'admin',
            newValues: { recoveredOrderId, recoveredOrderName, recoveredAmount: recoveredAmount || cart.cart_value, method: 'manual' },
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });

        res.json({ success: true, message: 'Cart marked as recovered' });
    } catch (error) {
        console.error('[Marketing] Mark recovered error:', error.message);
        res.status(500).json({ error: 'Failed to mark as recovered' });
    }
});

// ── Shopify Order Webhook (Auto Recovery Detection) ──

async function markCartAsRecovered(cart, orderData, detectionMethod) {
    const now = new Date().toISOString();
    const timeToRecovery = cart.created_at
        ? ((Date.now() - new Date(cart.created_at).getTime()) / (1000 * 60 * 60)).toFixed(2)
        : null;

    // Smart recovery channel attribution
    let channel = 'direct'; // came back on their own

    // 1. Check if order has UTM/referral attributes indicating WhatsApp click
    const orderAttrs = orderData.note_attributes || [];
    const utmSource = orderAttrs.find(a => a.name === 'utm_source' || a.name === 'referral_source');
    const utmMedium = orderAttrs.find(a => a.name === 'utm_medium');
    if (utmSource && String(utmSource.value).toLowerCase() === 'whatsapp') {
        channel = 'whatsapp';
    } else if (utmMedium && String(utmMedium.value).toLowerCase() === 'abandoned_cart') {
        channel = 'whatsapp';
    }
    // 2. Check Shopify referrals
    else if (orderData.referring_site && orderData.referring_site.includes('whatsapp')) {
        channel = 'whatsapp';
    }
    // 3. Heuristic: if a reminder was sent within 24h of the order, likely WhatsApp-driven
    else if (cart.reminder_count > 0 && cart.last_reminder_at) {
        const lastReminderTime = new Date(cart.last_reminder_at).getTime();
        const orderTime = new Date(orderData.created_at || now).getTime();
        if (orderTime - lastReminderTime < 24 * 60 * 60 * 1000) {
            channel = 'whatsapp';
        }
    }

    // 4. Check if a coupon code was used (likely from a coupon reminder)
    const discountCodes = orderData.discount_codes || [];
    if (discountCodes.length > 0 && channel === 'direct') {
        channel = 'coupon';
    }

    await marketingDB.updateAbandonedCart(cart.id, {
        recoveryStatus: 'recovered',
        recoveredAt: now,
        recoveredOrderId: String(orderData.id || ''),
        recoveredOrderName: orderData.name || orderData.order_number || '',
        recoveredAmount: parseFloat(orderData.total_price) || cart.cart_value || 0,
        recoveryChannel: channel,
        recoveryDetectedAt: now,
        recoveryDetectionMethod: detectionMethod,
        timeToRecoveryHours: timeToRecovery ? parseFloat(timeToRecovery) : null
    });

    await marketingDB.createAuditLog({
        action: 'auto_recovered',
        entityType: 'abandoned_cart',
        entityId: cart.id,
        entityName: `Cart ${cart.cart_token?.substring(0, 8) || cart.id}`,
        actor: detectionMethod,
        actorType: 'system',
        newValues: {
            orderId: orderData.id,
            orderName: orderData.name,
            orderTotal: orderData.total_price,
            channel,
            method: detectionMethod,
            timeToRecoveryHours: timeToRecovery
        },
        ipAddress: null,
        userAgent: null
    });

    return { cartId: cart.id, channel, timeToRecoveryHours: timeToRecovery };
}

/**
 * Scan Shopify orders for the last 7 days and match to non-recovered abandoned carts.
 * Used both by the cron job and the manual trigger endpoint.
 */
async function scanShopifyOrdersForRecoveries() {
    if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_STORE) {
        throw new Error('Shopify API not configured');
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    let recoveredCount = 0;
    let scannedOrders = 0;
    const recoveredCarts = [];

    try {
        // Fetch orders from the last 7 days using Shopify API
        let endpoint = `orders.json?status=any&created_at_min=${sevenDaysAgo}&fields=id,name,email,phone,created_at,total_price,customer,line_items,discount_codes,note_attributes,referring_site&limit=250`;

        while (endpoint) {
            const data = await shopifyAPI(endpoint);
            const orders = data.orders || [];
            scannedOrders += orders.length;

            for (const order of orders) {
                const orderEmail = order.email || (order.customer && order.customer.email) || null;
                const orderPhone = order.phone || (order.customer && order.customer.phone) || null;

                if (!orderEmail && !orderPhone) continue;

                // Find matching abandoned cart with smart product overlap scoring
                const orderItems = order.line_items || [];
                const matchingCart = await marketingDB.findMatchingAbandonedCart(orderEmail, orderPhone, orderItems);

                if (matchingCart) {
                    const result = await markCartAsRecovered(matchingCart, order, 'cron_scan');
                    recoveredCount++;
                    recoveredCarts.push(result);
                    console.log(`[Recovery Scan] Auto-detected recovery: Cart ${matchingCart.id} → Order ${order.name} (${orderEmail || orderPhone})`);
                }
            }

            // Check for next page
            endpoint = data.nextUrl ? data.nextUrl.replace(/^https?:\/\/[^/]+\//, '') : null;
        }

        console.log(`[Recovery Scan] Scanned ${scannedOrders} orders, found ${recoveredCount} recoveries`);
        return { scannedOrders, recoveredCount, recoveredCarts };
    } catch (error) {
        console.error('[Recovery Scan] Error:', error.message);
        throw error;
    }
}

// POST /api/webhooks/shopify/orders-create - Shopify order webhook for auto recovery detection
app.post('/api/webhooks/shopify/orders-create', express.json(), async (req, res) => {
    try {
        // Verify webhook signature if SHOPIFY_WEBHOOK_SECRET is set
        const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
        if (webhookSecret) {
            const crypto = require('crypto');
            const hmac = crypto.createHmac('sha256', webhookSecret);
            const digest = hmac.update(req.rawBody || JSON.stringify(req.body)).digest('base64');
            const signature = req.headers['x-shopify-hmac-sha256'];
            if (signature && digest !== signature) {
                console.warn('[Shopify Webhook] Invalid signature from IP:', req.ip);
                return res.status(401).json({ error: 'Invalid webhook signature' });
            }
        }

        const order = req.body;
        const orderEmail = order.email || (order.customer && order.customer.email) || null;
        const orderPhone = order.phone || (order.customer && order.customer.phone) || null;

        console.log(`[Shopify Order Webhook] Order ${order.name || order.id} for ${orderEmail || orderPhone || 'unknown'}`);

        if (!orderEmail && !orderPhone) {
            // No customer info to match, just acknowledge
            return res.json({ received: true });
        }

        // Find matching abandoned cart with smart product overlap scoring
        const matchingCart = await marketingDB.findMatchingAbandonedCart(orderEmail, orderPhone, order.line_items || []);

        if (matchingCart) {
            await markCartAsRecovered(matchingCart, order, 'shopify_webhook');
            console.log(`[Shopify Order Webhook] Auto-recovered cart ${matchingCart.id} → Order ${order.name}`);
        }

        res.json({ received: true, recovered: !!matchingCart });
    } catch (error) {
        console.error('[Shopify Order Webhook] Error:', error.message);
        // Always return 200 to Shopify so it doesn't retry
        res.status(200).json({ received: true, error: 'Processing failed' });
    }
});

// ── Gokwik Webhook ──

// Log the "no secret configured" warning once instead of on every webhook hit (log clutter fix)
let gokwikSecretWarned = false;

// POST /api/webhooks/gokwik/abandoned-cart - Receive abandoned cart events from Gokwik
app.post('/api/webhooks/gokwik/abandoned-cart', express.json(), async (req, res) => {
    try {
        const signature = req.headers['x-gokwik-signature'] || req.headers['x-gokwik-webhook-signature'];
        const webhookSecret = process.env.GOKWIK_WEBHOOK_SECRET;
        
        // Optional signature verification (only if secret is configured)
        if (webhookSecret && signature) {
            const rawBody = JSON.stringify(req.body);
            if (!verifyGokwikWebhook(rawBody, signature, webhookSecret)) {
                console.warn('[Gokwik Webhook] Invalid signature from IP:', req.ip);
                return res.status(401).json({ error: 'Invalid webhook signature' });
            }
        } else if (!webhookSecret && !gokwikSecretWarned) {
            gokwikSecretWarned = true;
            console.log('[Gokwik Webhook] No webhook secret configured - accepting without verification');
        }
        
        const payload = req.body;
        // Gokwik payload uses 'token' as checkout ID; fallback chain: checkout_id > id > order_id > token > session_id
        const checkoutIdLog = payload.checkout_id || payload.id || payload.order_id || payload.token || payload.session_id;
        console.log('[Gokwik Webhook] Received abandoned cart event:', checkoutIdLog);
        
        // Extract checkout ID — Gokwik uses 'token' as the primary checkout identifier
        const checkout_id = payload.checkout_id || payload.id || payload.order_id || payload.token || payload.session_id;
        const customer = payload.customer || {};
        const checkout_url = payload.checkout_url || payload.abc_url || null;
        const created_at = payload.created_at || new Date().toISOString();
        const checkout_version = process.env.GOKWIK_CHECKOUT_VERSION || 'v1';
        
        if (!checkout_id) {
            console.error('[Gokwik Webhook] No checkout identifier in payload. Full payload:', JSON.stringify(payload).substring(0, 500));
            return res.status(400).json({ error: 'checkout_id is required' });
        }
        
        // Check for duplicate checkout_id
        const { data: existing } = await supabase
            .from('marketing_abandoned_carts')
            .select('id')
            .eq('gokwik_checkout_id', checkout_id)
            .limit(1);
        
        if (existing && existing.length > 0) {
            console.log('[Gokwik Webhook] Cart already tracked for checkout:', checkout_id);
            return res.json({ success: true, message: 'Cart already tracked', cartId: existing[0].id });
        }
        
        // Map Gokwik payload to our schema
        // Gokwik puts items/pricing at top level (no 'cart' wrapper)
        const cartToken = `gokwik_${checkout_id}`;
        const customerEmail = customer.email || payload.mapped_email || null;
        const customerPhone = customer.phone || customer.mobile || null;
        
        // Robust customer name extraction — try multiple Gokwik payload locations
        let customerName = null;
        
        // 1. customer object: first_name + last_name or name
        if (customer.first_name || customer.last_name) {
            customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
        } else if (customer.name) {
            customerName = customer.name;
        }
        // 2. address object (Gokwik often puts name here)
        if (!customerName && payload.address) {
            const addr = typeof payload.address === 'string' ? {} : payload.address;
            if (addr.first_name || addr.last_name) {
                customerName = `${addr.first_name || ''} ${addr.last_name || ''}`.trim();
            } else if (addr.name) {
                customerName = addr.name;
            }
        }
        // 3. billing_address_details_pii (may be a JSON string or object)
        if (!customerName && payload.billing_address_details_pii) {
            try {
                const billing = typeof payload.billing_address_details_pii === 'string'
                    ? JSON.parse(payload.billing_address_details_pii)
                    : payload.billing_address_details_pii;
                if (billing.first_name || billing.last_name) {
                    customerName = `${billing.first_name || ''} ${billing.last_name || ''}`.trim();
                } else if (billing.name) {
                    customerName = billing.name;
                }
            } catch (e) { /* ignore parse errors */ }
        }
        // 4. shipping_address_details_pii (may be a JSON string or object)
        if (!customerName && payload.shipping_address_details_pii) {
            try {
                const shipping = typeof payload.shipping_address_details_pii === 'string'
                    ? JSON.parse(payload.shipping_address_details_pii)
                    : payload.shipping_address_details_pii;
                if (shipping.first_name || shipping.last_name) {
                    customerName = `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim();
                } else if (shipping.name) {
                    customerName = shipping.name;
                }
            } catch (e) { /* ignore parse errors */ }
        }
        // 5. shipping_address object (flat fields)
        if (!customerName && payload.shipping_address && typeof payload.shipping_address === 'object') {
            const sa = payload.shipping_address;
            if (sa.first_name || sa.last_name) {
                customerName = `${sa.first_name || ''} ${sa.last_name || ''}`.trim();
            } else if (sa.name) {
                customerName = sa.name;
            }
        }
        // 6. Try Shopify customer lookup by email for a real name (uses cache)
        if (!customerName && customerEmail) {
            try {
                const resolved = await resolveCustomerDisplayName({ customer_email: customerEmail, customer_name: null });
                // resolveCustomerDisplayName returns email-derived name as last resort;
                // only use if it's a real name (has space) or not email-derived
                if (resolved && resolved !== 'there' && resolved.includes(' ')) {
                    customerName = resolved;
                }
            } catch (e) { /* ignore Shopify lookup errors */ }
        }
        // 7. Fallback: derive name from email prefix (e.g. "brunosbro404" from email)
        if (!customerName && customerEmail) {
            customerName = customerEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, ' ').trim();
            // Capitalize first letter of each word
            customerName = customerName.replace(/\b\w/g, c => c.toUpperCase());
        }
        const cartValue = payload.original_total_price || payload.total_price || payload.items_subtotal_price || 0;
        const currency = payload.currency || 'INR';
        const items = payload.items || [];
        const payment_method = payload.payment_methods || null;
        
        // Create abandoned cart record
        const cartData = {
            cartToken,
            customerEmail,
            customerPhone,
            customerName,
            checkoutId: checkout_id,
            checkoutUrl: checkout_url,
            cartValue,
            currency,
            items,
            source: 'gokwik',
            // Gokwik-specific fields
            gokwikCheckoutId: checkout_id,
            checkoutVersion: checkout_version,
            gokwikCustomerPhoneVerified: customer.phone_verified || false,
            paymentMethod: payment_method
        };
        
        const newCart = await marketingDB.createAbandonedCart(cartData);
        
        console.log(`[Gokwik Webhook] Created abandoned cart ${newCart.id} for checkout ${checkout_id}`);
        
        // Create audit log
        await marketingDB.createAuditLog({
            action: 'created',
            entityType: 'abandoned_cart',
            entityId: newCart.id,
            entityName: `Gokwik Cart ${checkout_id.substring(0, 8)}`,
            actor: 'gokwik_webhook',
            actorType: 'system',
            newValues: { checkout_id, cartValue, customerEmail, customerPhone, checkout_version },
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });
        
        res.json({ success: true, cartId: newCart.id, message: 'Abandoned cart tracked successfully' });
    } catch (error) {
        console.error('[Gokwik Webhook] Error processing webhook:', error.message);
        res.status(500).json({ error: 'Failed to process webhook' });
    }
});


// ── Analytics ──

// GET /api/admin/marketing/analytics/overview - Analytics overview dashboard
app.get('/api/admin/marketing/analytics/overview', authenticateAdmin, async (req, res) => {
    try {
        const overview = await marketingDB.getMarketingAnalyticsOverview(req.query);
        res.json({ success: true, overview });
    } catch (error) {
        console.error('[Marketing] Analytics overview error:', error.message);
        res.status(500).json({ error: 'Failed to fetch analytics overview' });
    }
});

// GET /api/admin/marketing/analytics/campaigns - Campaign analytics
app.get('/api/admin/marketing/analytics/campaigns', authenticateAdmin, async (req, res) => {
    try {
        const data = await marketingDB.getCampaignAnalytics();
        res.json({ success: true, campaigns: data });
    } catch (error) {
        console.error('[Marketing] Campaign analytics error:', error.message);
        res.status(500).json({ error: 'Failed to fetch campaign analytics' });
    }
});

// GET /api/admin/marketing/analytics/channels - Channel analytics
app.get('/api/admin/marketing/analytics/channels', authenticateAdmin, async (req, res) => {
    try {
        const data = await marketingDB.getChannelAnalytics(req.query);
        res.json({ success: true, channels: data });
    } catch (error) {
        console.error('[Marketing] Channel analytics error:', error.message);
        res.status(500).json({ error: 'Failed to fetch channel analytics' });
    }
});

// GET /api/admin/marketing/analytics/segments - Segment analytics
app.get('/api/admin/marketing/analytics/segments', authenticateAdmin, async (req, res) => {
    try {
        const data = await marketingDB.getSegmentAnalytics(req.query);
        res.json({ success: true, segments: data });
    } catch (error) {
        console.error('[Marketing] Segment analytics error:', error.message);
        res.status(500).json({ error: 'Failed to fetch segment analytics' });
    }
});


// ── Settings ──

// GET /api/admin/marketing/settings - Get all settings
app.get('/api/admin/marketing/settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = await marketingDB.getAllMarketingSettings();
        // Filter out secret values for security
        const sanitized = settings.map(s => ({
            ...s,
            value: s.is_secret ? '••••••••' : s.value
        }));
        res.json({ success: true, settings: sanitized });
    } catch (error) {
        console.error('[Marketing] Settings fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// PUT /api/admin/marketing/settings/:key - Update a setting
app.put('/api/admin/marketing/settings/:key', authenticateAdmin, async (req, res) => {
    try {
        const { value } = req.body;
        if (value === undefined) return res.status(400).json({ error: 'Value is required' });

        const setting = await marketingDB.updateMarketingSetting(req.params.key, value, req.adminUser || 'admin');

        await marketingDB.createAuditLog({
            action: 'settings_changed', entityType: 'setting',
            entityName: req.params.key, actor: req.adminUser || 'admin',
            newValues: { key: req.params.key, value: req.body.value },
            ipAddress: req.ip, userAgent: req.get('user-agent')
        });

        res.json({ success: true, setting });
    } catch (error) {
        console.error('[Marketing] Settings update error:', error.message);
        res.status(500).json({ error: 'Failed to update setting' });
    }
});


// ── Audit Log ──

// GET /api/admin/marketing/audit-logs - Get audit logs with filters
app.get('/api/admin/marketing/audit-logs', authenticateAdmin, async (req, res) => {
    try {
        const result = await marketingDB.getAuditLogs(req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Marketing] Audit logs error:', error.message);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});


// ── Abandoned Cart Recovery Cron Job ──

async function processAbandonedCartReminders() {
    try {
        console.log('[Marketing Cron] Processing abandoned cart reminders...');

        // Check master auto-recovery switch
        const masterEnabled = await marketingDB.getMarketingSetting('abandoned_cart_auto_recovery');
        if (masterEnabled && String(masterEnabled).toLowerCase() !== 'true') {
            console.log('[Marketing Cron] Auto-recovery is disabled in settings, skipping');
            return;
        }

        // Load per-reminder-type enable flags
        const firstReminderEnabled  = (await marketingDB.getMarketingSetting('abandoned_cart_first_reminder_enabled')  ?? 'true').toString().toLowerCase() !== 'false';
        const secondReminderEnabled = (await marketingDB.getMarketingSetting('abandoned_cart_second_reminder_enabled') ?? 'true').toString().toLowerCase() !== 'false';
        const finalReminderEnabled  = (await marketingDB.getMarketingSetting('abandoned_cart_final_reminder_enabled')  ?? 'true').toString().toLowerCase() !== 'false';
        console.log(`[Marketing Cron] Reminder toggles — first: ${firstReminderEnabled}, second: ${secondReminderEnabled}, final: ${finalReminderEnabled}`);

        const carts = await marketingDB.getPendingReminderCarts();
        
        if (carts.length === 0) {
            console.log('[Marketing Cron] No carts need reminders');
            return;
        }

        console.log(`[Marketing Cron] Found ${carts.length} carts needing reminders`);
        
        // Log source breakdown
        const gokwikCount = carts.filter(c => c.checkout_source === 'gokwik').length;
        const shopifyCount = carts.filter(c => c.checkout_source === 'shopify' || !c.checkout_source).length;
        console.log(`[Marketing Cron] Source breakdown: Gokwik=${gokwikCount}, Shopify=${shopifyCount}`);

        for (const cart of carts) {
            try {
                if (!cart.customer_phone) continue;

                const hoursSinceCreated = (Date.now() - new Date(cart.created_at).getTime()) / (1000 * 60 * 60);
                let reminderType = null;

                // Schedule: 1hr -> first, 24hr -> second, 72hr -> final
                if (cart.recovery_status === 'pending' && hoursSinceCreated >= 1) {
                    reminderType = 'first';
                } else if (cart.recovery_status === 'first_reminder_sent' && hoursSinceCreated >= 24) {
                    reminderType = 'second';
                } else if (cart.recovery_status === 'second_reminder_sent' && hoursSinceCreated >= 72) {
                    reminderType = 'final';
                }

                if (!reminderType) continue;

                // Skip if this specific reminder type is disabled in settings
                if (reminderType === 'first'  && !firstReminderEnabled)  { continue; }
                if (reminderType === 'second' && !secondReminderEnabled) { continue; }
                if (reminderType === 'final'  && !finalReminderEnabled)  { continue; }

                // Get template from settings (same logic as manual send-reminder)
                const settingKey = `abandoned_cart_${reminderType}_template_id`;
                const templateSetting = await marketingDB.getMarketingSetting(settingKey);
                
                let template;
                if (templateSetting) {
                    template = await marketingDB.getMarketingTemplateById(templateSetting);
                }
                
                // Fallback: search for approved templates with "abandoned" in name
                if (!template) {
                    const templates = await marketingDB.getMarketingTemplates({ category: 'utility', status: 'approved' });
                    template = templates.find(t => t.name && t.name.toLowerCase().includes('abandoned')) || templates[0];
                }
                
                if (!template) {
                    console.error(`[Marketing Cron] No approved template found for ${reminderType} reminder`);
                    continue;
                }

                // Build variables pool from cart data
                // Resolve display name: try customer_name -> Shopify lookup -> email prefix -> 'there'
                const displayName = await resolveCustomerDisplayName(cart);
                // Add UTM tracking to checkout URL for smart recovery attribution
                const cronRawUrl = cart.checkout_url || 'https://offcomfrt.com';
                const cronUtm = `utm_source=whatsapp&utm_medium=abandoned_cart&utm_campaign=reminder_${reminderType}&utm_content=cart_${cart.id}`;
                const cronTrackedUrl = cronRawUrl.includes('?') ? `${cronRawUrl}&${cronUtm}` : `${cronRawUrl}?${cronUtm}`;
                const varPool = [
                    displayName,
                    `${cart.items?.length || 0} item(s)`,
                    `₹${cart.cart_value}`,
                    cronTrackedUrl,
                    cart.customer_phone || '',
                    cart.customer_email || ''
                ];

                // Try to fetch template from Meta to build proper per-component parameters
                let prebuiltComponents = null;
                let totalParamCount = 0;
                try {
                    const metaResult = await metaWhatsApp.getMetaTemplateByName(template.name);
                    if (metaResult.success && metaResult.template) {
                        // Count total placeholders across ALL components (header + body + button)
                        const allComponents = metaResult.template.components || [];
                        for (const comp of allComponents) {
                            if (comp.type === 'HEADER' && comp.text) {
                                totalParamCount += (comp.text.match(/\{\{\d+\}\}/g) || []).length;
                            } else if (comp.type === 'BODY' && comp.text) {
                                totalParamCount += (comp.text.match(/\{\{\d+\}\}/g) || []).length;
                            } else if (comp.type === 'BUTTONS') {
                                for (const btn of (comp.buttons || [])) {
                                    if (btn.type === 'URL' && btn.url) {
                                        totalParamCount += (btn.url.match(/\{\{\d+\}\}/g) || []).length;
                                    }
                                }
                            }
                        }
                        // Build properly structured components (header, body, button each get their own params)
                        prebuiltComponents = metaWhatsApp.buildTemplateComponents(metaResult.template, varPool);
                        console.log(`[Marketing Cron] Meta template "${template.name}" has ${totalParamCount} total params across ${prebuiltComponents.length} component(s)`);
                    }
                } catch (e) {
                    console.warn('[Marketing Cron] Could not fetch Meta template details:', e.message);
                }

                // Build variables array matching expected parameter count
                let variables;
                if (totalParamCount > 0) {
                    variables = varPool.slice(0, totalParamCount);
                } else {
                    const templateVariables = template.variables || [];
                    variables = templateVariables.map(v => {
                        const name = String(v.name);
                        switch (name) {
                            case '1': return varPool[0];
                            case '2': return varPool[1];
                            case '3': return varPool[2];
                            case '4': return varPool[3];
                            case '5': return varPool[4];
                            case '6': return varPool[5];
                            default: return v.example || '';
                        }
                    });
                    if (variables.length === 0) {
                        variables = varPool.slice(0, 4);
                    }
                }

                console.log(`[Marketing Cron] Sending ${variables.length} params for template "${template.name}":`, variables);

                // Send WhatsApp message via Meta API
                const sendResult = await metaWhatsApp.sendTemplateMessage(
                    cart.customer_phone,
                    template.name,
                    variables,
                    template.language || 'en',
                    prebuiltComponents
                ).catch(async () => {
                    // Fallback to bot
                    const fallbackName = await resolveCustomerDisplayName(cart);
                    const messageText = `Hi ${fallbackName}! You left items worth ₹${cart.cart_value} in your cart. ` +
                        `Complete your purchase now! ${cart.checkout_url || ''}`;
                    return metaWhatsApp.sendViaBot({
                        phone: cart.customer_phone,
                        message: messageText
                    });
                });

                // Update cart
                const now = new Date().toISOString();
                const updates = {
                    recoveryStatus: `${reminderType}_reminder_sent`,
                    lastReminderAt: now,
                    reminderCount: (cart.reminder_count || 0) + 1
                };
                if (reminderType === 'first') updates.firstReminderAt = now;
                if (reminderType === 'second') updates.secondReminderAt = now;
                if (reminderType === 'final') updates.finalReminderAt = now;

                await marketingDB.updateAbandonedCart(cart.id, updates);

                const sourceLabel = cart.checkout_source === 'gokwik' ? 'Gokwik' : 'Shopify';
                console.log(`[Marketing Cron] Sent ${reminderType} reminder to ${sourceLabel} cart ${cart.id} (${cart.customer_phone})`);

                // Rate limit: wait 2 seconds between messages
                await new Promise(r => setTimeout(r, 2000));
            } catch (cartErr) {
                console.error(`[Marketing Cron] Error processing cart ${cart.id}:`, cartErr.message);
            }
        }

        console.log('[Marketing Cron] Abandoned cart reminder processing complete');

        // Smart auto-expire: mark carts as expired if they are 7+ days old and still not recovered
        const { data: expiredCarts, error: expireErr } = await supabase
            .from('marketing_abandoned_carts')
            .select('id')
            .in('recovery_status', ['pending', 'first_reminder_sent', 'second_reminder_sent', 'final_reminder_sent'])
            .lt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

        if (!expireErr && expiredCarts && expiredCarts.length > 0) {
            const { error: updateErr } = await supabase
                .from('marketing_abandoned_carts')
                .update({ recovery_status: 'expired', updated_at: new Date().toISOString() })
                .in('id', expiredCarts.map(c => c.id));
            if (!updateErr) {
                console.log(`[Marketing Cron] Auto-expired ${expiredCarts.length} abandoned carts (7+ days old)`);
            }
        }
    } catch (error) {
        console.error('[Marketing Cron] Abandoned cart reminder error:', error.message);
    }
}

// ── Daily Analytics Aggregation Cron Job ──

async function aggregateDailyMarketingAnalytics() {
    try {
        console.log('[Marketing Cron] Aggregating daily analytics...');
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        // Check if already aggregated
        const { data: existing } = await supabase
            .from('marketing_analytics_daily')
            .select('id').eq('date', yesterday).limit(1);

        if (existing && existing.length > 0) {
            console.log(`[Marketing Cron] Analytics for ${yesterday} already exist`);
            return;
        }

        // Aggregate data
        const [
            { count: newCustomers },
            { count: campaignsSent },
            { count: campaignsDelivered },
            { count: campaignsRead },
            { count: campaignsFailed },
            { count: cartsAbandoned },
            { count: cartsRecovered },
            { data: revenueData }
        ] = await Promise.all([
            supabase.from('marketing_customers').select('*', { count: 'exact', head: true })
                .gte('created_at', yesterday).lt('created_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_campaign_recipients').select('*', { count: 'exact', head: true })
                .gte('sent_at', yesterday).lt('sent_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_campaign_recipients').select('*', { count: 'exact', head: true })
                .gte('delivered_at', yesterday).lt('delivered_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_campaign_recipients').select('*', { count: 'exact', head: true })
                .gte('read_at', yesterday).lt('read_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_campaign_recipients').select('*', { count: 'exact', head: true })
                .gte('failed_at', yesterday).lt('failed_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_abandoned_carts').select('*', { count: 'exact', head: true })
                .gte('created_at', yesterday).lt('created_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_abandoned_carts').select('*', { count: 'exact', head: true })
                .eq('recovery_status', 'recovered')
                .gte('recovered_at', yesterday).lt('recovered_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0]),
            supabase.from('marketing_coupon_usage').select('discount_amount, order_total')
                .gte('created_at', yesterday).lt('created_at', new Date(Date.now() - 86400000 + 86400000).toISOString().split('T')[0])
        ]);

        const couponRevenue = (revenueData || []).reduce((sum, u) => sum + (parseFloat(u.order_total) || 0), 0);
        const couponDiscount = (revenueData || []).reduce((sum, u) => sum + (parseFloat(u.discount_amount) || 0), 0);

        await supabase.from('marketing_analytics_daily').insert([{
            date: yesterday,
            new_customers: newCustomers || 0,
            campaigns_sent: campaignsSent || 0,
            campaigns_delivered: campaignsDelivered || 0,
            campaigns_read: campaignsRead || 0,
            campaigns_failed: campaignsFailed || 0,
            coupon_revenue: couponRevenue,
            coupon_discount_given: couponDiscount,
            carts_abandoned: cartsAbandoned || 0,
            carts_recovered: cartsRecovered || 0
        }]);

        console.log(`[Marketing Cron] Daily analytics for ${yesterday} aggregated successfully`);
    } catch (error) {
        console.error('[Marketing Cron] Daily analytics aggregation error:', error.message);
    }
}


// ==================== AI COPILOT (admin dashboards) ====================
// Tool-calling AI assistant with confirmation-gated actions. Engine in config/ai/.
// Server-internal functions are injected so tools can reuse existing integrations.

function getAiDeps() {
    return {
        shopifyAPI,
        schedulePickup,
        getShiprocketToken,
        getDelhiveryTracking,
        createShopifyDiscountCode,
        getLeaderboard,
        getAnalyticsForInfluencer
    };
}

app.post('/api/admin/ai/chat', authenticateAdmin, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }
        const { runAgent } = require('./config/ai/agent');
        const result = await runAgent({
            actor: req.user?.username || 'admin',
            userMessage: String(message).trim().substring(0, 4000),
            deps: getAiDeps()
        });
        res.json({ success: true, reply: result.reply, pendingAction: result.pendingAction, usage: result.usage });
    } catch (error) {
        console.error('AI chat error:', error.message);
        const friendly = error.code === 'AI_RATE_LIMIT' ? error.message : 'AI request failed. Please try again.';
        res.status(500).json({ success: false, error: friendly });
    }
});

app.post('/api/admin/ai/confirm/:id', authenticateAdmin, async (req, res) => {
    try {
        const { executeConfirmedAction } = require('./config/ai/agent');
        const result = await executeConfirmedAction(req.params.id, req.user?.username || 'admin', getAiDeps());
        if (!result.ok) return res.status(400).json({ success: false, error: result.error, summary: result.summary });
        res.json({ success: true, result: result.result, summary: result.summary });
    } catch (error) {
        console.error('AI confirm error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to execute action' });
    }
});

app.post('/api/admin/ai/cancel/:id', authenticateAdmin, async (req, res) => {
    try {
        const aiStore = require('./config/ai/aiStore');
        const result = await aiStore.cancelPendingAction(req.params.id, req.user?.username || 'admin');
        if (!result.ok) return res.status(400).json({ success: false, error: result.error });
        res.json({ success: true });
    } catch (error) {
        console.error('AI cancel error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to cancel action' });
    }
});

app.get('/api/admin/ai/usage', authenticateAdmin, async (req, res) => {
    try {
        const aiStore = require('./config/ai/aiStore');
        const { getConfig, isConfigured } = require('./config/ai/aiClient');
        const days = Math.min(parseInt(req.query.days) || 30, 90);
        const stats = await aiStore.getUsageStats(days);
        const cfg = getConfig();
        res.json({ success: true, configured: isConfigured(), provider: cfg.provider, model: cfg.model, ...stats });
    } catch (error) {
        console.error('AI usage error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch AI usage' });
    }
});

app.get('/api/admin/ai/history', authenticateAdmin, async (req, res) => {
    try {
        const aiStore = require('./config/ai/aiStore');
        const history = await aiStore.getChatHistory(req.user?.username || 'admin');
        res.json({ success: true, history });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load history' });
    }
});

app.post('/api/admin/ai/clear-history', authenticateAdmin, async (req, res) => {
    try {
        const aiStore = require('./config/ai/aiStore');
        await aiStore.clearChatHistory(req.user?.username || 'admin');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to clear history' });
    }
});

// Internal read-only data endpoint for the WhatsApp bot's AI copilot (reciprocal
// of the bot's /api/internal/ai-data). Auth: x-internal-token.
app.get('/api/internal/ai-data', async (req, res) => {
    try {
        const expectedToken = process.env.WHATSAPP_INTERNAL_TOKEN;
        if (expectedToken && req.headers['x-internal-token'] !== expectedToken) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const { resource, query = '', limit } = req.query;
        const n = Math.min(parseInt(limit) || 20, 50);
        const q = String(query).trim();

        switch (resource) {
            case 'requests': {
                const result = await getAllRequests({ search: q || undefined, status: undefined, limit: n, page: 1 });
                return res.json({ count: result.data.length, total: result.pagination?.total, requests: result.data });
            }
            case 'request_stats': {
                const stats = await getRequestStats();
                return res.json(stats);
            }
            case 'influencers': {
                const rows = await getAllInfluencers();
                const list = (rows || [])
                    .filter(i => !q || String(i.name || '').toLowerCase().includes(q.toLowerCase()) || String(i.referral_code || '').toLowerCase().includes(q.toLowerCase()))
                    .slice(0, n)
                    .map(i => ({ id: i.id, name: i.name, referralCode: i.referral_code, status: i.status }));
                return res.json({ count: list.length, influencers: list });
            }
            default:
                return res.status(400).json({ error: `Unknown resource '${resource}'. Use: requests, request_stats, influencers` });
        }
    } catch (error) {
        console.error('AI data endpoint error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

const exchangeDispatches = require('./config/exchange-dispatches');
exchangeDispatches.mount(app, { supabase, getEkartToken, getShiprocketToken });

// Inventory pipeline endpoint for the WhatsApp bot's Inventory Intelligence
// module: returns OPEN return/exchange requests within a time window — i.e.
// units still physically out with customers and expected back (returns) or
// reserved as replacements (exchanges). Auth: x-internal-token.
app.get('/api/internal/inventory-open-requests', async (req, res) => {
    try {
        const expectedToken = process.env.WHATSAPP_INTERNAL_TOKEN;
        if (expectedToken && req.headers['x-internal-token'] !== expectedToken) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const windowDays = Math.max(0, Math.min(parseInt(req.query.window, 10) || 90, 730));
        // Statuses where the items are still out with the customer (not yet
        // received back at the warehouse). delivered/inspected = received,
        // rejected/cancelled = never coming back. out_for_delivery = the
        // replacement shipment is still en route to the customer, so the
        // exchange is NOT closed yet.
        const OPEN_STATUSES = ['pending', 'approved', 'scheduled', 'waiting_payment', 'pickup_pending', 'pickup_booked', 'picked_up', 'in_transit', 'out_for_delivery'];

        let query = supabase.from('requests')
            .select('request_id, order_number, type, status, items, created_at')
            .in('status', OPEN_STATUSES)
            .order('created_at', { ascending: false })
            .range(0, 999);
        if (windowDays > 0) {
            const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
            query = query.gte('created_at', since);
        }
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, window_days: windowDays, count: (data || []).length, requests: data || [] });
    } catch (error) {
        console.error('Inventory open-requests endpoint error:', error.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ==================== PHONE OTP LOGIN (STOREFRONT) ====================
// Classic-account phone OTP login: Renflair (primary, if configured) or
// Message Central VerifyNow sends the OTP (no DLT needed), then the Shopify
// account is activated server-side and the storefront JS submits a normal
// /account/login form to receive the session cookie.
// See config/otp-service.js for the full flow and env vars.
const otpService = require('./config/otp-service');

// Strict limiter for OTP endpoints (on top of the general /api/ limiter)
const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 mins
    max: 15, // 15 OTP requests per IP per 5 minutes
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many login attempts. Please try again in a few minutes.',
    handler: rateLimitHandler
});

// Step 1: send OTP to the customer's phone
app.post('/api/auth/otp/send', otpLimiter, async (req, res) => {
    try {
        const { phone } = req.body || {};
        const normalized = otpService.normalizeIndianPhone(phone);
        if (!normalized) {
            return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
        }

        const result = await otpService.sendOtp(normalized);
        res.json({
            success: true,
            via: result.via,
            expiresInSeconds: result.expiresInSeconds,
            resendInSeconds: result.resendInSeconds,
            ...(result.devOtp ? { devOtp: result.devOtp } : {})
        });
    } catch (err) {
        if (err instanceof otpService.OtpError) {
            return res.status(err.status).json({ error: err.message, code: err.code });
        }
        console.error('[OTP] send error:', err.message);
        res.status(500).json({ error: 'Could not send OTP. Please try again.' });
    }
});

// Step 2: verify OTP, activate the Shopify account, return login credentials
// The theme submits these to /account/login as a normal same-origin form POST,
// which makes Shopify set the _secure_customer_session cookie directly.
app.post('/api/auth/otp/verify', otpLimiter, async (req, res) => {
    try {
        const { phone, otp } = req.body || {};
        const normalized = otpService.normalizeIndianPhone(phone);
        if (!normalized || !otp) {
            return res.status(400).json({ error: 'Phone and OTP are required' });
        }

        await otpService.verifyOtp(normalized, otp);

        const login = await otpService.issueStorefrontLogin(normalized);
        console.log(`[OTP] Login response for +${normalized}:`, JSON.stringify(login));
        res.json({ success: true, login });
    } catch (err) {
        if (err instanceof otpService.OtpError) {
            return res.status(err.status).json({ error: err.message, code: err.code });
        }
        console.error('[OTP] verify error:', err.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ==================== MANUFACTURE STUDIO (CONTROL TOWER) ====================
// Shared product-development workspace: admin manages everything at
// /manufacture/admin (Dashboard / Samples / Production / Manufacturers /
// Tech Packs); manufacturers (Shopify page: public/page.manufacture.liquid)
// see and update only the records assigned to their name. Multiple
// manufacturers are supported, same pattern as influencer portals: the admin
// enables "Portal Access" on a manufacturer, which mints a private link
// (?token=...) stored in manufacturers.link_token. The token exchanges for a
// JWT carrying the manufacturer's name; all portal routes are scoped by it.
const manufactureDB = require('./config/manufacture-db');

const MFR_KINDS = { manufacturers: 'manufacturers', techpacks: 'techPacks', samples: 'samples', orders: 'orders' };

// Fields the manufacturer may update on their own samples / orders
const MFR_SAMPLE_FIELDS = ['status', 'stage', 'mfrUpdate', 'changesRequired', 'courierAwb', 'dateSent', 'dateReceived', 'targetDate', 'nextDue', 'qc', 'comms', 'files', 'revisions'];
const MFR_ORDER_FIELDS = ['currentStage', 'trackingNumber', 'shippingMethod', 'actualDelivery', 'qc', 'comms', 'files'];

// Manufacturer auth middleware (JWT with role 'manufacturer'; the JWT payload
// carries the manufacturer's name, set when their link token was exchanged)
function authenticateManufacturer(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const decoded = verifyToken(authHeader.substring(7));
    if (!decoded || decoded.role !== 'manufacturer' || !decoded.manufacturerName) {
        return res.status(401).json({ error: 'Invalid or expired link. Ask Offcomfrt for your portal link.' });
    }
    req.user = decoded;
    req.manufacturerName = decoded.manufacturerName;
    next();
}

// Merge a manufacturer-submitted list (qc/comms/files/revisions) into the
// existing one: entries are add-only (deleting existing rows is rejected);
// per-row edits are restricted to rowWhitelist when provided.
function mergeMfrLists(existing, incoming, { rowWhitelist = null } = {}) {
    if (!Array.isArray(incoming)) return null;
    const pending = new Map((existing || []).map((r) => [String(r.id), r]));
    const merged = [];
    let seq = 0;
    for (const row of incoming) {
        if (!row || typeof row !== 'object') continue;
        const id = row.id != null ? String(row.id) : null;
        if (id && pending.has(id)) {
            const base = pending.get(id);
            if (rowWhitelist) {
                const next = { ...base };
                for (const k of rowWhitelist) if (row[k] !== undefined) next[k] = row[k];
                merged.push(next);
            } else {
                merged.push({ ...base, ...row, id: base.id });
            }
            pending.delete(id);
        } else {
            merged.push({ ...row, id: id || `MFR-${Date.now().toString(36).toUpperCase()}${++seq}` });
        }
    }
    if (pending.size > 0) {
        const err = new Error('Removing existing entries is not allowed');
        err.statusCode = 400;
        throw err;
    }
    return merged;
}

// POST /api/manufacture/login - exchange a portal link token (?token=...)
// plus the manufacturer's portal password for a session JWT. Each manufacturer
// with Portal Access has their own link + password pair.
app.post('/api/manufacture/login', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Portal link and password are required' });

    try {
        const manufacturer = await manufactureDB.getByLinkToken(String(token).trim());
        if (!manufacturer || !manufacturer.portalPassword || String(password) !== manufacturer.portalPassword) {
            trackSuspicious(req.ip, 'failed_manufacture_login');
            return res.status(401).json({ error: 'Invalid link or password' });
        }
        const sessionToken = generateToken({ role: 'manufacturer', manufacturerName: manufacturer.name, timestamp: Date.now() });
        res.json({ success: true, token: sessionToken, role: 'manufacturer', manufacturer_name: manufacturer.name });
    } catch (error) {
        console.error('[Manufacture] Login error:', error.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ---------- Manufacturers (scoped by the JWT's manufacturer name) ----------

// GET /api/manufacture/workspace - the manufacturer's slice of the workspace
app.get('/api/manufacture/workspace', authenticateManufacturer, async (req, res) => {
    try {
        const workspace = await manufactureDB.getManufacturerWorkspace(req.manufacturerName);
        res.json({ success: true, workspace });
    } catch (error) {
        console.error('[Manufacture] Workspace error:', error.message);
        res.status(500).json({ error: 'Failed to load workspace' });
    }
});

// PUT /api/manufacture/samples/:id - manufacturer updates whitelisted fields
app.put('/api/manufacture/samples/:id', authenticateManufacturer, async (req, res) => {
    try {
        const existing = await manufactureDB.getById('samples', req.params.id,
            { eq: { column: 'manufacturer', value: req.manufacturerName } });
        if (!existing) return res.status(404).json({ error: 'Sample not found' });

        const body = req.body || {};
        const patch = {};
        for (const key of MFR_SAMPLE_FIELDS) {
            if (body[key] === undefined) continue;
            if (key === 'qc') patch.qc = mergeMfrLists(existing.qc, body.qc, { rowWhitelist: ['actual', 'mfrComment'] });
            else if (key === 'comms') patch.comms = mergeMfrLists(existing.comms, body.comms);
            else if (key === 'files') patch.files = mergeMfrLists(existing.files, body.files);
            else if (key === 'revisions') patch.revisions = mergeMfrLists(existing.revisions, body.revisions, { rowWhitelist: ['mfrResponse', 'status', 'expectedCompletion', 'completedDate'] });
            else patch[key] = body[key];
        }
        if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

        const row = manufactureDB.toDb('samples', patch, { partial: true });
        const saved = await manufactureDB.updateById('samples', existing.id, row);
        res.json({ success: true, record: saved });
    } catch (error) {
        if (error.statusCode === 400) return res.status(400).json({ error: error.message });
        console.error('[Manufacture] Sample update error:', error.message, error.details || '', error.hint || '', error.code || '');
        res.status(500).json({ error: 'Failed to update sample: ' + (error.message || 'unknown error') });
    }
});

// PUT /api/manufacture/orders/:id - manufacturer updates whitelisted fields
app.put('/api/manufacture/orders/:id', authenticateManufacturer, async (req, res) => {
    try {
        const existing = await manufactureDB.getById('orders', req.params.id,
            { eq: { column: 'manufacturer', value: req.manufacturerName } });
        if (!existing) return res.status(404).json({ error: 'Order not found' });

        const body = req.body || {};
        const patch = {};
        for (const key of MFR_ORDER_FIELDS) {
            if (body[key] === undefined) continue;
            if (key === 'qc') patch.qc = mergeMfrLists(existing.qc, body.qc);
            else if (key === 'comms') patch.comms = mergeMfrLists(existing.comms, body.comms);
            else if (key === 'files') patch.files = mergeMfrLists(existing.files, body.files);
            else patch[key] = body[key];
        }
        if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

        const row = manufactureDB.toDb('orders', patch, { partial: true });
        const saved = await manufactureDB.updateById('orders', existing.id, row);
        res.json({ success: true, record: saved });
    } catch (error) {
        if (error.statusCode === 400) return res.status(400).json({ error: error.message });
        console.error('[Manufacture] Order update error:', error.message, error.details || '', error.hint || '', error.code || '');
        res.status(500).json({ error: 'Failed to update order: ' + (error.message || 'unknown error') });
    }
});

// PUT /api/manufacture/techpacks/:id - manufacturer raises/updates questions
app.put('/api/manufacture/techpacks/:id', authenticateManufacturer, async (req, res) => {
    try {
        const existing = await manufactureDB.getById('techPacks', req.params.id);
        if (!existing) return res.status(404).json({ error: 'Tech pack not found' });

        const { manufacturerQuestions } = req.body || {};
        if (manufacturerQuestions === undefined) return res.status(400).json({ error: 'Nothing to update' });

        const saved = await manufactureDB.updateById('techPacks', existing.id, {
            manufacturer_questions: String(manufacturerQuestions || '').trim() || null
        });
        res.json({ success: true, record: saved });
    } catch (error) {
        console.error('[Manufacture] Tech pack question error:', error.message, error.details || '', error.code || '');
        res.status(500).json({ error: 'Failed to save questions: ' + (error.message || 'unknown error') });
    }
});

// ---------- Admin (full control tower) ----------

// GET /api/manufacture/admin/workspace - entire workspace
app.get('/api/manufacture/admin/workspace', authenticateAdmin, async (req, res) => {
    try {
        const workspace = await manufactureDB.getWorkspace();
        res.json({ success: true, workspace });
    } catch (error) {
        console.error('[Manufacture] Admin workspace error:', error.message);
        res.status(500).json({ error: 'Failed to load workspace' });
    }
});

// When Portal Access is enabled: require a portal password and mint a private
// link token if there isn't one (toggling off/on reuses the same link)
function validatePortalAccess(kind, record) {
    if (kind !== 'manufacturers' || !record.portalAccess) return;
    if (!String(record.portalPassword || '').trim()) {
        const err = new Error('Portal password is required when Portal Access is enabled');
        err.statusCode = 400;
        throw err;
    }
    if (!String(record.linkToken || '').trim()) record.linkToken = crypto.randomBytes(16).toString('hex');
}

// POST /api/manufacture/admin/:kind - create a record (kind: manufacturers | techpacks | samples | orders)
app.post('/api/manufacture/admin/:kind', authenticateAdmin, async (req, res) => {
    const kind = MFR_KINDS[req.params.kind];
    if (!kind) return res.status(404).json({ error: 'Unknown resource' });
    try {
        const record = req.body || {};
        if (kind === 'manufacturers') {
            if (!String(record.name || '').trim()) return res.status(400).json({ error: 'Manufacturer name is required' });
        } else {
            const id = String(record.id || '').trim();
            if (!id) return res.status(400).json({ error: 'ID is required' });
            const dup = await manufactureDB.getById(kind, id);
            if (dup) return res.status(409).json({ error: `An entry with ID "${id}" already exists` });
        }
        validatePortalAccess(kind, record);
        const created = await manufactureDB.insert(kind, record);
        res.status(201).json({ success: true, record: created });
    } catch (error) {
        if (error.statusCode === 400) return res.status(400).json({ error: error.message });
        if (error.code === '23505') return res.status(409).json({ error: 'An entry with that ID/name already exists' });
        console.error('[Manufacture] Admin create error:', error.message);
        res.status(500).json({ error: 'Failed to create record' });
    }
});

// PUT /api/manufacture/admin/:kind - upsert a record on its id
app.put('/api/manufacture/admin/:kind', authenticateAdmin, async (req, res) => {
    const kind = MFR_KINDS[req.params.kind];
    if (!kind) return res.status(404).json({ error: 'Unknown resource' });
    try {
        const record = req.body || {};
        const id = String(record.id || '').trim();
        if (!id) return res.status(400).json({ error: 'ID is required' });
        if (kind === 'manufacturers' && !String(record.name || '').trim()) {
            return res.status(400).json({ error: 'Manufacturer name is required' });
        }
        validatePortalAccess(kind, record);
        const row = manufactureDB.toDb(kind, record, { partial: true });
        // Try update first (record should already exist for admin edits);
        // fall back to upsert in case the row is missing.
        let saved;
        try {
            saved = await manufactureDB.updateById(kind, id, row);
        } catch (updateErr) {
            if (updateErr.code === 'PGRST116') {
                // No row matched — fall back to full upsert (insert)
                saved = await manufactureDB.upsert(kind, id, row);
            } else {
                throw updateErr;
            }
        }
        res.json({ success: true, record: saved });
    } catch (error) {
        if (error.statusCode === 400) return res.status(400).json({ error: error.message });
        if (error.code === '23505') return res.status(409).json({ error: 'An entry with that name already exists' });
        console.error('[Manufacture] Admin update error:', error.message, error.details || '', error.hint || '', error.code || '');
        res.status(500).json({ error: 'Failed to update record: ' + (error.message || 'unknown error') });
    }
});

// DELETE /api/manufacture/admin/:kind?id=... - remove a record
app.delete('/api/manufacture/admin/:kind', authenticateAdmin, async (req, res) => {
    const kind = MFR_KINDS[req.params.kind];
    if (!kind) return res.status(404).json({ error: 'Unknown resource' });
    try {
        const id = String(req.query.id || '').trim();
        if (!id) return res.status(400).json({ error: 'ID is required' });
        await manufactureDB.remove(kind, id);
        res.json({ success: true });
    } catch (error) {
        console.error('[Manufacture] Admin delete error:', error.message);
        res.status(500).json({ error: 'Failed to delete record' });
    }
});

// POST /api/manufacture/admin/manufacturers/:id/regenerate-link - mint a fresh
// portal link token (the previous link stops working immediately)
app.post('/api/manufacture/admin/manufacturers/:id/regenerate-link', authenticateAdmin, async (req, res) => {
    try {
        const existing = await manufactureDB.getById('manufacturers', req.params.id);
        if (!existing) return res.status(404).json({ error: 'Manufacturer not found' });
        const saved = await manufactureDB.upsert('manufacturers', existing.id, {
            link_token: crypto.randomBytes(16).toString('hex')
        });
        res.json({ success: true, record: saved });
    } catch (error) {
        console.error('[Manufacture] Admin regenerate link error:', error.message);
        res.status(500).json({ error: 'Failed to regenerate portal link' });
    }
});

// ==================== FOUNDER OS (cloud-synced workspace state) ====================

// GET /api/founder-os/state - load the founder's workspace state
app.get('/api/founder-os/state', authenticateAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('founder_os_state')
            .select('state, updated_at')
            .eq('key', 'main')
            .maybeSingle();
        if (error) throw error;
        res.json({ success: true, state: data ? data.state : null, updatedAt: data ? data.updated_at : null });
    } catch (error) {
        console.error('[FounderOS] Load state error:', error.message);
        res.status(500).json({ error: 'Failed to load Founder OS state' });
    }
});

// PUT /api/founder-os/state - save (upsert) the founder's workspace state
app.put('/api/founder-os/state', authenticateAdmin, async (req, res) => {
    try {
        const { state } = req.body || {};
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            return res.status(400).json({ error: 'state object is required' });
        }
        const { error } = await supabase
            .from('founder_os_state')
            .upsert({
                key: 'main',
                state,
                updated_by: (req.user && (req.user.username || req.user.role)) || 'admin',
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('[FounderOS] Save state error:', error.message);
        res.status(500).json({ error: 'Failed to save Founder OS state' });
    }
});

// ==================== TECH TEAM PORTAL ====================
// Task management portal for the internal tech team.
// Members log in with username + mobile; admins assign and track tasks.
const techTeamDB = require('./config/tech-team-db');

// Team member authentication middleware
function authenticateTeamMember(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const decoded = verifyToken(authHeader.substring(7));
    if (!decoded || decoded.role !== 'team_member') {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.teamMember = decoded;
    next();
}

// ---------- Page Routes ----------
app.get('/tech-team/admin', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://exchange-return-tracking.onrender.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com;");
    res.sendFile(path.join(__dirname, 'public', 'tech-team', 'admin.html'));
});

app.get('/tech-team/portal', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://exchange-return-tracking.onrender.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com;");
    res.sendFile(path.join(__dirname, 'public', 'tech-team', 'portal.html'));
});

// ---------- Team Member Login ----------
app.post('/api/tech-team/login', async (req, res) => {
    try {
        const { username, mobile } = req.body;
        if (!username || !mobile) {
            return res.status(400).json({ error: 'Username and mobile number are required' });
        }
        const member = await techTeamDB.getTeamMemberByLogin(username, mobile);
        if (!member) {
            trackSuspicious(req.ip, 'failed_team_login');
            return res.status(401).json({ error: 'Invalid credentials or account deactivated' });
        }
        const token = generateToken({ role: 'team_member', memberId: member.id, username: member.username, name: member.fullName, timestamp: Date.now() });
        res.json({ success: true, token, member });
    } catch (error) {
        console.error('[TechTeam] Login error:', error.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ---------- Team Member Routes (self-scoped) ----------
app.get('/api/tech-team/me', authenticateTeamMember, async (req, res) => {
    try {
        const member = await techTeamDB.getTeamMember(req.teamMember.memberId);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        res.json({ success: true, member });
    } catch (error) {
        console.error('[TechTeam] Get me error:', error.message);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

app.get('/api/tech-team/my-tasks', authenticateTeamMember, async (req, res) => {
    try {
        const tasks = await techTeamDB.getMemberTasks(req.teamMember.memberId);
        res.json({ success: true, tasks });
    } catch (error) {
        console.error('[TechTeam] My tasks error:', error.message);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

app.put('/api/tech-team/my-tasks/:id', authenticateTeamMember, async (req, res) => {
    try {
        // Members can only update their own tasks, and only certain fields
        const task = await techTeamDB.getTask(req.params.id);
        if (!task || task.assignedTo !== req.teamMember.memberId) {
            return res.status(404).json({ error: 'Task not found or not assigned to you' });
        }
        const allowed = ['status', 'progress', 'actualHours'];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        const updated = await techTeamDB.updateTask(req.params.id, updates);
        res.json({ success: true, task: updated });
    } catch (error) {
        console.error('[TechTeam] Update task error:', error.message);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

app.post('/api/tech-team/my-tasks/:id/notes', authenticateTeamMember, async (req, res) => {
    try {
        const task = await techTeamDB.getTask(req.params.id);
        if (!task || task.assignedTo !== req.teamMember.memberId) {
            return res.status(404).json({ error: 'Task not found or not assigned to you' });
        }
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Note text is required' });
        const notes = await techTeamDB.addTaskNote(req.params.id, { text, author: req.teamMember.name || req.teamMember.username });
        res.json({ success: true, notes });
    } catch (error) {
        console.error('[TechTeam] Add note error:', error.message);
        res.status(500).json({ error: 'Failed to add note' });
    }
});

// ---------- Admin Routes (full control) ----------

// Members
app.get('/api/tech-team/admin/members', authenticateAdmin, async (req, res) => {
    try {
        const members = await techTeamDB.listTeamMembers();
        res.json({ success: true, members });
    } catch (error) {
        console.error('[TechTeam] List members error:', error.message);
        res.status(500).json({ error: 'Failed to fetch members' });
    }
});

app.post('/api/tech-team/admin/members', authenticateAdmin, async (req, res) => {
    try {
        const member = await techTeamDB.createTeamMember(req.body);
        res.json({ success: true, member });
    } catch (error) {
        console.error('[TechTeam] Create member error:', error.message);
        res.status(500).json({ error: 'Failed to create member: ' + error.message });
    }
});

app.put('/api/tech-team/admin/members/:id', authenticateAdmin, async (req, res) => {
    try {
        const member = await techTeamDB.updateTeamMember(req.params.id, req.body);
        res.json({ success: true, member });
    } catch (error) {
        console.error('[TechTeam] Update member error:', error.message);
        res.status(500).json({ error: 'Failed to update member' });
    }
});

app.delete('/api/tech-team/admin/members/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteTeamMember(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete member error:', error.message);
        res.status(500).json({ error: 'Failed to delete member' });
    }
});

// Tasks
app.get('/api/tech-team/admin/tasks', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.status) filters.status = req.query.status;
        if (req.query.assignedTo) filters.assignedTo = req.query.assignedTo;
        if (req.query.project) filters.project = req.query.project;
        if (req.query.priority) filters.priority = req.query.priority;
        if (req.query.department) filters.department = req.query.department;
        if (req.query.category) filters.category = req.query.category;
        const tasks = await techTeamDB.listTasks(filters);
        res.json({ success: true, tasks });
    } catch (error) {
        console.error('[TechTeam] List tasks error:', error.message);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

app.post('/api/tech-team/admin/tasks', authenticateAdmin, async (req, res) => {
    try {
        if (req.body.createdBy) req.body.createdBy = req.body.createdBy;
        const task = await techTeamDB.createTask(req.body);
        res.json({ success: true, task });
    } catch (error) {
        console.error('[TechTeam] Create task error:', error.message);
        res.status(500).json({ error: 'Failed to create task' });
    }
});

app.put('/api/tech-team/admin/tasks/:id', authenticateAdmin, async (req, res) => {
    try {
        const task = await techTeamDB.updateTask(req.params.id, req.body);
        res.json({ success: true, task });
    } catch (error) {
        console.error('[TechTeam] Update task error:', error.message);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

app.delete('/api/tech-team/admin/tasks/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteTask(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete task error:', error.message);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

app.post('/api/tech-team/admin/tasks/:id/notes', authenticateAdmin, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Note text is required' });
        const author = req.body.author || 'Admin';
        const notes = await techTeamDB.addTaskNote(req.params.id, { text, author });
        res.json({ success: true, notes });
    } catch (error) {
        console.error('[TechTeam] Add note error:', error.message);
        res.status(500).json({ error: 'Failed to add note' });
    }
});

// Stats
app.get('/api/tech-team/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await techTeamDB.getStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[TechTeam] Stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Premium Stats
app.get('/api/tech-team/admin/premium-stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await techTeamDB.getPremiumStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[TechTeam] Premium stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch premium stats' });
    }
});

// ---------- Premium Admin Routes ----------

// Reviews
app.get('/api/tech-team/admin/reviews', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.memberId) filters.memberId = req.query.memberId;
        if (req.query.period) filters.period = req.query.period;
        if (req.query.reviewType) filters.reviewType = req.query.reviewType;
        const reviews = await techTeamDB.listReviews(filters);
        res.json({ success: true, reviews });
    } catch (error) {
        console.error('[TechTeam] List reviews error:', error.message);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

app.post('/api/tech-team/admin/reviews', authenticateAdmin, async (req, res) => {
    try {
        // Fallback: if reviewerId not provided, use memberId (self-review) or 'admin'
        if (!req.body.reviewerId) {
            req.body.reviewerId = req.body.memberId || 'admin';
        }
        const review = await techTeamDB.createReview(req.body);
        res.json({ success: true, review });
    } catch (error) {
        console.error('[TechTeam] Create review error:', error.message);
        res.status(500).json({ error: 'Failed to create review' });
    }
});

app.put('/api/tech-team/admin/reviews/:id', authenticateAdmin, async (req, res) => {
    try {
        const review = await techTeamDB.updateReview(req.params.id, req.body);
        res.json({ success: true, review });
    } catch (error) {
        console.error('[TechTeam] Update review error:', error.message);
        res.status(500).json({ error: 'Failed to update review' });
    }
});

app.delete('/api/tech-team/admin/reviews/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteReview(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete review error:', error.message);
        res.status(500).json({ error: 'Failed to delete review' });
    }
});

// Skills
app.get('/api/tech-team/admin/skills', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.memberId) filters.memberId = req.query.memberId;
        if (req.query.category) filters.category = req.query.category;
        if (req.query.skillName) filters.skillName = req.query.skillName;
        const skills = await techTeamDB.listSkills(filters);
        res.json({ success: true, skills });
    } catch (error) {
        console.error('[TechTeam] List skills error:', error.message);
        res.status(500).json({ error: 'Failed to fetch skills' });
    }
});

app.get('/api/tech-team/admin/skill-matrix', authenticateAdmin, async (req, res) => {
    try {
        const matrix = await techTeamDB.getSkillMatrix();
        res.json({ success: true, matrix });
    } catch (error) {
        console.error('[TechTeam] Skill matrix error:', error.message);
        res.status(500).json({ error: 'Failed to fetch skill matrix' });
    }
});

app.post('/api/tech-team/admin/skills', authenticateAdmin, async (req, res) => {
    try {
        const skill = await techTeamDB.createSkill(req.body);
        res.json({ success: true, skill });
    } catch (error) {
        console.error('[TechTeam] Create skill error:', error.message);
        res.status(500).json({ error: 'Failed to create skill' });
    }
});

app.put('/api/tech-team/admin/skills/:id', authenticateAdmin, async (req, res) => {
    try {
        const skill = await techTeamDB.updateSkill(req.params.id, req.body);
        res.json({ success: true, skill });
    } catch (error) {
        console.error('[TechTeam] Update skill error:', error.message);
        res.status(500).json({ error: 'Failed to update skill' });
    }
});

app.delete('/api/tech-team/admin/skills/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteSkill(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete skill error:', error.message);
        res.status(500).json({ error: 'Failed to delete skill' });
    }
});

// OKRs
app.get('/api/tech-team/admin/okrs', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.memberId) filters.memberId = req.query.memberId;
        if (req.query.period) filters.period = req.query.period;
        if (req.query.status) filters.status = req.query.status;
        const okrs = await techTeamDB.listOkrs(filters);
        res.json({ success: true, okrs });
    } catch (error) {
        console.error('[TechTeam] List OKRs error:', error.message);
        res.status(500).json({ error: 'Failed to fetch OKRs' });
    }
});

app.post('/api/tech-team/admin/okrs', authenticateAdmin, async (req, res) => {
    try {
        const okr = await techTeamDB.createOkr(req.body);
        res.json({ success: true, okr });
    } catch (error) {
        console.error('[TechTeam] Create OKR error:', error.message);
        res.status(500).json({ error: 'Failed to create OKR' });
    }
});

app.put('/api/tech-team/admin/okrs/:id', authenticateAdmin, async (req, res) => {
    try {
        const okr = await techTeamDB.updateOkr(req.params.id, req.body);
        res.json({ success: true, okr });
    } catch (error) {
        console.error('[TechTeam] Update OKR error:', error.message);
        res.status(500).json({ error: 'Failed to update OKR' });
    }
});

app.delete('/api/tech-team/admin/okrs/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteOkr(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete OKR error:', error.message);
        res.status(500).json({ error: 'Failed to delete OKR' });
    }
});

// Meetings
app.get('/api/tech-team/admin/meetings', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.memberId) filters.memberId = req.query.memberId;
        if (req.query.meetingType) filters.meetingType = req.query.meetingType;
        if (req.query.fromDate) filters.fromDate = req.query.fromDate;
        if (req.query.toDate) filters.toDate = req.query.toDate;
        const meetings = await techTeamDB.listMeetings(filters);
        res.json({ success: true, meetings });
    } catch (error) {
        console.error('[TechTeam] List meetings error:', error.message);
        res.status(500).json({ error: 'Failed to fetch meetings' });
    }
});

app.post('/api/tech-team/admin/meetings', authenticateAdmin, async (req, res) => {
    try {
        const meeting = await techTeamDB.createMeeting(req.body);
        res.json({ success: true, meeting });
    } catch (error) {
        console.error('[TechTeam] Create meeting error:', error.message);
        res.status(500).json({ error: 'Failed to create meeting' });
    }
});

app.put('/api/tech-team/admin/meetings/:id', authenticateAdmin, async (req, res) => {
    try {
        const meeting = await techTeamDB.updateMeeting(req.params.id, req.body);
        res.json({ success: true, meeting });
    } catch (error) {
        console.error('[TechTeam] Update meeting error:', error.message);
        res.status(500).json({ error: 'Failed to update meeting' });
    }
});

app.delete('/api/tech-team/admin/meetings/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteMeeting(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete meeting error:', error.message);
        res.status(500).json({ error: 'Failed to delete meeting' });
    }
});

// Achievements
app.get('/api/tech-team/admin/achievements', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.memberId) filters.memberId = req.query.memberId;
        if (req.query.category) filters.category = req.query.category;
        const achievements = await techTeamDB.listAchievements(filters);
        res.json({ success: true, achievements });
    } catch (error) {
        console.error('[TechTeam] List achievements error:', error.message);
        res.status(500).json({ error: 'Failed to fetch achievements' });
    }
});

app.post('/api/tech-team/admin/achievements', authenticateAdmin, async (req, res) => {
    try {
        const achievement = await techTeamDB.createAchievement(req.body);
        res.json({ success: true, achievement });
    } catch (error) {
        console.error('[TechTeam] Create achievement error:', error.message);
        res.status(500).json({ error: 'Failed to create achievement' });
    }
});

app.delete('/api/tech-team/admin/achievements/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteAchievement(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete achievement error:', error.message);
        res.status(500).json({ error: 'Failed to delete achievement' });
    }
});

// Goals
app.get('/api/tech-team/admin/goals', authenticateAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.memberId) filters.memberId = req.query.memberId;
        if (req.query.category) filters.category = req.query.category;
        if (req.query.status) filters.status = req.query.status;
        const goals = await techTeamDB.listGoals(filters);
        res.json({ success: true, goals });
    } catch (error) {
        console.error('[TechTeam] List goals error:', error.message);
        res.status(500).json({ error: 'Failed to fetch goals' });
    }
});

app.post('/api/tech-team/admin/goals', authenticateAdmin, async (req, res) => {
    try {
        const goal = await techTeamDB.createGoal(req.body);
        res.json({ success: true, goal });
    } catch (error) {
        console.error('[TechTeam] Create goal error:', error.message);
        res.status(500).json({ error: 'Failed to create goal' });
    }
});

app.put('/api/tech-team/admin/goals/:id', authenticateAdmin, async (req, res) => {
    try {
        const goal = await techTeamDB.updateGoal(req.params.id, req.body);
        res.json({ success: true, goal });
    } catch (error) {
        console.error('[TechTeam] Update goal error:', error.message);
        res.status(500).json({ error: 'Failed to update goal' });
    }
});

app.delete('/api/tech-team/admin/goals/:id', authenticateAdmin, async (req, res) => {
    try {
        await techTeamDB.deleteGoal(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete goal error:', error.message);
        res.status(500).json({ error: 'Failed to delete goal' });
    }
});

// ---------- Tech Team AI Assistant ----------
app.post('/api/tech-team/admin/ai/chat', authenticateAdmin, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }
        const { chatCompletion, isConfigured, estimateTokens } = require('./config/ai/aiClient');
        if (!isConfigured()) {
            return res.json({ success: true, reply: 'AI is not configured. Set AI_API_KEY in the server environment.' });
        }
        const techTeamTools = require('./config/ai/techTeamTools');
        const SYSTEM_PROMPT = `You are the Tech Team Admin AI assistant. You help manage the engineering team by querying team data, analyzing performance, and generating professional text.

Your capabilities:
- Query team members, tasks, performance reviews, skills, OKRs
- Analyze team performance, delayed tasks, department metrics
- Generate professional review text, task descriptions, meeting agendas
- Provide insights on team velocity, on-time delivery, skill gaps

Rules:
- Use the provided tools to fetch real data. Never invent member names, task titles, or statistics.
- Keep answers concise and formatted for a chat panel: short paragraphs, dashes for lists.
- When generating text (reviews, descriptions, agendas), use the tool data to create specific, actionable content.
- If asked to generate text, first fetch the relevant data using tools, then write the text based on that data.
- Be professional, constructive, and specific in all generated content.`;
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: String(message).trim().substring(0, 4000) }
        ];
        const toolSchemas = techTeamTools.getToolSchemas();
        let reply = null;
        const MAX_ROUNDS = 4;
        for (let round = 0; round <= MAX_ROUNDS; round++) {
            const { message: msg } = await chatCompletion({ messages, tools: toolSchemas, maxTokens: 1024 });
            const toolCalls = msg.tool_calls || [];
            if (!toolCalls.length) {
                reply = msg.content || 'Done.';
                break;
            }
            if (round === MAX_ROUNDS) {
                reply = 'I hit the tool-call limit. Try asking something more specific.';
                break;
            }
            messages.push(msg);
            for (const call of toolCalls) {
                const name = call.function?.name;
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
                const tool = techTeamTools.getTool(name);
                let resultJson;
                if (!tool) {
                    resultJson = JSON.stringify({ error: `Unknown tool: ${name}` });
                } else {
                    try {
                        const result = await tool.execute(args, {});
                        resultJson = JSON.stringify(result);
                        if (resultJson.length > 8000) resultJson = resultJson.substring(0, 8000) + '... (truncated)';
                    } catch (err) {
                        resultJson = JSON.stringify({ error: err.message });
                    }
                }
                messages.push({ role: 'tool', tool_call_id: call.id, content: resultJson });
            }
        }
        // If tools returned data with a "prompt" field (text generation), generate the text
        if (reply && reply.includes('"prompt"')) {
            try {
                const { message: genMsg } = await chatCompletion({
                    messages: [
                        { role: 'system', content: 'You are a professional tech team manager. Generate the requested text based on the data provided. Be specific, constructive, and professional. Write in clear paragraphs, not bullet points.' },
                        { role: 'user', content: reply }
                    ],
                    maxTokens: 1024
                });
                if (genMsg.content) reply = genMsg.content;
            } catch {}
        }
        res.json({ success: true, reply });
    } catch (error) {
        console.error('[TechTeam] AI chat error:', error.message, error.stack);
        res.status(500).json({ success: false, error: 'AI request failed: ' + error.message });
    }
});

// ---------- Premium Team Member Routes ----------

// Member self: skills
app.get('/api/tech-team/my-skills', authenticateTeamMember, async (req, res) => {
    try {
        const skills = await techTeamDB.listSkills({ memberId: req.teamMember.memberId });
        res.json({ success: true, skills });
    } catch (error) {
        console.error('[TechTeam] My skills error:', error.message);
        res.status(500).json({ error: 'Failed to fetch skills' });
    }
});

app.post('/api/tech-team/my-skills', authenticateTeamMember, async (req, res) => {
    try {
        req.body.memberId = req.teamMember.memberId;
        const skill = await techTeamDB.createSkill(req.body);
        res.json({ success: true, skill });
    } catch (error) {
        console.error('[TechTeam] Create skill error:', error.message);
        res.status(500).json({ error: 'Failed to create skill' });
    }
});

app.put('/api/tech-team/my-skills/:id', authenticateTeamMember, async (req, res) => {
    try {
        const skill = await techTeamDB.updateSkill(req.params.id, req.body);
        res.json({ success: true, skill });
    } catch (error) {
        console.error('[TechTeam] Update skill error:', error.message);
        res.status(500).json({ error: 'Failed to update skill' });
    }
});

app.delete('/api/tech-team/my-skills/:id', authenticateTeamMember, async (req, res) => {
    try {
        await techTeamDB.deleteSkill(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete skill error:', error.message);
        res.status(500).json({ error: 'Failed to delete skill' });
    }
});

// Member self: OKRs
app.get('/api/tech-team/my-okrs', authenticateTeamMember, async (req, res) => {
    try {
        const filters = { memberId: req.teamMember.memberId };
        if (req.query.period) filters.period = req.query.period;
        if (req.query.status) filters.status = req.query.status;
        const okrs = await techTeamDB.listOkrs(filters);
        res.json({ success: true, okrs });
    } catch (error) {
        console.error('[TechTeam] My OKRs error:', error.message);
        res.status(500).json({ error: 'Failed to fetch OKRs' });
    }
});

app.post('/api/tech-team/my-okrs', authenticateTeamMember, async (req, res) => {
    try {
        req.body.memberId = req.teamMember.memberId;
        const okr = await techTeamDB.createOkr(req.body);
        res.json({ success: true, okr });
    } catch (error) {
        console.error('[TechTeam] Create OKR error:', error.message);
        res.status(500).json({ error: 'Failed to create OKR' });
    }
});

app.put('/api/tech-team/my-okrs/:id', authenticateTeamMember, async (req, res) => {
    try {
        const okr = await techTeamDB.updateOkr(req.params.id, req.body);
        res.json({ success: true, okr });
    } catch (error) {
        console.error('[TechTeam] Update OKR error:', error.message);
        res.status(500).json({ error: 'Failed to update OKR' });
    }
});

// Member self: Goals
app.get('/api/tech-team/my-goals', authenticateTeamMember, async (req, res) => {
    try {
        const filters = { memberId: req.teamMember.memberId };
        if (req.query.category) filters.category = req.query.category;
        if (req.query.status) filters.status = req.query.status;
        const goals = await techTeamDB.listGoals(filters);
        res.json({ success: true, goals });
    } catch (error) {
        console.error('[TechTeam] My goals error:', error.message);
        res.status(500).json({ error: 'Failed to fetch goals' });
    }
});

app.post('/api/tech-team/my-goals', authenticateTeamMember, async (req, res) => {
    try {
        req.body.memberId = req.teamMember.memberId;
        const goal = await techTeamDB.createGoal(req.body);
        res.json({ success: true, goal });
    } catch (error) {
        console.error('[TechTeam] Create goal error:', error.message);
        res.status(500).json({ error: 'Failed to create goal' });
    }
});

app.put('/api/tech-team/my-goals/:id', authenticateTeamMember, async (req, res) => {
    try {
        const goal = await techTeamDB.updateGoal(req.params.id, req.body);
        res.json({ success: true, goal });
    } catch (error) {
        console.error('[TechTeam] Update goal error:', error.message);
        res.status(500).json({ error: 'Failed to update goal' });
    }
});

app.delete('/api/tech-team/my-goals/:id', authenticateTeamMember, async (req, res) => {
    try {
        await techTeamDB.deleteGoal(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[TechTeam] Delete goal error:', error.message);
        res.status(500).json({ error: 'Failed to delete goal' });
    }
});

// Member self: Reviews (received)
app.get('/api/tech-team/my-reviews', authenticateTeamMember, async (req, res) => {
    try {
        const reviews = await techTeamDB.listReviews({ memberId: req.teamMember.memberId });
        res.json({ success: true, reviews });
    } catch (error) {
        console.error('[TechTeam] My reviews error:', error.message);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

// Member self: submit review (self-assessment)
app.post('/api/tech-team/my-reviews', authenticateTeamMember, async (req, res) => {
    try {
        req.body.memberId = req.teamMember.memberId;
        req.body.reviewerId = req.teamMember.memberId;
        req.body.reviewType = 'self';
        const review = await techTeamDB.createReview(req.body);
        res.json({ success: true, review });
    } catch (error) {
        console.error('[TechTeam] Submit self-review error:', error.message);
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

// Member self: Achievements
app.get('/api/tech-team/my-achievements', authenticateTeamMember, async (req, res) => {
    try {
        const achievements = await techTeamDB.listAchievements({ memberId: req.teamMember.memberId });
        res.json({ success: true, achievements });
    } catch (error) {
        console.error('[TechTeam] My achievements error:', error.message);
        res.status(500).json({ error: 'Failed to fetch achievements' });
    }
});

// Member self: Meetings
app.get('/api/tech-team/my-meetings', authenticateTeamMember, async (req, res) => {
    try {
        const meetings = await techTeamDB.listMeetings({ memberId: req.teamMember.memberId });
        res.json({ success: true, meetings });
    } catch (error) {
        console.error('[TechTeam] My meetings error:', error.message);
        res.status(500).json({ error: 'Failed to fetch meetings' });
    }
});

// Member self: update profile
app.put('/api/tech-team/me', authenticateTeamMember, async (req, res) => {
    try {
        const allowed = ['bio', 'location', 'timezone', 'avatarUrl'];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        const member = await techTeamDB.updateTeamMember(req.teamMember.memberId, updates);
        res.json({ success: true, member });
    } catch (error) {
        console.error('[TechTeam] Update profile error:', error.message);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// Member self: premium dashboard stats
app.get('/api/tech-team/my-stats', authenticateTeamMember, async (req, res) => {
    try {
        const memberId = req.teamMember.memberId;
        const [tasks, reviews, skills, okrs, goals, achievements] = await Promise.all([
            techTeamDB.getMemberTasks(memberId),
            techTeamDB.listReviews({ memberId }),
            techTeamDB.listSkills({ memberId }),
            techTeamDB.listOkrs({ memberId }),
            techTeamDB.listGoals({ memberId }),
            techTeamDB.listAchievements({ memberId })
        ]);
        const completed = tasks.filter(t => t.status === 'done').length;
        const overdue = tasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'done').length;
        const member = await techTeamDB.getTeamMember(memberId);
        res.json({ success: true, stats: {
            totalTasks: tasks.length, completed, overdue,
            avgRating: member ? member.overallRating : 0,
            reviewCount: reviews.length,
            skillCount: skills.length,
            activeOkrs: okrs.filter(o => o.status === 'active').length,
            activeGoals: goals.filter(g => g.status === 'active').length,
            achievementCount: achievements.length,
            tasks
        }});
    } catch (error) {
        console.error('[TechTeam] My stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ==================== ERROR HANDLING ====================

// ==================== ATHLETE PROGRAM (FM-OFC-03) ====================
const mountAthleteRoutes = require('./services/athlete-program/routes');
const AthleteJobs = require('./services/athlete-program/jobs');
mountAthleteRoutes(app);
console.log('🏅 Athlete Program routes mounted');

// Publish today's athlete-only mission pool immediately after a restart, then
// rotate and prebuild pools at 00:05 IST every day. Weekly challenges retain
// their existing shared-admin workflow and leaderboard.
AthleteJobs.runDaily();
cron.schedule('5 0 * * *', () => {
    AthleteJobs.runDaily();
}, {
    timezone: 'Asia/Kolkata'
});
console.log('🏋️ Athlete mission rotation scheduled daily at 00:05 IST');

// Comfort levels: time gates open overnight even without new XP, so re-evaluate
// every athlete nightly (and once shortly after boot).
cron.schedule('15 0 * * *', () => {
    AthleteJobs.evaluateAllLevels()
        .then(r => console.log(`[AthleteJobs] Level evaluation: ${r.promoted} promoted, ${r.errors} errors`))
        .catch(e => console.error('[AthleteJobs] Level evaluation failed:', e.message));
}, {
    timezone: 'Asia/Kolkata'
});
setTimeout(() => {
    AthleteJobs.evaluateAllLevels()
        .then(r => console.log(`[AthleteJobs] Startup level evaluation: ${r.promoted} promoted, ${r.errors} errors`))
        .catch(e => console.error('[AthleteJobs] Startup level evaluation failed:', e.message));
}, 120000);
console.log('🧗 Athlete comfort-level evaluation scheduled daily at 00:15 IST');

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler - Sanitized for production
app.use((err, req, res, next) => {
    // Multer upload errors (file too large, too many files, etc.) — return a clear client-facing message
    if (err.name === 'MulterError' || err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            logger.warn('Upload rejected — file size limit exceeded:', {
                url: req.originalUrl,
                message: err.message,
                ip: req.ip
            });
            return res.status(413).json({
                error: `File is too large. Please upload images under ${MAX_UPLOAD_FILE_SIZE / (1024 * 1024)}MB.`
            });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ error: 'Too many files attached. Maximum is 10 images per request.' });
        }
        return res.status(400).json({ error: 'File upload failed. Please try again.' });
    }

    logger.error('Unhandled error:', { 
        message: err.message, 
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip
    });
    
    // Don't expose error details in production
    const response = { error: 'Internal server error' };
    if (!isProduction) {
        response.details = err.message;
    }
    
    res.status(500).json(response);
});

// ==================== START SERVER ====================

const httpServer = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📦 Store: ${process.env.SHOPIFY_STORE}`);
    console.log(`🔐 Shopify Authorized: ${!!(process.env.SHOPIFY_ACCESS_TOKEN || storage.accessToken)}`);
    console.log(`📮 Shiprocket Configured: ${!!(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD)}`);
    console.log(`🚚 Delhivery Configured: ${!!process.env.DELHIVERY_API_KEY}`);
    console.log(`🔄 Delhivery Fallback: ${process.env.DELHIVERY_API_KEY ? 'Enabled' : 'Disabled'}`);

    if (!process.env.SHOPIFY_ACCESS_TOKEN && !storage.accessToken) {
        console.log(`⚠️  Not authorized yet. Visit /auth/install to complete OAuth`);
    }
});

// Live presence, lobbies and multiplayer Rooftop Race (WebSocket on /ws/race)
require('./services/athlete-program/RaceHub').attachDefault(httpServer);
