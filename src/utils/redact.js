/**
 * Central log redaction — one dependency-free implementation, kept byte-for-byte
 * identical in whatsappbot-main and exchange-return-tracking-main.
 *
 * WHY THIS EXISTS:
 * Both apps together carry roughly 9,650 console call sites, and five of them
 * pretty-printed whole carrier payloads — so customer name, phone, address and
 * pincode were reaching Render's retained log stream, alongside webhook secrets
 * and JWTs printed on error paths. Nobody keeps that out of 9,650 places by
 * hand, so values get scrubbed once, centrally, in the layer every line passes
 * through. Nothing here is wired up yet (that is the logger shim's job); this
 * file is pure and testable on its own: node test/testRedact.js
 *
 * WHAT IT SCRUBS (Phase 1 §A3):
 * 1. Secret-named keys anywhere in an object graph  →  [REDACTED len=N]
 *    Keeping the length is deliberate: it still answers "was a token present,
 *    and is it the length we expect?" without exposing it.
 * 2. Known token shapes in free text — Shopify, JWTs, Meta, Razorpay,
 *    connection-string passwords, high-entropy hex runs — because those also
 *    arrive as bare positionals, not just as object values.
 * 3. Customer PII — phone keeps the last 4, email keeps first char + domain,
 *    pincode keeps the last 3. Partial retention is what still lets a support
 *    complaint be matched to a line; full opacity trades one outage for another.
 * 4. Structure — multi-line payload dumps collapse to a single line and
 *    over-long lines are truncated, which is exactly what makes a stray
 *    JSON.stringify(payload, null, 2) harmless if one ever comes back.
 *
 * DELIBERATE LIMITS (each one is a false-positive guard, not an oversight):
 * - Bare 6-digit numbers are NOT treated as pincodes. In this domain pincode
 *   110001, ₹1100.01 and order suffix 110001 are indistinguishable, and
 *   guessing wrong deletes the number someone is mid-debugging. Pincodes are
 *   masked by KEY (pin/pincode/zip/postal), which every carrier payload shape
 *   uses, so the dump sites are still covered.
 * - The generic hex rule wants >=16 chars with at least two letters rather
 *   than a plain "8+ hex" run: 8-char pure-digit runs are order numbers and
 *   amounts here, and the order id is the field the whole support flow
 *   correlates on.
 * - A bare base64 digest printed as free text with no surrounding key is not
 *   recognised (it is indistinguishable from other base64). The HMAC-failure
 *   leak this phase fixes is closed at the call site for that reason, and the
 *   key rule covers it if it is ever logged as a field again.
 */

// ─── knobs ─────────────────────────────────────────────────────────────────

// Ceiling for a single log line. Render keeps everything, and a shipment
// payload at 60+ lines buries the one line that mattered.
const MAX_LINE_DEFAULT = 2000;

// Object graphs in these apps are shallow; anything deeper than this is a
// request context or a Shopify order tree we do not need the tail of.
const MAX_DEPTH = 6;

// Generic hex key detection: length + minimum alphabetic characters.
const HEX_KEY_MIN = 16;

function maxLine() {
    const n = parseInt(process.env.LOG_MAX_LINE, 10);
    return Number.isFinite(n) && n > 0 ? n : MAX_LINE_DEFAULT;
}

// LOG_PRETTY=true restores multi-line output for whoever is tailing locally.
function pretty() {
    return process.env.LOG_PRETTY === 'true';
}

// ─── key-driven rules (checked against object keys and "key": value text) ──

const SENSITIVE_KEY_RE = /token|secret|password|passwd|api[_-]?key|authorization|bearer|access[_-]?token|service[_-]?role|_key$|signature|digest|hmac|otp|cvv|cookie|credential/i;

// pin / pincode / zip / postal, including the prefixed carrier forms
// (pickup_pincode, billing_pincode, return_pin) but not "spine" or "pinned".
const PIN_KEY_RE = /(?:^|_)(?:pins?|pincodes?|zips?|zipcodes?|postalcodes?|postal)$/i;

