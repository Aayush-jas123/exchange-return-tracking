/**
 * Standalone test for the console interception shim (Phase 1 §C2).
 * Run: node test/testLogger.js
 *
 * No database, no network, no server boot — it exercises src/utils/logger.js
 * against a winston Stream transport writing into an in-memory Writable, so
 * every assertion is made on the exact bytes the app would put on stdout.
 *
 * WHY THESE PARTICULAR CHECKS: the shim replaces five global functions that
 * ~9,650 existing call sites depend on. The risk is not that logging stops
 * working, it is that logging changes shape in a way that breaks how people
 * already read it — a stack that loses its frames, an emoji grep that stops
 * matching, a PostgREST rejection that degrades to "#<Object>", or a formatter
 * bug that throws inside a request. Each check below is one of those failure
 * modes, and the fixtures are copied from real call sites in server.js.
 *
 * Test reporting uses process.stdout.write directly, never console.*, so the
 * shim under test can never intercept or pollute its own assertions.
 */

const assert = require('assert');
const { Writable } = require('stream');
const winston = require('winston');
const {
    createAppLogger,
    installConsoleShim,
    uninstallConsoleShim,
    getShimStatus,
    renderLine,
    resolveLevel,
    CONSOLE_LEVELS
} = require('../src/utils/logger');

// Captured before anything is patched, so "left alone" can be asserted by
// identity rather than by behaviour.
const pristine = {};
for (const fn of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'trace', 'time']) {
    pristine[fn] = console[fn];
}

const say = (line) => process.stdout.write(`${line}\n`);

let passed = 0;
let failed = 0;

// Checks are queued and awaited in order: several of them install and remove a
// global console patch, so running them concurrently would let one suite's shim
// leak into another's assertions.
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

const ENV_KEYS = [ 'LOG_LEVEL', 'LOG_QUIET', 'LOG_RAW', 'LOG_PRETTY', 'LOG_MAX_LINE' ];

function snapshotEnv() {
    const saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    return saved;
}

function restoreEnv(saved) {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
}

function setEnv(vars) {
    for (const [ key, value ] of Object.entries(vars || {})) {
        if (value === undefined || value === null) delete process.env[key];
        else process.env[key] = String(value);
    }
}

function makeCapture() {
    const lines = [];
    const stream = new Writable({
        write(chunk, encoding, cb) {
            lines.push(chunk.toString());
            cb();
        }
    });
    return {
        stream,
        lines,
        // winston appends os.EOL per entry (\r\n on Windows, \n on Render), so
        // strip the whole terminator before comparing bytes.
        all: () => lines.map(l => l.replace(/[\r\n]+$/, '')),
        last: () => (lines.length ? lines[lines.length - 1].replace(/[\r\n]+$/, '') : ''),
        text: () => lines.map(l => l.replace(/\r\n/g, '\n')).join('')
    };
}

// Swap the real Console transport for the in-memory one. Everything above the
// transport (level, timestamp format, printf, the shim) is the production code.
function attachCapture(logger) {
    const cap = makeCapture();
    for (const transport of logger.transports.slice()) logger.remove(transport);
    logger.add(new winston.transports.Stream({ stream: cap.stream }));
    return cap;
}

// winston writes to a stream asynchronously; two ticks is enough for an
// in-memory Writable, four leaves headroom on a slow disk.
async function flush() {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}

async function withLogger(opts, fn) {
    const before = snapshotEnv();
    setEnv(opts.env);
    const logger = createAppLogger({ level: opts.level || 'warn' });
    const cap = attachCapture(logger);
    try {
        await fn({ logger, cap });
    } finally {
        restoreEnv(before);
    }
}

async function withShim(opts, fn) {
    const before = snapshotEnv();
    uninstallConsoleShim();
    setEnv(opts.env);
    const logger = createAppLogger({ level: opts.level || 'warn' });
    const cap = attachCapture(logger);
    const status = installConsoleShim(logger);
    try {
        await fn({ logger, cap, status });
    } finally {
        uninstallConsoleShim();
        restoreEnv(before);
    }
}

