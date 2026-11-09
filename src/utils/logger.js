/**
 * logger.js — winston logger + console interception (Phase 1 §A1).
 * Kept byte-for-byte identical in whatsappbot-main and exchange-return-tracking-main.
 *
 * WHY INTERCEPTION INSTEAD OF A FIND/REPLACE:
 * The two apps together have roughly 9,650 console.* call sites across hundreds
 * of files, including files other work is actively editing. Rewriting them would
 * produce an unreviewable diff spanning every repo, collide with those sessions,
 * and make bisecting a later regression impossible because every line moved.
 * Patching the console methods once at boot makes all 9,650 sites structured AND
 * redacted with zero call-site edits, and the diff is a handful of lines.
 *
 * THE FOUR CONSTRAINTS THAT MAKE THIS SAFE:
 * 1. Message text is preserved. util.format(...args) produces exactly the string
 *    console would have printed, so the emoji scanning aids (✅ ⚠️ 🔥 📦 🚀) and
 *    the [MEMORY] / SLOW QUERY grep habits keep working. Output is one
 *    "timestamp | LEVEL | message" line, not JSON-as-the-message — Render's log
 *    viewer is read by eye, and pure JSON there is a net readability loss.
 *    Structured fields are still available to new code via logger.info(msg, meta),
 *    which appends its meta as key=value pairs on the same line.
 * 2. Error semantics are preserved: util.format already renders err.stack for
 *    Error instances and prints real fields for plain objects — including the
 *    PostgREST rejection objects that Node's own unhandled-rejection printer
 *    shows as "#<Object>" (that is why describeFatal() exists in server.js).
 * 3. The shim can never silence logging or throw inside a request path: every
 *    delegate is wrapped and falls back to writing the original text straight to
 *    the stdout/stderr stream. A re-entrancy flag makes recursion impossible
 *    (winston's Console transport writes via console._stdout in Node, verified
 *    with a probe, but the guard means a future transport swap cannot deadlock).
 * 4. console.dir / console.table / console.time are deliberately left alone, and
 *    LOG_RAW=true disables interception entirely for debugging the logger itself.
 *
 * ENV KNOBS (identical in both apps):
 *   LOG_LEVEL   error | warn | info | debug   (default warn — raised to info in
 *               production only after §A4 volume is measured, per Phase 1 §A2)
 *   LOG_QUIET   comma-separated message prefixes suppressed at info/debug only
 *   LOG_RAW     true disables interception
 *   LOG_PRETTY  true keeps multi-line output un-collapsed
 *   LOG_MAX_LINE  per-line character ceiling (see redact.js)
 */

const util = require('util');
const winston = require('winston');
const { redactText, redactDeep, collapseLines, capLine } = require('./redact');

// console method → winston level. Only these five are patched.
const CONSOLE_LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

// The untouched natives, captured at module load — i.e. before this file's own
// install() can possibly run. Restoring these on uninstall gives back the exact
// original functions; restoring a saved `console[fn].bind(console)` instead
// would add a bind() wrapper on every install/uninstall cycle and leave
// `console.log === console.log` false, which is the only way a caller can
// verify that LOG_RAW really did mean "do not touch my console".
const NATIVE_CONSOLE = {};
for (const method of Object.keys(CONSOLE_LEVELS)) {
    if (typeof console[method] === 'function') NATIVE_CONSOLE[method] = console[method];
}

const KNOWN_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];

function resolveLevel(fallback = 'warn') {
    const wanted = String(process.env.LOG_LEVEL || '').trim().toLowerCase();
    return KNOWN_LEVELS.includes(wanted) ? wanted : fallback;
}