// Person-name fields, matched on the lowercased key so both snake_case
// (pickup_customer_name) and camelCase (customerName) resolve. A name has no
// detectable value shape, so the key is the only handle on it — and the
// carrier payloads in §0.4 all use these keys. Deliberately does NOT match a
// bare `name`, which in these payloads is the PRODUCT name people debug with.
const PERSON_NAME_KEY_RE = /(?:customer|contact|consignee|buyer|seller|sender|receiver|pickup|billing|shipping|drop)[_-]?[a-z_-]*name/;

// Street-level address fields, incl. Delhivery's short `add` and numbered
// lines. City and state are NOT masked on purpose: they are what serviceability
// debugging needs and are not identifying next to a masked pincode.
const ADDRESS_KEY_RE = /(?:^|[_-])(?:address(?:[_-]?\d*)?|addr|add)$/i;

// Delhivery's CMU payload names the customer with a bare `name` inside the
// shipment object, while Shiprocket/Ekart use bare `name` for the PRODUCT.
// The two are only separable by context, so a bare name is treated as a
// person's only when its own object also carries a street/pin/phone field.
const BARE_PERSON_KEY_RE = /^(?:name|customer|contact|consignee|addressee)$/i;
const CONTACT_FIELD_RE = /^(?:phone|mobile|contact_no|contact_number|email)$/i;

// Phone-shaped keys. Ekart sends `phone` as a NUMBER (Number(phone)), so the
// value-shape rules in redactText() never see it — the key has to catch it.
const PHONE_KEY_RE = /(?:^|_)(?:phone|mobile|whatsapp|contact_no|contact_number)(?:[_-]?\d*)?$/i;

// A bare 10-digit Indian mobile. Used for numeric values, where the free-text
// lookaround boundaries cannot apply.
const MOBILE_SHAPE_RE = /^[6-9]\d{9}$/;

function isSensitiveKey(key) {
    return SENSITIVE_KEY_RE.test(String(key));
}

function isPinKey(key) {
    return PIN_KEY_RE.test(String(key));
}

function isPersonNameKey(key) {
    return PERSON_NAME_KEY_RE.test(String(key).toLowerCase());
}

function isAddressKey(key) {
    return ADDRESS_KEY_RE.test(String(key));
}

function isBarePersonKey(key) {
    return BARE_PERSON_KEY_RE.test(String(key));
}

function isPhoneKey(key) {
    return PHONE_KEY_RE.test(String(key));
}

// ─── value-shape rules (free text) ─────────────────────────────────────────

// postgres://user:PASS@host — replaced while KEEPING scheme, user and host so
// pool diagnostics ("which project ref is it connecting to?") stay possible.
const CONN_STRING_RE = /([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@\s/]+)@/gi;

// Ordered: most specific first, so a token is never half-matched by a looser
// rule. All of them collapse to the same [REDACTED len=N] marker.
const SECRET_SHAPE_RE = [
    // Shopify access token / app secret / client tokens
    /\b(?:shpat|shpss|shppa|shpca)_[a-f0-9]{12,}\b/gi,
    // Any JWT — Supabase anon + service role, Meta access tokens, admin tokens
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{4,})?\b/g,
    // Meta long-lived tokens that are not JWT-shaped (EAAG…/EAAC… prefixes)
    /\bEAA[A-Za-z0-9_-]{20,}\b/g,
    // Razorpay key ids and secrets
    /\brzp(?:sec)?_(?:test|live)_[A-Za-z0-9]{8,}\b/gi,
    // High-entropy hex runs (Delhivery / gateway style api keys)
    new RegExp(`\\b(?=[0-9a-f]{${HEX_KEY_MIN},})[0-9a-f]*[a-f][0-9a-f]*[a-f][0-9a-f]*\\b`, 'gi')
];