// "12:34:56.789 | INFO | hello" → { level: 'INFO', body: 'hello' }
function parse(line) {
    const m = /^(\S+) \| (\w+) \| ([\s\S]*)$/.exec(line);
    return m ? { timestamp: m[1], level: m[2], body: m[3] } : { timestamp: null, level: null, body: line };
}

// Write a stub over a stream method, run fn, put the original back.
async function captureStreamWrite(stream, fn) {
    const original = stream.write;
    const written = [];
    stream.write = function (chunk) { written.push(String(chunk)); return true; };
    try {
        await fn(written);
    } finally {
        stream.write = original;
    }
}

// ─── renderLine: the shape of one log entry ────────────────────────────────

check('renderLine emits "timestamp | LEVEL | message" and nothing else', () => {
    const line = renderLine({ timestamp: 'T', level: 'warn', message: 'Rate limit exceeded for 1.2.3.4' });
    assert.strictEqual(line, 'T | WARN | Rate limit exceeded for 1.2.3.4');
});

check('a timestamp-less info object still renders a single readable line', () => {
    const line = renderLine({ level: 'info', message: 'no ts' });
    assert.strictEqual(line, '- | INFO | no ts');
    assert.ok(!line.includes('undefined'), 'literal "undefined" leaked into the line');
    assert.ok(!line.includes('\n'));
});

check('meta from direct logger calls appends as key=value on the same line', () => {
    const line = renderLine({
        timestamp: 'T', level: 'info', message: 'webhook', path: '/cart', attempt: 2
    });
    assert.strictEqual(line, 'T | INFO | webhook path="/cart" attempt=2');
});

check('string meta is quoted so field greps keep working', () => {
    const line = renderLine({ timestamp: 'T', level: 'info', message: 'm', ip: '1.2.3.4' });
    assert.ok(line.includes('ip="1.2.3.4"'), line);
});

check('Error meta renders its stack, not "[object Error]"', () => {
    const err = new Error('kaboom-frame-check');
    const line = renderLine({ timestamp: 'T', level: 'error', message: 'm', err });
    assert.ok(line.includes('kaboom-frame-check'), line);
    assert.ok(line.includes('at '), 'stack frames lost');
});

check('object meta is redacted before it reaches the line', () => {
    const line = renderLine({
        timestamp: 'T', level: 'info', message: 'm', payload: { pickup_phone: '9812345678', order_id: 'REQ-26030' }
    });
    assert.ok(!line.includes('9812345678'), `phone survived in meta: ${line}`);
    assert.ok(line.includes('REQ-26030'), `order id lost: ${line}`);
});

check('multi-line messages collapse to one line by default', () => {
    const line = renderLine({ timestamp: 'T', level: 'info', message: 'a\nb\nc' });
    assert.ok(!line.includes('\n'), 'newline survived');
    assert.strictEqual(parse(line).body, 'a b c');
});

check('LOG_PRETTY=true keeps the newlines for local reading', async () => {
    const before = snapshotEnv();
    setEnv({ LOG_PRETTY: 'true' });
    try {
        const line = renderLine({ timestamp: 'T', level: 'info', message: 'a\nb' });
        assert.ok(line.includes('\n'), 'newlines collapsed anyway');
    } finally {
        restoreEnv(before);
    }
});

check('LOG_MAX_LINE caps an oversized line and says how much it cut', () => {
    const before = snapshotEnv();
    setEnv({ LOG_MAX_LINE: '120' });
    try {
        const line = renderLine({ timestamp: 'T', level: 'info', message: 'x'.repeat(500) });
        assert.ok(line.length < 200, `not capped: ${line.length}`);
        assert.ok(/\u2026\(\+\d+ chars\)$/.test(line), `no overflow marker: ${line.slice(-40)}`);
    } finally {
        restoreEnv(before);
    }
});