function quietPrefixes() {
    return String(process.env.LOG_QUIET || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isPretty() {
    return String(process.env.LOG_PRETTY || '').toLowerCase() === 'true';
}

// Meta values are quoted when string so a grep for ip="1.2.3.4" still works.
function renderMeta(value) {
    if (typeof value === 'string') return JSON.stringify(redactText(value));
    if (value instanceof Error) return JSON.stringify(redactText(value.stack || value.message));
    if (value === null || value === undefined) return String(value);
    if (typeof value !== 'object') return JSON.stringify(value);
    try {
        return JSON.stringify(redactDeep(value));
    } catch (e) {
        return JSON.stringify(redactText(String(value)));
    }
}

/**
 * One human-readable line: timestamp | LEVEL | message [key=value …].
 * Redaction of the message itself happens in the shim; this renders meta, which
 * only direct logger calls (new code) carry.
 */
function renderLine(info) {
    const { timestamp, level, message, ...meta } = info;
    // timestamp() always supplies one; the guard exists so a hand-built info
    // object can never print a literal "undefined" down the front of a line.
    let line = `${timestamp || '-'} | ${String(level).toUpperCase()} | ${message}`;
    const keys = Object.keys(meta);
    if (keys.length) line += ' ' + keys.map(k => `${k}=${renderMeta(meta[k])}`).join(' ');
    if (!isPretty()) line = collapseLines(line);
    return capLine(line);
}

/**
 * Create the app logger. Called once, at boot, before any other module that
 * logs. `opts.level` is the code default; LOG_LEVEL still wins when set.
 */
function createAppLogger(opts = {}) {
    const baseLevel = opts.level || 'warn';
    const logger = winston.createLogger({
        level: resolveLevel(baseLevel),
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(renderLine)
        ),
        transports: [new winston.transports.Console()],
        // A failed log line must never take the process down.
        exitOnError: false
    });
    // Remembered so the shim can re-resolve after dotenv loads later in boot.
    logger.baseLevel = baseLevel;
    return logger;
}

let shimInstalled = false;
let shimStatus = { installed: false, raw: false, level: null, quiet: [] };

/**
 * Route console.* through the logger. Idempotent — a second call is a no-op, so
 * a hot reload or a stray require cannot stack shims.
 */
function installConsoleShim(logger) {
    if (shimInstalled) return shimStatus;

    if (String(process.env.LOG_RAW || '').toLowerCase() === 'true') {
        shimStatus = { installed: false, raw: true, level: logger.level, quiet: quietPrefixes() };
        return shimStatus;
    }

    // Re-resolve now that dotenv has had a chance to run.
    logger.level = resolveLevel(logger.baseLevel || 'warn');
    const quiet = quietPrefixes();

    // Last-resort path: straight to the stream, bypassing winston entirely.
    const fallbackWrite = (fn, args) => {
        try {
            const stream = (fn === 'error' || fn === 'warn') ? process.stderr : process.stdout;
            stream.write(`${util.format(...args)}\n`);
        } catch (e) {
            // Nothing left to try, and nothing worth throwing for.
        }
    };

    let inShim = false;

    for (const [fn, level] of Object.entries(CONSOLE_LEVELS)) {
        console[fn] = function patchedConsole(...args) {
            // Re-entrant call (something logged from inside a transport): write
            // raw instead of looping. Never recurse into the logger.
            if (inShim) { fallbackWrite(fn, args); return; }
            inShim = true;
            try {
                const message = util.format(...args);
                if (level !== 'error' && level !== 'warn') {
                    const trimmed = message.replace(/^\s+/, '');
                    for (const prefix of quiet) {
                        if (trimmed.startsWith(prefix)) return;
                    }
                }
                logger.log(level, redactText(message));
            } catch (err) {
                fallbackWrite(fn, args);
                try {
                    process.stderr.write(`[logger] interception failed, fell back to raw output: ${err && err.message}\n`);
                } catch (e) { /* unreachable */ }
            } finally {
                inShim = false;
            }
        };
    }

    // Marker so a test (or a future debug helper) can see that the console is
    // patched and un-patch it without restarting the process.
    console.__loggerShim = { logger: logger, methods: Object.keys(CONSOLE_LEVELS) };
    shimInstalled = true;
    shimStatus = { installed: true, raw: false, level: logger.level, quiet };
    return shimStatus;
}

function getShimStatus() {
    return shimStatus;
}

function uninstallConsoleShim() {
    if (!console.__loggerShim) return false;
    for (const fn of Object.keys(CONSOLE_LEVELS)) {
        if (typeof NATIVE_CONSOLE[fn] === 'function') console[fn] = NATIVE_CONSOLE[fn];
    }
    delete console.__loggerShim;
    shimInstalled = false;
    shimStatus = { installed: false, raw: false, level: null, quiet: [] };
    return true;
}

module.exports = {
    createAppLogger,
    installConsoleShim,
    uninstallConsoleShim,
    getShimStatus,
    renderLine,
    resolveLevel,
    CONSOLE_LEVELS
};