// ─── PII rules ─────────────────────────────────────────────────────────────

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z][Z][0-9A-Z]\b/g;
// +91 98765 43210 / +91-9876543210 / 919876543210
const PHONE_INTL_RE = /\+?91[\s-]?([6-9]\d{4})[\s-]?(\d{5})\b/g;
// Bare 10-digit Indian mobile, incl. the 5-5 split format. Boundaries keep it
// off the tail of longer numbers (timestamps, card-like runs).
const PHONE_BARE_RE = /(?<!\d)([6-9]\d{4})[\s-]?(\d{5})(?!\d)/g;

// "secret": "value" and secret=value in already-formatted text — this is the
// pass that covers JSON.stringify(payload) sites, where the key name is only
// ever ever present as characters in a string.
const KV_TEXT_RE = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{1,60})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}\]]+)/g;

function marker(value) {
    let len;
    try {
        len = typeof value === 'string' ? value.length : JSON.stringify(value).length;
    } catch (e) {
        len = -1;
    }
    return len >= 0 ? `[REDACTED len=${len}]` : '[REDACTED]';
}

// Keep the last 4 only. "+91 XXXXX 3210" mirrors the shape of the real number
// so it stays greppable, without carrying it.
function maskPhone(_, g1, g2) {
    return `+91 XXXXX ${(g1 + g2).slice(-4)}`;
}

function maskPin(pin) {
    const s = String(pin);
    return s.includes('*') ? s : `***${s.slice(-3)}`;
}

// Initial only: enough to tell "both lines are about the same A customer" apart
// from a mistake, not enough to identify anyone.
function maskPerson(value) {
    const s = String(value).trim();
    if (s.includes('*')) return s;
    return s ? `${s.charAt(0)}***` : s;
}

// Mask a phone held in a numeric value: Ekart's drop_location.phone and any
// JSON-parsed carrier field arrive as numbers, and `typeof value === 'number'`
// used to short-circuit them out of scrubbing entirely.
// Without key context only an EXACT 10-digit mobile is masked — 10+ digits is
// also how waybill numbers and Shopify ids look, and eating those costs more
// than it buys. Under a phone-shaped key the wider rule is safe.
function maskNumericPhone(value, keyContext = false) {
    const s = String(value);
    if (MOBILE_SHAPE_RE.test(s)) return maskPhone(null, s.slice(0, 5), s.slice(5));
    if (keyContext) {
        const digits = s.replace(/\D/g, '');
        if (digits.length >= 10 && !alreadyMasked(s)) return `+91 XXXXX ${digits.slice(-4)}`;
    }
    return value;
}

// Rebuild a key/value pair for text-mode masking. The opening quote is emitted
// twice on purpose: KV_TEXT_RE backreferences it around the key, so dropping
// the second copy silently corrupts the JSON (and breaks idempotence).
function kv(quote, key, sep, masked) {
    const q = quote || '"';
    return `${quote}${key}${quote}${sep}${q}${masked}${q}`;
}

// A value that has already been through here must not be re-masked, or
// redaction stops being idempotent and log lines drift on every hop.
function alreadyMasked(v) {
    return v.startsWith('[REDACTED') || v.includes('*') || v.includes('XXXXX');
}

/**
 * Scrub secrets and PII out of an already-formatted log line.
 * Runs shape rules before PII rules so digits inside a token are never
 * mistaken for a phone number.
 */