check('resolveLevel honours LOG_LEVEL and ignores nonsense', () => {
    const before = snapshotEnv();
    try {
        setEnv({ LOG_LEVEL: 'debug' });
        assert.strictEqual(resolveLevel('warn'), 'debug');
        setEnv({ LOG_LEVEL: 'SCREAMING' });
        assert.strictEqual(resolveLevel('warn'), 'warn');
        delete process.env.LOG_LEVEL;
        assert.strictEqual(resolveLevel('info'), 'info');
    } finally {
        restoreEnv(before);
    }
});

// ─── the shim: what the existing 9,650 call sites now produce ───────────────

async function shimmed(env, fn) {
    await withShim({ env, level: 'debug' }, async (ctx) => { await fn(ctx); });
}

check('console.log text is byte-identical to what console would print', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('✅ ' + 'Webhook verified %s %d', 'abc123', 42);
        await flush();
        const entry = parse(cap.last());
        assert.strictEqual(entry.level, 'INFO');
        assert.strictEqual(entry.body, '✅ Webhook verified abc123 42');
    });
});

check('each console method maps to its own level', async () => {
    await shimmed({}, async ({ cap }) => {
        console.debug('d'); console.info('i'); console.warn('w'); console.error('e'); console.log('l');
        await flush();
        const levels = cap.all().map(l => parse(l).level);
        assert.deepStrictEqual(levels, [ 'DEBUG', 'INFO', 'WARN', 'ERROR', 'INFO' ]);
    });
});

check('emoji scanning aids survive: ✅ ⚠️ 🔥 📦 🚀', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('⚠️  Webhook HMAC mismatch for order');
        console.log('🔥 Sending OTP to user');
        console.log('📦 Payload: {"order_id":"X"}');
        console.log('🚀 Creating Shiprocket shipment');
        await flush();
        for (const emoji of [ '⚠️', '🔥', '📦', '🚀' ]) {
            assert.ok(cap.text().includes(emoji), `${emoji} lost`);
        }
    });
});

check('[MEMORY] and SLOW QUERY greps still match verbatim', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('[MEMORY] rss=182MB heap=64MB external=12MB');
        console.warn('SLOW QUERY 1423ms: SELECT * FROM shipments');
        await flush();
        assert.ok(cap.text().includes('[MEMORY] rss=182MB heap=64MB external=12MB'), cap.text());
        assert.ok(cap.text().includes('SLOW QUERY 1423ms'), 'SLOW QUERY prefix broken');
    });
});

check('Error arguments keep their stack frames (collapsed, never #<Object>)', async () => {
    await shimmed({}, async ({ cap }) => {
        const err = new Error('delivery-status-write-failed');
        console.error('❌ Uncaught exception:', err);
        await flush();
        const body = parse(cap.last()).body;
        assert.ok(body.includes('Error: delivery-status-write-failed'), body);
        assert.ok(body.includes('at '), 'stack frames dropped');
        assert.ok(!body.includes('[object Error]'), 'degraded to [object Error]');
    });
});

check('PostgREST rejection objects print real fields', async () => {
    await shimmed({}, async ({ cap }) => {
        // Shape taken from the describeFatal() workaround in server.js — the
        // reason that helper exists is that rejections logged as objects lose
        // their detail. util.format must not.
        console.error('❌ Database update failed:', {
            message: 'relation "public.exchange_requests" does not exist',
            code: '42P01',
            details: null,
            hint: null,
            statusCode: '404'
        });
        await flush();
        const body = parse(cap.last()).body;
        assert.ok(body.includes('42P01'), `code lost: ${body}`);
        assert.ok(body.includes('relation "public.exchange_requests" does not exist'), `message lost: ${body}`);
        assert.ok(!body.includes('#<Object>'), 'degraded to #<Object>');
    });
});

