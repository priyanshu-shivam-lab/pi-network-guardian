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
            // Reset runtime-only fields; preserve wolEnabled from disk
            return parsed.map(s => ({
                ...s,
                wolEnabled:  s.wolEnabled !== false, // default true for legacy entries
                status:      'checking',
                lastWolSentAt: null,
                lastOnlineAt:  null,
                alertedAt:     null,  // timestamp of last server-down email (non-WoL servers)
                confirming:    false,
            }));
        }
    } catch (err) {
        console.warn('[STORE] Could not load servers.json, starting fresh:', err.message);
    }
    return [];
}

function saveServers() {
    try {
        // Persist only stable, config-level fields
        const toSave = servers.map(({ id, name, ip, mac, wolEnabled }) => ({ id, name, ip, mac, wolEnabled }));
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

// After the gateway recovers, wait this long before re-pinging servers.
// Prevents false WoL / alert emails caused by router reboots (e.g. firmware updates)
// where servers were never actually offline – just temporarily unreachable.
const RECOVERY_GRACE_MS = 2 * 60_000; // 2 minutes

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

// Send a queued outage-recovery email, listing servers confirmed still offline after the grace period.
async function sendOutageRecoveryEmail(affectedServers, outageDuration) {
    const transporter = buildTransporter();
    if (!transporter) {
        console.warn('[EMAIL] SMTP not configured. Skipping outage alert email.');
        return;
    }

    const serverList = affectedServers
        .map(s => `  • ${s.name}  (IP: ${s.ip} | MAC: ${s.mac})  – still offline after recovery grace period`)
        .join('\n');

    const durationStr = outageDuration != null
        ? `approximately ${Math.round(outageDuration / 1000)} seconds`
        : 'an unknown duration';

    const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#111827;color:#f9fafb;padding:24px;border-radius:12px;">
            <h2 style="color:#34d399;margin-top:0;">⚡ Pi Network Guardian – Power Outage Alert</h2>
            <p>A <strong>power outage</strong> was detected on your network. The gateway was unreachable for <strong>${durationStr}</strong>.</p>
            <p>After the gateway recovered, the following servers were <strong>still offline after a 2-minute verification window</strong> and have been sent Wake-on-LAN packets:</p>
            <ul style="background:#1f2937;padding:16px 16px 16px 32px;border-radius:8px;font-family:monospace;font-size:14px;">
                ${affectedServers.map(s => `<li style="margin-bottom:6px;">${s.name} — IP: ${s.ip}</li>`).join('')}
            </ul>
            <p>The gateway is now <strong style="color:#34d399;">back online</strong>. Wake-on-LAN packets have been dispatched to the servers listed above.</p>
            <hr style="border-color:#374151;margin:24px 0;">
            <p style="font-size:12px;color:#6b7280;">Sent by Pi Network Guardian at ${new Date().toLocaleString()}</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"Pi Network Guardian" <${emailConfig.user}>`,
            to: emailConfig.adminTo,
            subject: `⚡ [ALERT] Power Outage Resolved – ${affectedServers.length} server(s) still offline`,
            text: `Power outage detected. Gateway was down for ${durationStr}.\n\nThe following servers were still offline after a 2-minute post-recovery check:\n${serverList}\n\nWoL packets have been dispatched.`,
            html,
        });
        console.log(`[EMAIL] Outage alert sent to ${emailConfig.adminTo} (${affectedServers.length} server(s) still offline after grace period)`);
    } catch (err) {
        console.error('[EMAIL] Failed to send outage alert:', err.message);
    }
}

// Called when the gateway comes back online after an outage.
// Waits RECOVERY_GRACE_MS then re-pings every pending server.
// Only sends WoL / alert email for servers that are genuinely still offline.
// This prevents false alerts caused by router reboots (e.g. firmware updates)
// where servers were unreachable only because the gateway was temporarily down.
async function handleGatewayRecovery(pendingServers, outageDuration) {
    console.log(`[RECOVERY] Gateway restored. Waiting ${RECOVERY_GRACE_MS / 1000}s before verifying servers...`);

    // Mark all waiting servers as 'verifying' so the UI shows they're being checked
    for (const s of servers) {
        if (s.status === 'waiting-for-power') s.status = 'verifying';
    }
    io.emit('status-update', servers);

    await sleep(RECOVERY_GRACE_MS);

    console.log('[RECOVERY] Grace period elapsed. Re-pinging servers to confirm actual status...');

    const stillOffline = [];
    for (const pending of pendingServers) {
        const liveServer = servers.find(s => s.id === pending.id);
        if (!liveServer) continue;

        // Skip if the regular monitor already marked it back online during the grace period
        if (liveServer.status === 'online') {
            console.log(`[RECOVERY] ${liveServer.name} already marked online – skipping.`);
            continue;
        }

        const result = await ping.promise.probe(liveServer.ip, { timeout: 2 });
        if (result.alive) {
            console.log(`[RECOVERY] ${liveServer.name} is responding – no WoL needed.`);
            liveServer.status = 'online';
            liveServer.lastOnlineAt = Date.now();
            liveServer.alertedAt = null;
        } else {
            console.log(`[RECOVERY] ${liveServer.name} is still offline – will send WoL.`);
            stillOffline.push(liveServer);
        }
    }

    io.emit('status-update', servers);

    if (stillOffline.length === 0) {
        console.log('[RECOVERY] All servers came back on their own. No WoL sent. No alert email.');
        return;
    }

    // Dispatch WoL only to servers confirmed still offline
    const wolTargets = [];
    for (const s of stillOffline) {
        if (s.wolEnabled) {
            const now = Date.now();
            const cooldownExpired = !s.lastWolSentAt || (now - s.lastWolSentAt) >= WOL_COOLDOWN_MS;
            if (cooldownExpired) {
                console.log(`[WOL] ${s.name} still offline after grace period – sending Wake-on-LAN.`);
                s.status = 'waking';
                s.lastWolSentAt = now;
                wol.wake(s.mac, (error) => {
                    if (error) console.error(`WoL Error for ${s.name}:`, error);
                });
                wolTargets.push(s);
            } else {
                const retryIn = Math.round((WOL_COOLDOWN_MS - (now - s.lastWolSentAt)) / 1000);
                console.log(`[WAIT] ${s.name} WoL cooldown active – retry in ${retryIn}s.`);
                s.status = 'waking';
            }
        } else {
            s.status = 'alerted';
            if (!s.alertedAt) {
                s.alertedAt = Date.now();
                sendServerDownEmail(s);
            }
        }
    }

    io.emit('status-update', servers);

    // Send the outage recovery email only for servers that actually needed WoL
    if (wolTargets.length > 0) {
        sendOutageRecoveryEmail(wolTargets, outageDuration);
    }
}

// --- API Routes for Adding/Removing Servers ---
app.get('/api/servers', (req, res) => res.json(servers));

app.post('/api/servers', (req, res) => {
    const { name, ip, mac, wolEnabled } = req.body;
    const wol = wolEnabled !== false; // default true
    if (!name || !ip) return res.status(400).json({ error: 'Name and IP are required.' });
    if (wol && !mac)  return res.status(400).json({ error: 'MAC address is required when Wake-on-LAN is enabled.' });
    const newServer = {
        id: Date.now(), name, ip,
        mac: mac || '',
        wolEnabled: wol,
        status: 'checking',
        lastWolSentAt: null, lastOnlineAt: null, alertedAt: null, confirming: false,
    };
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

// Send an immediate alert email when a non-WoL server is confirmed down.
async function sendServerDownEmail(s) {
    const transporter = buildTransporter();
    if (!transporter) {
        console.warn(`[EMAIL] SMTP not configured. Skipping down-alert for ${s.name}.`);
        return;
    }
    const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#111827;color:#f9fafb;padding:24px;border-radius:12px;">
            <h2 style="color:#f87171;margin-top:0;">🔴 Pi Network Guardian – Server Down Alert</h2>
            <p>The following server is <strong>offline</strong> and requires <strong>manual intervention</strong>:</p>
            <table style="width:100%;background:#1f2937;border-radius:8px;padding:16px;font-family:monospace;font-size:14px;border-collapse:collapse;">
                <tr><td style="color:#9ca3af;padding:4px 8px;">Name</td><td style="color:#f9fafb;padding:4px 8px;">${s.name}</td></tr>
                <tr><td style="color:#9ca3af;padding:4px 8px;">IP Address</td><td style="color:#f9fafb;padding:4px 8px;">${s.ip}</td></tr>
                <tr><td style="color:#9ca3af;padding:4px 8px;">Wake-on-LAN</td><td style="color:#f87171;padding:4px 8px;">Disabled – no automatic recovery</td></tr>
                <tr><td style="color:#9ca3af;padding:4px 8px;">Detected at</td><td style="color:#f9fafb;padding:4px 8px;">${new Date().toLocaleString()}</td></tr>
            </table>
            <p style="margin-top:16px;">Please check the device manually. The monitor will notify you again when it comes back online.</p>
            <hr style="border-color:#374151;margin:24px 0;">
            <p style="font-size:12px;color:#6b7280;">Sent by Pi Network Guardian</p>
        </div>
    `;
    try {
        await transporter.sendMail({
            from: `"Pi Network Guardian" <${emailConfig.user}>`,
            to: emailConfig.adminTo,
            subject: `🔴 [DOWN] ${s.name} is offline – manual action required`,
            text: `Server Down Alert\n\nName: ${s.name}\nIP: ${s.ip}\nWake-on-LAN: Disabled\nDetected: ${new Date().toLocaleString()}\n\nPlease check the device manually.`,
            html,
        });
        console.log(`[EMAIL] Server-down alert sent for ${s.name} (WoL disabled).`);
    } catch (err) {
        console.error(`[EMAIL] Failed to send server-down alert for ${s.name}:`, err.message);
    }
}

// Triggered when a server is confirmed DOWN after all confirmation pings fail.
async function handleConfirmedDown(s) {
    console.log(`[CONFIRMED DOWN] ${s.name} failed all ${CONFIRM_PINGS} confirmation pings. Checking gateway...`);

    const gatewayAlive = await checkGateway();

    if (!gatewayAlive) {
        // Power outage – handled by the existing outage email pipeline
        if (!gatewayWasDown) {
            gatewayWasDown = true;
            outageStartTime = Date.now();
            console.log('[POWER OUTAGE] Gateway unreachable. Presuming power loss. Email queued for when gateway recovers.');
            pendingOutageAlerts = servers.map(s => ({ ...s }));
            io.emit('gateway-status', { alive: false, outageStartTime });
        }
        s.status = 'waiting-for-power';
    } else if (s.wolEnabled) {
        // ── WoL ENABLED: send magic packet ──────────────────────────────────
        const now = Date.now();
        const cooldownExpired = !s.lastWolSentAt || (now - s.lastWolSentAt) >= WOL_COOLDOWN_MS;
        if (cooldownExpired) {
            console.log(`[WOL] ${s.name} confirmed down. Gateway up. Sending Wake-on-LAN...`);
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
    } else {
        // ── WoL DISABLED: alert admin by email ──────────────────────────────
        s.status = 'alerted';
        if (!s.alertedAt) {
            // Only send once per outage period (reset when server comes back online)
            s.alertedAt = Date.now();
            console.log(`[ALERT] ${s.name} is down and WoL is disabled. Sending email alert...`);
            sendServerDownEmail(s);
        } else {
            console.log(`[SKIP ALERT] ${s.name} already alerted at ${new Date(s.alertedAt).toLocaleTimeString()}. Waiting for recovery.`);
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
        console.log(`[POWER RESTORED] Gateway is back online after ${outageDuration != null ? Math.round(outageDuration / 1000) + 's' : 'unknown duration'}. Starting ${RECOVERY_GRACE_MS / 1000}s verification window before sending WoL/alerts...`);
        gatewayWasDown = false;
        outageStartTime = null;
        io.emit('gateway-status', { alive: true, outageStartTime: null });

        if (pendingOutageAlerts.length > 0) {
            const pending = [...pendingOutageAlerts];
            pendingOutageAlerts = [];
            // Fire-and-forget: waits 2 min, re-pings servers, only acts on genuinely offline ones
            handleGatewayRecovery(pending, outageDuration);
        }
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
                // If we had alerted (non-WoL server was down), send a recovery notification
                if (!s.wolEnabled && s.alertedAt) {
                    const transporter = buildTransporter();
                    if (transporter) {
                        transporter.sendMail({
                            from: `"Pi Network Guardian" <${emailConfig.user}>`,
                            to: emailConfig.adminTo,
                            subject: `✅ [RECOVERED] ${s.name} is back online`,
                            text: `Good news! ${s.name} (${s.ip}) is back online as of ${new Date().toLocaleString()}.`,
                        }).catch(err => console.error(`[EMAIL] Recovery notice failed for ${s.name}:`, err.message));
                        console.log(`[EMAIL] Recovery notice sent for ${s.name}.`);
                    }
                }
            }
            s.status = 'online';
            s.alertedAt = null; // reset so next outage triggers a fresh email
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
        alive:           !gatewayWasDown,
        outageStartTime: gatewayWasDown ? outageStartTime : null,
        gatewayIp:       GATEWAY_IP,
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pi Network Guardian running on http://localhost:${PORT}`));