require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ping = require('ping');
const wol = require('wake_on_lan');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// --- Configuration & State ---
const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.1.1';

// --- Persistent server list (saved to disk) ---
const SERVERS_FILE = path.join(__dirname, 'servers.json');

function loadServers() {
    try {
        if (fs.existsSync(SERVERS_FILE)) {
            const raw = fs.readFileSync(SERVERS_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            // Reset runtime-only fields so we start clean
            return parsed.map(s => ({ ...s, status: 'checking', lastWolSentAt: null, lastOnlineAt: null, confirming: false }));
        }
    } catch (err) {
        console.warn('[STORE] Could not load servers.json, starting fresh:', err.message);
    }
    return []; // No sample data – start empty
}

function saveServers() {
    try {
        // Only persist fields that should survive a restart
        const toSave = servers.map(({ id, name, ip, mac }) => ({ id, name, ip, mac }));
        fs.writeFileSync(SERVERS_FILE, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (err) {
        console.error('[STORE] Failed to save servers.json:', err.message);
    }
}

let servers = loadServers();

// How long to wait before re-sending a WoL packet to the same server (ms)
const WOL_COOLDOWN_MS   = 60_000;  // 1 minute between WoL attempts
// How long a server must stay online before its WoL cooldown is reset (prevents
// rapid WoL spam on flapping devices like phones/tablets that wake and sleep)
const STABLE_ONLINE_MS  = 5 * 60_000; // 5 minutes of continuous uptime

// Confirmation ping settings: on first failure, run this many extra pings before declaring the server down
const CONFIRM_PINGS        = 9;
const CONFIRM_INTERVAL_MS  = 1_000; // 1 second between each confirmation ping

// Simple sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Email Configuration (loaded from .env, editable via API) ---
let emailConfig = {
    host:     process.env.SMTP_HOST     || '',
    port:     parseInt(process.env.SMTP_PORT || '587'),
    secure:   process.env.SMTP_SECURE   === 'true',
    user:     process.env.SMTP_USER     || '',
    pass:     process.env.SMTP_PASS     || '',
    adminTo:  process.env.ADMIN_EMAIL   || '',
};

// --- Power Outage Tracking ---
let gatewayWasDown = false;            // Flag: were we previously in an outage?
let outageStartTime = null;            // When the outage began
let pendingOutageAlerts = [];          // Servers that need an email sent once gateway is back

// Build a Nodemailer transporter from current config. Returns null if config incomplete.
function buildTransporter() {
    if (!emailConfig.host || !emailConfig.user || !emailConfig.pass || !emailConfig.adminTo) {
        return null;
    }
    return nodemailer.createTransport({
        host: emailConfig.host,
        port: emailConfig.port,
        secure: emailConfig.secure,
        auth: { user: emailConfig.user, pass: emailConfig.pass },
    });
}

// Send a queued outage-recovery email, listing all affected servers.
async function sendOutageRecoveryEmail(affectedServers, outageDuration) {
    const transporter = buildTransporter();
    if (!transporter) {
        console.warn('[EMAIL] SMTP not configured. Skipping outage alert email.');
        return;
    }

    const serverList = affectedServers
        .map(s => `  • ${s.name}  (IP: ${s.ip} | MAC: ${s.mac})  – was offline at outage start`)
        .join('\n');

    const durationStr = outageDuration != null
        ? `approximately ${Math.round(outageDuration / 1000)} seconds`
        : 'an unknown duration';

    const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#111827;color:#f9fafb;padding:24px;border-radius:12px;">
            <h2 style="color:#34d399;margin-top:0;">⚡ Pi Network Guardian – Power Outage Alert</h2>
            <p>A <strong>power outage</strong> was detected on your network. The gateway was unreachable for <strong>${durationStr}</strong>.</p>
            <p>The following servers were offline when the outage began and have been queued for Wake-on-LAN:</p>
            <ul style="background:#1f2937;padding:16px 16px 16px 32px;border-radius:8px;font-family:monospace;font-size:14px;">
                ${affectedServers.map(s => `<li style="margin-bottom:6px;">${s.name} — IP: ${s.ip}</li>`).join('')}
            </ul>
            <p>The gateway is now <strong style="color:#34d399;">back online</strong>. Wake-on-LAN packets have been (or are being) dispatched.</p>
            <hr style="border-color:#374151;margin:24px 0;">
            <p style="font-size:12px;color:#6b7280;">Sent by Pi Network Guardian at ${new Date().toLocaleString()}</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"Pi Network Guardian" <${emailConfig.user}>`,
            to: emailConfig.adminTo,
            subject: `⚡ [ALERT] Power Outage Detected & Resolved – ${affectedServers.length} server(s) affected`,
            text: `Power outage detected. Gateway was down for ${durationStr}.\n\nAffected servers:\n${serverList}\n\nGateway is now back online. WoL packets have been dispatched.`,
            html,
        });
        console.log(`[EMAIL] Outage alert sent to ${emailConfig.adminTo} (${affectedServers.length} server(s) affected)`);
    } catch (err) {
        console.error('[EMAIL] Failed to send outage alert:', err.message);
    }
}

// --- API Routes for Adding/Removing Servers ---
app.get('/api/servers', (req, res) => res.json(servers));

app.post('/api/servers', (req, res) => {
    const { name, ip, mac } = req.body;
    if (!name || !ip || !mac) return res.status(400).json({ error: "Missing fields" });
    const newServer = { id: Date.now(), name, ip, mac, status: "checking", lastWolSentAt: null, lastOnlineAt: null, confirming: false };
    servers.push(newServer);
    saveServers();
    res.json(newServer);
});

app.delete('/api/servers/:id', (req, res) => {
    const id = parseInt(req.params.id);
    servers = servers.filter(s => s.id !== id);
    saveServers();
    res.json({ success: true });
});

// --- Email Config API ---
app.get('/api/config/email', (req, res) => {
    // Never expose the SMTP password in the response
    res.json({ ...emailConfig, pass: emailConfig.pass ? '••••••••' : '' });
});

app.post('/api/config/email', (req, res) => {
    const { host, port, secure, user, pass, adminTo } = req.body;
    if (host    !== undefined) emailConfig.host    = host;
    if (port    !== undefined) emailConfig.port    = parseInt(port);
    if (secure  !== undefined) emailConfig.secure  = Boolean(secure);
    if (user    !== undefined) emailConfig.user    = user;
    if (pass    !== undefined && pass !== '••••••••') emailConfig.pass = pass;
    if (adminTo !== undefined) emailConfig.adminTo = adminTo;
    console.log('[CONFIG] Email settings updated.');
    res.json({ success: true });
});

// Send a test email to verify SMTP settings
app.post('/api/config/email/test', async (req, res) => {
    const transporter = buildTransporter();
    if (!transporter) {
        return res.status(400).json({ error: 'Email not fully configured. Set SMTP host, user, pass and admin recipient first.' });
    }
    try {
        await transporter.sendMail({
            from: `"Pi Network Guardian" <${emailConfig.user}>`,
            to: emailConfig.adminTo,
            subject: '✅ Pi Network Guardian – Test Email',
            text: 'This is a test email from your Pi Network Guardian server monitor. If you received this, email alerts are working correctly.',
        });
        res.json({ success: true, message: `Test email sent to ${emailConfig.adminTo}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Core Monitoring Logic ---
async function checkGateway() {
    const res = await ping.promise.probe(GATEWAY_IP, { timeout: 2 });
    return res.alive;
}

// Triggered when a server is confirmed DOWN after all confirmation pings fail.
// Handles gateway check, WoL dispatch, and power-outage state.
async function handleConfirmedDown(s) {
    console.log(`[CONFIRMED DOWN] ${s.name} failed all ${CONFIRM_PINGS} confirmation pings. Checking gateway...`);

    const gatewayAlive = await checkGateway();

    if (!gatewayAlive) {
        // Power outage
        if (!gatewayWasDown) {
            gatewayWasDown = true;
            outageStartTime = Date.now();
            console.log('[POWER OUTAGE] Gateway unreachable. Presuming power loss. Email queued for when gateway recovers.');
            pendingOutageAlerts = servers.map(s => ({ ...s }));
            io.emit('gateway-status', { alive: false, outageStartTime });
        }
        s.status = 'waiting-for-power';
    } else {
        // Gateway is up – server genuinely down, send WoL
        const now = Date.now();
        const cooldownExpired = !s.lastWolSentAt || (now - s.lastWolSentAt) >= WOL_COOLDOWN_MS;

        if (cooldownExpired) {
            console.log(`[ALERT] ${s.name} confirmed down. Gateway is up. Triggering Wake-on-LAN...`);
            s.status = 'waking';
            s.lastWolSentAt = now;
            wol.wake(s.mac, (error) => {
                if (error) console.error(`WoL Error for ${s.name}:`, error);
            });
        } else {
            const retryIn = Math.round((WOL_COOLDOWN_MS - (now - s.lastWolSentAt)) / 1000);
            console.log(`[WAIT] ${s.name} still offline. WoL cooldown active – retry in ${retryIn}s.`);
            s.status = 'waking';
        }
    }

    io.emit('status-update', servers);
}

// Run CONFIRM_PINGS extra pings (1/sec) after a first failure.
// Returns true if the server recovered (false alarm), false if all failed (confirmed down).
async function runConfirmationPings(s) {
    s.confirming = true;
    s.status = 'verifying';
    io.emit('status-update', servers);
    console.log(`[VERIFY] ${s.name} failed first ping. Running ${CONFIRM_PINGS} confirmation pings...`);

    for (let i = 1; i <= CONFIRM_PINGS; i++) {
        await sleep(CONFIRM_INTERVAL_MS);

        // If a power outage was detected during this window, abort and let outage logic take over
        if (gatewayWasDown) {
            console.log(`[VERIFY] ${s.name} – outage detected mid-confirmation. Aborting verification.`);
            s.confirming = false;
            s.status = 'waiting-for-power';
            io.emit('status-update', servers);
            return true; // don't double-process via handleConfirmedDown
        }

        const result = await ping.promise.probe(s.ip, { timeout: 1 });
        if (result.alive) {
            console.log(`[VERIFY] ${s.name} recovered on confirmation ping ${i}/${CONFIRM_PINGS}. Treating as online (false alarm).`);
            s.status = 'online';
            s.lastOnlineAt = Date.now(); // start stability timer; don't clear WoL cooldown yet
            s.confirming = false;
            io.emit('status-update', servers);
            return true; // false alarm – server is fine
        }
        console.log(`[VERIFY] ${s.name} still down (${i}/${CONFIRM_PINGS})...`);
    }

    s.confirming = false;
    return false; // confirmed down
}

async function monitorServers() {
    const gatewayAlive = await checkGateway();

    if (!gatewayAlive) {
        // ── GATEWAY IS DOWN ─────────────────────────────────────────────────
        if (!gatewayWasDown) {
            gatewayWasDown = true;
            outageStartTime = Date.now();
            console.log('[POWER OUTAGE] Gateway unreachable. Presuming power loss. Email queued for when gateway recovers.');
            pendingOutageAlerts = servers.map(s => ({ ...s }));
        }
        for (let s of servers) {
            s.confirming = false; // cancel any in-progress confirmation
            s.status = 'waiting-for-power';
        }
        io.emit('status-update', servers);
        io.emit('gateway-status', { alive: false, outageStartTime });
        return;
    }

    // ── GATEWAY IS ALIVE ──────────────────────────────────────────────────
    if (gatewayWasDown) {
        const outageDuration = outageStartTime ? Date.now() - outageStartTime : null;
        console.log(`[POWER RESTORED] Gateway is back online after ${outageDuration != null ? Math.round(outageDuration / 1000) + 's' : 'unknown duration'}. Sending queued email alert...`);
        gatewayWasDown = false;
        if (pendingOutageAlerts.length > 0) {
            sendOutageRecoveryEmail(pendingOutageAlerts, outageDuration);
            pendingOutageAlerts = [];
        }
        io.emit('gateway-status', { alive: true, outageStartTime: null });
        outageStartTime = null;
    }

    // ── PER-SERVER PING ───────────────────────────────────────────────────
    for (let s of servers) {
        // Skip servers already going through their 9-ping confirmation window
        if (s.confirming) {
            console.log(`[SKIP] ${s.name} is already in confirmation window – skipping this cycle.`);
            continue;
        }

        const isAlive = await ping.promise.probe(s.ip, { timeout: 1 });

        if (isAlive.alive) {
            if (s.status !== 'online') {
                console.log(`[RECOVERED] ${s.name} is back online.`);
            }
            s.status = 'online';
            // Only reset the WoL cooldown once the server has been stably online
            // for STABLE_ONLINE_MS – prevents rapid WoL blasts on flapping devices.
            if (!s.lastOnlineAt) s.lastOnlineAt = Date.now();
            if (s.lastWolSentAt && (Date.now() - s.lastOnlineAt) >= STABLE_ONLINE_MS) {
                console.log(`[STABLE] ${s.name} has been online for ${STABLE_ONLINE_MS / 60000} min. Resetting WoL cooldown.`);
                s.lastWolSentAt = null;
                s.lastOnlineAt  = null;
            }
        } else {
            // First ping failed – start confirmation window asynchronously
            // so this loop doesn't block waiting 9 seconds per server
            runConfirmationPings(s).then(recovered => {
                if (!recovered) handleConfirmedDown(s);
            });
        }
    }

    io.emit('status-update', servers);
}

async function checkGatewayOnly() {
    const alive = await checkGateway();
    if (!alive && !gatewayWasDown) {
        // Outage just started – run the full monitor cycle immediately to snapshot server states
        await monitorServers();
    } else if (alive && gatewayWasDown) {
        // Recovery – also run the full cycle immediately to dispatch email and WoL
        await monitorServers();
    }
    // Otherwise the regular 10s server poll will handle things
}

// Gateway is polled every 2s for fast outage/recovery detection
setInterval(checkGatewayOnly, 2_000);

// Full server ping + WoL cycle every 10 seconds
setInterval(monitorServers, 10_000);

// --- WebSocket Connection ---
io.on('connection', (socket) => {
    socket.emit('status-update', servers);
    socket.emit('gateway-status', {
        alive: !gatewayWasDown,
        outageStartTime: gatewayWasDown ? outageStartTime : null,
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pi Network Guardian running on http://localhost:${PORT}`));