check('%j, %s, %d and %o format specifiers behave like console', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('a=%j b=%s c=%d', { k: 1 }, 'x', 7);
        await flush();
        assert.strictEqual(parse(cap.last()).body, 'a={"k":1} b=x c=7');
    });
});

check('Buffers print as hex, the same as before the shim', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('sig:', Buffer.from('abc'));
        await flush();
        assert.ok(parse(cap.last()).body.includes('<Buffer 61 62 63>'), cap.last());
    });
});

check('one console call produces exactly one output line (no recursion)', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('single');
        await flush();
        assert.strictEqual(cap.lines.length, 1, `emitted ${cap.lines.length} lines: ${cap.text()}`);
        assert.ok(!cap.last().includes('\n\n'), 'duplicate entry');
    });
});

check('installing twice is a no-op, not a stacked shim', async () => {
    await shimmed({}, async ({ logger, cap }) => {
        const again = installConsoleShim(logger);
        assert.strictEqual(again.installed, true);
        console.log('still one');
        await flush();
        assert.strictEqual(cap.lines.length, 1, `stacked: ${cap.lines.length} lines`);
    });
});

check('phone numbers and tokens are redacted on the way through the shim', async () => {
    await shimmed({}, async ({ cap }) => {
        console.log('📦 Payload: ' + JSON.stringify({
            pickup_phone: '9812345678',
            pickup_pincode: '560038',
            access_token: 'shpat_1a2b3c4d5e6f7g8h9i0j',
            order_id: 'REQ-26030'
        }));
        await flush();
        const body = parse(cap.last()).body;
        assert.ok(!body.includes('9812345678'), `phone leaked: ${body}`);
        assert.ok(!body.includes('560038') || body.includes('***038'), `pincode not masked: ${body}`);
        assert.ok(!body.includes('shpat_'), `token leaked: ${body}`);
        assert.ok(body.includes('REQ-26030'), `order id lost: ${body}`);
    });
});

check('LOG_QUIET suppresses matching info/debug lines only', async () => {
    await shimmed({ LOG_QUIET: '✅ Webhook verified,🔥' }, async ({ cap, status }) => {
        console.log('✅ Webhook verified abc');
        console.debug('🔥 hot path noise');
        console.warn('🔥 but this is a warning');
        console.error('✅ and this is an error');
        await flush();
        const text = cap.text();
        assert.ok(!text.includes('Webhook verified'), 'quiet prefix not suppressed');
        assert.ok(!text.includes('hot path noise'), 'debug emoji prefix not suppressed');
        assert.ok(text.includes('but this is a warning'), 'warn was suppressed — must never be');
        assert.ok(text.includes('and this is an error'), 'error was suppressed — must never be');
        assert.deepStrictEqual(status.quiet, [ '✅ Webhook verified', '🔥' ]);
    });
});

check('level gating: default warn drops info, LOG_LEVEL=debug admits it', async () => {
    await withShim({ level: 'warn' }, async ({ cap, status }) => {
        assert.strictEqual(status.level, 'warn');
        console.info('dropped-by-level');
        console.warn('kept-by-level');
        await flush();
        assert.ok(!cap.text().includes('dropped-by-level'), 'info leaked at warn level');
        assert.ok(cap.text().includes('kept-by-level'), 'warn missing at warn level');
    });
    await withShim({ env: { LOG_LEVEL: 'debug' }, level: 'warn' }, async ({ cap, status }) => {
        assert.strictEqual(status.level, 'debug', 'LOG_LEVEL did not override the code default');
        console.debug('now-visible');
        await flush();
        assert.ok(cap.text().includes('now-visible'), 'debug still dropped');
    });
});

check('LOG_RAW=true leaves the console completely alone', async () => {
    await withShim({ env: { LOG_RAW: 'true' }, level: 'debug' }, async ({ cap, status }) => {
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.raw, true);
        assert.strictEqual(console.log, pristine.log, 'console.log was patched despite LOG_RAW');
        assert.strictEqual(typeof console.__loggerShim, 'undefined');
        assert.strictEqual(cap.lines.length, 0);
    });
});

