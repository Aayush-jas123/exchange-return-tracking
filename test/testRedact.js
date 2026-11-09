/**
 * Standalone test for the central log redactor (Phase 1 §C1).
 * Run: node test/testRedact.js
 *
 * No framework, no database, no network — src/utils/redact.js is dependency-free
 * on purpose so this can run in CI and on a bare checkout.
 *
 * Every fixture below is shaped after a real call site: the Shiprocket return /
 * forward payloads, the Delhivery CMU payload, the Ekart Swift create payload and
 * the Supabase pool connection string. That matters — a redactor written against
 * invented key names passes here and leaks in production.
 */

const assert = require('assert');
const crypto = require('crypto');
const {
    redactText,
    redactDeep,
    formatRedacted,
    collapseLines,
    capLine
} = require('../src/utils/redact');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

// Assert none of `needles` survive `haystack`, with the offending fragment
// printed — a leak assertion that only says "false" wastes debugging time.
function assertAbsent(haystack, needles, label) {
    for (const needle of needles) {
        if (needle === undefined || needle === null || needle === '') continue;
        assert.ok(
            !String(haystack).includes(String(needle)),
            `${label || 'output'} still contains ${JSON.stringify(String(needle).slice(0, 40))}`
        );
    }
}

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// ─── fixtures ──────────────────────────────────────────────────────────────

// server.js createShiprocketReturnPayload()
const shiprocketReturn = {
    order_id: 'REQ-26030',
    order_date: '2026-11-09 10:00:00',
    channel_id: '',
    pickup_customer_name: 'Aarav Sharma',
    pickup_last_name: 'Sharma',
    pickup_address: '42 MG Road, Indiranagar',
    pickup_city: 'Bengaluru',
    pickup_state: 'Karnataka',
    pickup_country: 'IN',
    pickup_pincode: '560038',
    pickup_email: 'aarav.sharma@example.com',
    pickup_phone: '9812345678',
    shipping_customer_name: 'Offcomfrt Warehouse',
    shipping_address: 'Plot 7, Industrial Area',
    shipping_pincode: '123028',
    shipping_phone: '9138514222',
    order_items: [{ name: 'HENLEY - L', sku: 'OC-1142', units: 1, selling_price: 1999 }],
    payment_method: 'Prepaid',
    sub_total: 1999,
    weight: 0.5
};
const RETURN_PII = ['Aarav', 'Sharma', '42 MG Road', 'Indiranagar', '9812345678',
    'aarav.sharma@example.com', '560038', '9138514222', 'Plot 7'];

// server.js createShiprocketForwardOrder()
const shiprocketForward = {
    order_id: 'REQ-67796-FWD-R1',
    order_date: '2026-11-09',
    pickup_location: 'Primary',
    billing_customer_name: 'Diya Patel',
    billing_address: '12 FC Road, Near Ace Company',
    billing_city: 'Pune',
    billing_pincode: '411004',
    billing_state: 'Maharashtra',
    billing_country: 'India',
    billing_email: 'diya.patel@example.com',
    billing_phone: '+91 98222 11111',
    shipping_is_billing: true,
    order_items: [{ name: 'CARGO - M', sku: 'OC-2210', units: 1, selling_price: 2499 }],
    sub_total: 2499
};
const FORWARD_PII = ['Diya', 'Patel', '12 FC Road', '98222 11111', '9822211111',
    'diya.patel@example.com', '411004'];

// server.js Delhivery CMU create (reverse + forward share the shape)
const delhiveryPayload = {
    shipments: [{
        name: 'Vikram Rao',
        add: 'H.No 3-4-45, Taranaka',
        pin: '520002',
        city: 'Hyderabad',
        state: 'Telangana',
        country: 'India',
        phone: '9988776655',
        payment_mode: 'Pickup',
        order: 'REQ-41477-R1',
        total_amount: 3198,
        quantity: 2,
        products_desc: 'HENLEY - L, CARGO - M',
        hsn_code: '9965',
        return_pin: '123028',
        return_add: 'Primary Warehouse',
        seller_gst_tin: '06AAKFO0351L1Z7',
        products: [{ name: 'HENLEY - L', sku: 'OC-1142', weight: 500 }]
    }],
    pickup_location: { name: 'Primary', add: 'Warehouse 123028', pin: '123028', phone: '9138514222' }
};
const DELHIVERY_PII = ['Vikram', 'Rao', 'Taranaka', '520002', '9988776655', '06AAKFO0351L1Z7'];