function redactText(input) {
    if (input === null || input === undefined) return input;
    let str = typeof input === 'string' ? input : String(input);

    // 1. Connection strings first — the password is delimited by characters
    //    the looser rules would otherwise eat.
    str = str.replace(CONN_STRING_RE, (m, prefix, user, pass) => `${prefix}${user}:${marker(pass)}@`);

    // 2. Known token shapes.
    for (const re of SECRET_SHAPE_RE) {
        str = str.replace(re, (m) => marker(m));
    }

    // 3. Key/value pairs in formatted text (JSON dumps, logfmt, error bodies).
    str = str.replace(KV_TEXT_RE, (m, quote, key, sep, value) => {
        const bare = value.replace(/^["']|["']$/g, '');
        if (isSensitiveKey(key) && !alreadyMasked(value)) return kv(quote, key, sep, marker(bare));
        if (isPinKey(key) && !alreadyMasked(value)) return kv(quote, key, sep, maskPin(bare.replace(/\D/g, '')));
        if (isPersonNameKey(key) && !alreadyMasked(value)) return kv(quote, key, sep, maskPerson(bare));
        if (isAddressKey(key) && !alreadyMasked(value)) return kv(quote, key, sep, '[REDACTED addr]');
        if (isPhoneKey(key) && !alreadyMasked(bare)) return kv(quote, key, sep, maskNumericPhone(bare, true));
        return m;
    });

    // 4. PII. GSTIN before phones: it starts with two digits and a phone
    //    boundary could otherwise clip its head.
    str = str.replace(GSTIN_RE, (m) => marker(m));
    str = str.replace(EMAIL_RE, (m, first, domain) => `${first}***@${domain}`);
    str = str.replace(PHONE_INTL_RE, maskPhone);
    str = str.replace(PHONE_BARE_RE, maskPhone);

    return str;
}

/**
 * Deep-scrub a value for logging: secret keys are replaced wholesale, strings
 * inside the graph go through redactText(). Circular refs, Buffers, Errors and
 * depth blowups all degrade to a readable marker instead of throwing — the
 * redactor must never be the thing that breaks a request.
 */
function redactDeep(value, depth = 0, seen = null) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') return redactText(value);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return maskNumericPhone(value);
    if (typeof value === 'bigint') return maskNumericPhone(String(value));
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return String(value);

    if (value instanceof Error) return redactText(value.stack || `${value.name}: ${value.message}`);
    if (Buffer.isBuffer(value)) return `[Buffer len=${value.length}]`;

    if (depth >= MAX_DEPTH) return '[TRUNCATED depth]';
    const visited = seen || new WeakSet();
    if (visited.has(value)) return '[Circular]';
    visited.add(value);

    if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1, visited));

    // Context for the bare-`name` rule: does THIS object look like a party?
    const keys = Object.keys(value);
    const looksLikeContactBlock = keys.some(k =>
        isAddressKey(k) || isPinKey(k) || CONTACT_FIELD_RE.test(k));

    const out = {};
    for (const key of keys) {
        const child = value[key];
        if (isSensitiveKey(key)) out[key] = marker(child);
        else if (isPinKey(key)) out[key] = maskPin(String(child).replace(/\D/g, ''));
        else if (isPhoneKey(key)) out[key] = maskNumericPhone(child, true);
        else if (isPersonNameKey(key) || (looksLikeContactBlock && isBarePersonKey(key))) out[key] = maskPerson(String(child));
        else if (isAddressKey(key)) out[key] = '[REDACTED addr]';
        else out[key] = redactDeep(child, depth + 1, visited);
    }
    return out;
}

/** Collapse a multi-line dump onto one line, preserving line-order meaning. */
function collapseLines(str) {
    return String(str).replace(/\s*\r?\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');
}

/** Hard cap with an explicit overflow count, so truncation is never silent. */
function capLine(str, max = maxLine()) {
    const s = String(str);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/**
 * One-call path used by the logger shim: scrub structurally, render, then
 * collapse and cap. Strings are passed through redactText() directly so
 * `console.log('📦 Payload:', JSON.stringify(payload, null, 2))` — where the
 * payload is ALREADY a string by the time it arrives — is still covered.
 */
function formatRedacted(value) {
    let str;
    if (typeof value === 'string') {
        str = redactText(value);
    } else {
        try {
            str = JSON.stringify(redactDeep(value));
        } catch (e) {
            str = redactText(String(value));
        }
    }
    if (!pretty()) str = collapseLines(str);
    return capLine(str);
}

module.exports = {
    redactText,
    redactDeep,
    formatRedacted,
    collapseLines,
    capLine,
    isSensitiveKey,
    isPinKey,
    isPersonNameKey,
    isAddressKey,
    isBarePersonKey,
    isPhoneKey,
    maskPin,
    maskPerson,
    maskNumericPhone,
    marker,
    MAX_LINE_DEFAULT,
    MAX_DEPTH,
    HEX_KEY_MIN
};