check('console.dir / table / trace / time are never patched', async () => {
    await shimmed({}, async () => {
        assert.strictEqual(console.dir, pristine.dir);
        assert.strictEqual(console.table, pristine.table);
        assert.strictEqual(console.trace, pristine.trace);
        assert.strictEqual(console.time, pristine.time);
    });
});

check('a throwing logger cannot crash the request: falls back to raw write', async () => {
    await shimmed({}, async ({ logger, cap }) => {
        logger.log = () => { throw new Error('formatter blew up'); };
        await captureStreamWrite(process.stdout, async (written) => {
            await captureStreamWrite(process.stderr, async () => {
                assert.doesNotThrow(() => console.log('🔥 must still reach the log'));
            });
            assert.ok(written.join('').includes('🔥 must still reach the log'), 'raw fallback did not fire');
            await flush();
            assert.strictEqual(cap.lines.length, 0, 'winston wrote anyway — doubled output');
        });
    });
});

check('the fallback tells you the shim failed instead of failing silently', async () => {
    await shimmed({}, async ({ logger }) => {
        logger.log = () => { throw new Error('boom'); };
        await captureStreamWrite(process.stdout, async () => {
            await captureStreamWrite(process.stderr, async (errWritten) => {
                console.error('x');
                const notice = errWritten.join('');
                assert.ok(notice.includes('[logger] interception failed'), notice.slice(0, 120));
                assert.ok(notice.includes('boom'), 'cause not reported');
            });
        });
    });
});

check('uninstall restores the native console and stops the capture', async () => {
    await shimmed({}, async ({ logger, cap }) => {
        const patched = console.log;
        console.log('via shim');
        await flush();
        assert.strictEqual(cap.lines.length, 1);

        assert.strictEqual(uninstallConsoleShim(), true);
        assert.notStrictEqual(console.log, patched, 'console.log still the patched one');
        assert.strictEqual(typeof console.__loggerShim, 'undefined');
        assert.strictEqual(getShimStatus().installed, false);

        await captureStreamWrite(process.stdout, async (written) => {
            console.log('via native');
            assert.ok(written.join('').includes('via native'), 'native console no longer writes to stdout');
        });
        await flush();
        assert.strictEqual(cap.lines.length, 1, 'logger still receiving after uninstall');
        assert.strictEqual(logger.transports.length, 1);
    });
});

check('shim status reports what it did, for the /health page to echo', async () => {
    await shimmed({}, async ({ status }) => {
        assert.deepStrictEqual(Object.keys(status).sort(), [ 'installed', 'level', 'quiet', 'raw' ]);
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.raw, false);
        assert.strictEqual(typeof status.level, 'string');
    });
});

check('patched console returns undefined, like the real one', async () => {
    await shimmed({}, async () => {
        assert.strictEqual(console.log('ret'), undefined);
        await flush();
    });
});

// ─── production boot shape ─────────────────────────────────────────────────

check('createAppLogger wires the real Console transport, not a stub', async () => {
    const logger = createAppLogger({ level: 'warn' });
    assert.strictEqual(logger.transports.length, 1);
    assert.strictEqual(logger.transports[0].name, 'console');
    assert.strictEqual(logger.exitOnError, false);
    assert.strictEqual(logger.baseLevel, 'warn');
    assert.strictEqual(logger.level, 'warn');
    // The printf + timestamp pipeline itself is covered by the renderLine and
    // shim checks; here we only need the transport wiring.
    assert.ok(logger.transports[0] instanceof winston.transports.Console, 'not a Console transport');
});

check('CONSOLE_LEVELS covers exactly the five patched methods', () => {
    assert.deepStrictEqual(Object.keys(CONSOLE_LEVELS).sort(), [ 'debug', 'error', 'info', 'log', 'warn' ]);
});

run();