// server.js ekartBuildShipmentPayload() — drop_location is the customer block
const ekartPayload = {
    order_number: '8421553279412',
    invoice_number: '8421553279412',
    total_amount: 1999,
    quantity: 1,
    weight: 500,
    products_desc: 'HENLEY - L',
    drop_location: {
        name: 'Meera Iyer',
        address: 'Flat 902, Sunrise Residency, Andheri East',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        phone: 9820012345,
        pin: 400069
    },
    pickup_location: { name: 'Warehouse' },
    return_location: { name: 'Warehouse' }
};
const EKART_PII = ['Meera', 'Iyer', 'Sunrise Residency', 'Andheri', '9820012345', '400069'];

const SUPABASE_JWT_ANON = [
    b64u({ alg: 'HS256', typ: 'JWT' }),
    b64u({ iss: 'supabase', role: 'anon', exp: 2000000000 }),
    'dHJ1ZS1zaWduYXR1cmUtdmFsdWU'
].join('.');
const SUPABASE_JWT_SERVICE = [
    b64u({ alg: 'HS256', typ: 'JWT' }),
    b64u({ iss: 'supabase', role: 'service_role', exp: 2000000000 }),
    'c2VydmljZS1zaWduYXR1cmU'
].join('.');
const SHOPIFY_TOKEN = `shpat_${'a'.repeat(8)}b2c3d4e5f60718293a4b5c6d7e8f9012`.slice(0, 38);
const SHOPIFY_SECRET = `shpss_${'0123456789abcdef0123456789abcdef'}`;
const META_TOKEN = `EAAG${'Zm9vYmFyYmF6cXV1eA'.repeat(2)}`;
const RAZORPAY_KEY_ID = 'rzp_test_1DP5mmOlF5G5ag';
const DELHIVERY_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CONN_STRING = 'postgresql://postgres.abcd1234def:Str0ng!Passw0rd@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';

// ─── C1.1 carrier payload shapes ───────────────────────────────────────────

check('Shiprocket return payload: no customer PII survives (object path)', () => {
    const out = formatRedacted(shiprocketReturn);
    assertAbsent(out, RETURN_PII, 'return payload');
});

check('Shiprocket return payload: no customer PII survives (pretty-printed dump)', () => {
    // The exact §0.4 form: JSON.stringify(payload, null, 2) already turned the
    // object into a string before the logger ever sees it.
    const out = formatRedacted('🚀 Creating Shiprocket Return. Payload: ' + JSON.stringify(shiprocketReturn, null, 2));
    assertAbsent(out, RETURN_PII, 'return dump');
    assert.strictEqual(out.includes('\n'), false, 'dump was not collapsed to one line');
});

check('Shiprocket forward payload: no customer PII survives', () => {
    const out = formatRedacted(shiprocketForward);
    assertAbsent(out, FORWARD_PII, 'forward payload');
});

check('Delhivery CMU payload: no name/address/pin/phone/GSTIN survives', () => {
    const out = formatRedacted(delhiveryPayload);
    assertAbsent(out, DELHIVERY_PII, 'delhivery payload');
    assertAbsent(out, ['9138514222'], 'delhivery pickup_location phone');
});

check('Ekart Swift payload: drop_location customer block is scrubbed', () => {
    const out = formatRedacted(ekartPayload);
    assertAbsent(out, EKART_PII, 'ekart payload');
});

check('Debuggable fields survive every payload (false-positive guard)', () => {
    for (const [label, out] of [
        ['shiprocket', formatRedacted(shiprocketReturn)],
        ['forward', formatRedacted(shiprocketForward)],
        ['delhivery', formatRedacted(delhiveryPayload)],
        ['ekart', formatRedacted(ekartPayload)]
    ]) {
        // Order ids, amounts, product names, cities and statuses are what
        // anyone actually used these dumps for.
        assert.ok(/REQ-26030|REQ-67796-FWD-R1|REQ-41477-R1|8421553279412/.test(out), `${label}: order id lost`);
        assert.ok(/1999|2499|3198/.test(out), `${label}: amount lost`);
        assert.ok(/HENLEY|CARGO/.test(out), `${label}: product name lost`);
    }
    const del = formatRedacted(delhiveryPayload);
    assert.ok(del.includes('Hyderabad') && del.includes('Telangana'), 'city/state lost — serviceability debugging needs them');
    assert.ok(formatRedacted(shiprocketReturn).includes('Bengaluru'), 'city lost');
});

check('Pincode keeps last 3 only, matching the WP1 summary lines', () => {
    const out = formatRedacted(shiprocketReturn);
    assert.ok(out.includes('***038'), `expected ***038 in ${out}`);
    assertAbsent(out, ['560038']);
});

