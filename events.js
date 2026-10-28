// --- Event history ---
// Append-only log of state changes (history.jsonl) plus a heartbeat file.
// The Pi has no battery or RTC: during a power cut it is simply off, and after
// boot its clock is wrong until NTP syncs through the router. So:
//   • events recorded before the clock is trusted are buffered with a monotonic
//     timestamp and converted to wall-clock time once NTP has synced;
//   • the heartbeat (last time we were alive) is compared with the Pi's boot
//     time after sync to work out whether the Pi was off, i.e. power was out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HISTORY_FILE   = path.join(__dirname, 'history.jsonl');
const HEARTBEAT_FILE = path.join(__dirname, 'heartbeat.json');

const RETENTION_MS    = 7 * 24 * 60 * 60_000; // keep 7 days of history
const HEARTBEAT_MS    = 30_000;               // outage start is accurate to within this
const SYNC_POLL_MS    = 5_000;
const SYNC_TIMEOUT_MS = 10 * 60_000;          // give up waiting for NTP and trust the clock
const PRUNE_EVERY_MS  = 6 * 60 * 60_000;

const startMono = performance.now();
let synced = false;
let buffer = [];            // events recorded before the clock was trusted: { mono, type, ...data }
let pendingPowerOutage = null;
const listeners = [];

let resolveReady;
const clockReady = new Promise(resolve => { resolveReady = resolve; });

// Convert a performance.now() reading to wall-clock ms using the (now trusted) clock.
// The monotonic clock is unaffected by NTP jumps, so this corrects pre-sync events.
const wallFromMono = (mono) => Math.round(Date.now() - (performance.now() - mono));

function commit(ev) {
    try {
        fs.appendFileSync(HISTORY_FILE, JSON.stringify(ev) + '\n', 'utf8');
    } catch (err) {
        console.error('[HISTORY] Failed to write event:', err.message);
    }
    for (const fn of listeners) fn(ev);
}

function record(type, data = {}) {
    if (!synced) {
        buffer.push({ mono: performance.now(), type, ...data });
        return;
    }
    commit({ ts: Date.now(), type, ...data });
}

function readAll() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        return fs.readFileSync(HISTORY_FILE, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
    } catch (err) {
        console.error('[HISTORY] Failed to read history:', err.message);
        return [];
    }
}

function prune() {
    const cutoff = Date.now() - RETENTION_MS;
    const all = readAll();
    const kept = all.filter(ev => ev.ts >= cutoff);
    if (kept.length === all.length) return;
    try {
        const tmp = HISTORY_FILE + '.tmp';
        fs.writeFileSync(tmp, kept.map(ev => JSON.stringify(ev)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
        fs.renameSync(tmp, HISTORY_FILE);
        console.log(`[HISTORY] Pruned ${all.length - kept.length} event(s) older than 7 days.`);
    } catch (err) {
        console.error('[HISTORY] Failed to prune history:', err.message);
    }
}

function readHeartbeat() {
    try {
        if (fs.existsSync(HEARTBEAT_FILE)) return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    } catch (err) {
        console.warn('[HISTORY] Could not read heartbeat:', err.message);
    }
    return null;
}

function writeHeartbeat(clean) {
    try {
        const tmp = HEARTBEAT_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), clean }), 'utf8');
        fs.renameSync(tmp, HEARTBEAT_FILE);
    } catch (err) {
        console.error('[HISTORY] Failed to write heartbeat:', err.message);
    }
}

// Resolves true once systemd reports NTP sync. Machines without timedatectl
// (dev laptops, containers) are assumed to have a correct clock.
function checkClockSynced() {
    return new Promise(resolve => {
        execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 3_000 }, (err, stdout) => {
            if (err) return resolve(true);
            resolve(stdout.trim() === 'yes');
        });
    });
}

// Called once the clock can be trusted: work out why we were down, then flush buffered events.
function onClockReady(trusted) {
    synced = true;
    const startedAt = wallFromMono(startMono);
    const bootAt    = Math.round(Date.now() - os.uptime() * 1000);
    const hb        = readHeartbeat();

    let cause;
    if (!hb)                cause = 'first-run';
    else if (bootAt > hb.ts) cause = hb.clean ? 'pi-reboot' : 'power-outage'; // Pi itself was off
    else                     cause = 'app-restart';                             // only the app restarted

    commit({ ts: startedAt, type: 'monitor-start', cause, lastSeen: hb ? hb.ts : null, bootAt, clockTrusted: trusted });
    if (cause === 'power-outage') {
        pendingPowerOutage = { start: hb.ts, powerBackAt: bootAt };
        console.log(`[HISTORY] Pi was off from ${new Date(hb.ts).toLocaleString()} to ${new Date(bootAt).toLocaleString()} – recorded as power outage.`);
    }

    for (const { mono, ...ev } of buffer) commit({ ts: wallFromMono(mono), ...ev });
    buffer = [];

    prune();
    writeHeartbeat(false);
    setInterval(() => writeHeartbeat(false), HEARTBEAT_MS);
    setInterval(prune, PRUNE_EVERY_MS);
    resolveReady();
}

async function start() {
    let waitedMs = 0;
    while (!(await checkClockSynced())) {
        if (waitedMs >= SYNC_TIMEOUT_MS) {
            console.warn('[HISTORY] NTP not synced after 10 minutes – trusting system clock.');
            return onClockReady(false);
        }
        if (waitedMs === 0) console.log('[HISTORY] Waiting for NTP clock sync before writing history...');
        await new Promise(r => setTimeout(r, SYNC_POLL_MS));
        waitedMs += SYNC_POLL_MS;
    }
    onClockReady(true);
}

// Mark the heartbeat as a clean stop (pm2 reload / system shutdown) so a reboot
// isn't mistaken for a power cut.
function markCleanStop() {
    if (synced) writeHeartbeat(true);
}

// Returns the power outage found at startup (once), so it is only assessed once.
function takePowerOutage() {
    const outage = pendingPowerOutage;
    pendingPowerOutage = null;
    return outage;
}

module.exports = {
    HEARTBEAT_MS,
    start,
    record,
    readAll,
    clockReady,
    wallFromMono,
    markCleanStop,
    takePowerOutage,
    isSynced: () => synced,
    onEvent: (fn) => listeners.push(fn),
};