check('Phone keeps last 4 in +91 XXXXX nnnn form', () => {
    const out = formatRedacted(shiprocketReturn);
    assert.ok(out.includes('+91 XXXXX 5678'), `expected masked phone in ${out}`);
});

check('Email keeps first char and domain', () => {
    const out = formatRedacted(shiprocketReturn);
    assert.ok(out.includes('a***@example.com'), `expected masked email in ${out}`);
});

// ─── C1.2 secrets ──────────────────────────────────────────────────────────

check('Connection string: password gone, host and port retained for pool diagnostics', () => {
    const out = redactText(`pool init ${CONN_STRING}`);
    assertAbsent(out, ['Str0ng!Passw0rd'], 'connection string');
    assert.ok(out.includes('aws-0-ap-south-1.pooler.supabase.com:6543'), `host lost: ${out}`);
    assert.ok(out.includes('postgresql://postgres.abcd1234def:'), `scheme/user lost: ${out}`);
});

check('Supabase anon + service_role JWTs are absent', () => {
    const out = redactText(`headers={"authorization":"Bearer ${SUPABASE_JWT_ANON}","apikey":"${SUPABASE_JWT_SERVICE}"}`);
    assertAbsent(out, [SUPABASE_JWT_ANON, SUPABASE_JWT_SERVICE], 'jwt');
    assert.ok(out.includes('[REDACTED'), 'nothing was redacted at all');
});

check('Shopify / Meta / Razorpay token shapes are absent', () => {
    const out = redactText([
        `x-shopify-access-token: ${SHOPIFY_TOKEN}`,
        `client_secret=${SHOPIFY_SECRET}`,
        `meta token ${META_TOKEN}`,
        `razorpay key ${RAZORPAY_KEY_ID}`
    ].join(' | '));
    assertAbsent(out, [SHOPIFY_TOKEN, SHOPIFY_SECRET, META_TOKEN, RAZORPAY_KEY_ID], 'token shapes');
});

check('High-entropy hex run (Delhivery-style key) is redacted, order numbers are not', () => {
    const leaked = redactText(`auth key is ${DELHIVERY_KEY}`);
    assertAbsent(leaked, [DELHIVERY_KEY], 'hex key');
    // 8+ pure digits must survive — they are order ids in this domain.
    const kept = redactText('shopify order 5238670270484 amount 819900');
    assert.ok(kept.includes('5238670270484') && kept.includes('819900'), `digits lost: ${kept}`);
});

check('Secret-named keys are replaced at any depth in the graph', () => {
    const out = formatRedacted({
        body: { nested: { password: 'hunter2', api_key: DELHIVERY_KEY } },
        config: [{ service_role: SUPABASE_JWT_SERVICE }]
    });
    assertAbsent(out, ['hunter2', DELHIVERY_KEY, SUPABASE_JWT_SERVICE], 'nested secrets');
    assert.ok(out.includes('len=7'), `length marker missing: ${out}`);
});

check('HMAC-failure fields leak nothing reconstructable (old box-block contents)', () => {
    const secret = 'shw_0123456789abcdef0123456789abcd';
    const body = Buffer.from('{"id":1}');
    const digest = crypto.createHmac('sha256', secret).update(body).digest('base64');
    const received = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('base64');
    const out = formatRedacted({
        computed_digest: digest,
        received_hmac_header: received,
        secret_prefix_used: secret.substring(0, 8),
        webhook_secret: secret
    });
    assertAbsent(out, [digest, received, secret.substring(0, 8), secret], 'hmac block');
});

// ─── C1.3 structure ────────────────────────────────────────────────────────

check('Long lines are capped with an explicit overflow marker', () => {
    const long = 'x'.repeat(2500);
    const out = capLine(long);
    assert.ok(out.length < long.length, 'not truncated');
    assert.ok(out.includes('…(+500 chars)'), `overflow marker wrong: ${out.slice(-30)}`);
});

check('LOG_MAX_LINE overrides the default cap', () => {
    process.env.LOG_MAX_LINE = '40';
    const out = capLine('y'.repeat(200));
    assert.ok(out.startsWith('y'.repeat(40)), `cap not honoured: ${out}`);
    delete process.env.LOG_MAX_LINE;
});

check('Multi-line dumps collapse to a single line', () => {
    const out = formatRedacted('line one\n   line two\n\tline three');
    assert.strictEqual(out.includes('\n'), false, `newline survived: ${out}`);
    assert.ok(out.includes('line one line two line three'), out);
});

check('LOG_PRETTY=true restores multi-line output', () => {
    process.env.LOG_PRETTY = 'true';
    const out = formatRedacted('line one\nline two');
    assert.ok(out.includes('\n'), 'newline was collapsed despite LOG_PRETTY');
    delete process.env.LOG_PRETTY;
});

check('collapseLines works standalone', () => {
    assert.strictEqual(collapseLines('a\r\n  b   c'), 'a b c');
});

// ─── A8 grep-pattern safety (the format must not break existing habits) ─────

check('Existing grep patterns and emoji markers pass through untouched', () => {
    const samples = [
        '[MEMORY] heapUsed=118.4MB heapTotal=142.0MB rss=268.3MB external=41.2MB arrayBuffers=8.7MB limit=512MB',
        '🐢 SLOW QUERY 1523ms SELECT id FROM exchange_return_requests WHERE status = $1',
        '✅ Webhook verified for order 8421553279412',
        '⚠️ Unhandled promise rejection: relation "support_tickets" does not exist',
        '🔥 Uncaught exception (recovered): TypeError: Cannot read properties of undefined',
        '📦 Shiprocket response status: success',
        '🚀 Server running on port 3000'
    ];
    for (const s of samples) {
        assert.strictEqual(formatRedacted(s), s, `changed: ${s}`);
    }
});

// ─── robustness (the redactor must never be what breaks a request) ─────────

check('Idempotent: redacting twice changes nothing', () => {
    for (const fixture of [shiprocketReturn, shiprocketForward, delhiveryPayload, ekartPayload]) {
        const once = formatRedacted(fixture);
        const twice = formatRedacted(once);
        assert.strictEqual(twice.replace(/\[REDACTED len=\d+\]/g, '[R]'), once.replace(/\[REDACTED len=\d+\]/g, '[R]'),
            `drifted on second pass: ${twice}`);
    }
});

check('Circular refs, depth, Buffers, Errors and null never throw', () => {
    const circular = { name: 'loop', child: {} };
    circular.child.parent = circular;
    assert.ok(formatRedacted(circular).includes('[Circular]') || formatRedacted(circular).includes('TRUNCATED'));

    const deep = {};
    let cursor = deep;
    for (let i = 0; i < 12; i++) { cursor.child = { i }; cursor = cursor.child; }
    assert.ok(formatRedacted(deep).includes('[TRUNCATED depth]'));

    assert.ok(formatRedacted({ body: Buffer.from('9812345678') }).includes('[Buffer len=10]'));
    assert.ok(formatRedacted({ e: new Error('boom 9812345678') }).includes('boom'));
    assert.strictEqual(formatRedacted(null), 'null');
    assert.strictEqual(redactText(undefined), undefined);
    assert.strictEqual(formatRedacted(42), '42');
    assert.strictEqual(formatRedacted({ fn: () => {} }).includes('[Function'), true);
});

check('Arrays of payloads (bulk ship) are scrubbed element-wise', () => {
    const out = formatRedacted([shiprocketReturn, shiprocketForward]);
    assertAbsent(out, RETURN_PII.concat(FORWARD_PII), 'bulk payload');
});

check('redactDeep leaves a plain non-PII object alone', () => {
    const input = { status: 'open', count: 3, waybill: '123456789012', note: 'RTO flagged' };
    assert.deepStrictEqual(redactDeep(input), input);
});

check('Numeric carrier ids survive; numeric phones under a phone key do not', () => {
    // Waybill / shipment / variant ids are long numbers and are the primary
    // lookup key for a carrier complaint.
    const kept = formatRedacted({ shipment_id: 4477123, waybill_number: 65123409877, variant_id: 41822993012345 });
    assert.ok(kept.includes('65123409877') && kept.includes('41822993012345'), `carrier ids lost: ${kept}`);

    const masked = formatRedacted({ phone: 9820012345, mobile: '08012345678' });
    assertAbsent(masked, ['9820012345', '08012345678'], 'numeric phone');
    assert.ok(masked.includes('+91 XXXXX 2345'), `no last-4 retained: ${masked}`);
});

check('Text-mode masking keeps the JSON well-formed (quote handling)', () => {
    const dumped = formatRedacted(JSON.stringify({ pickup_address: '42 MG Road', pickup_phone: '9812345678' }));
    assert.doesNotThrow(() => JSON.parse(dumped), `corrupted JSON: ${dumped}`);
    assertAbsent(dumped, ['42 MG Road', '9812345678']);
});

// ─── summary ───────────────────────────────────────────────────────────────

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
