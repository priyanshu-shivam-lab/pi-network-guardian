# ⚡ Pi Network Guardian

A lightweight Node.js server monitor designed to run on a **Raspberry Pi** (or any always-on machine). It pings your servers every 10 seconds, detects power outages by checking the gateway, automatically sends **Wake-on-LAN** packets to bring servers back up, and emails the admin once connectivity is restored.

> 📦 **Deployment:** Runs on PM2. See [DEPLOY.md](./DEPLOY.md) for the full setup guide.

---

## Features

| Feature | Detail |
|---|---|
| **Real-time dashboard** | Live server status cards updated via WebSocket (Socket.IO) |
| **9-ping confirmation** | A failed ping triggers 9 more pings (1/sec) before marking a server down — eliminates false alarms from transient blips |
| **Power outage detection** | Gateway is checked every 2 seconds; if it goes down, all servers switch to "Waiting for Power" |
| **Wake-on-LAN** | Sends a WoL magic packet to offline servers when the gateway is alive; respects a 60-second cooldown and a 5-minute stability timer to avoid spamming flapping devices |
| **Deferred email alerts** | Email cannot be sent during an outage (no gateway). The alert is queued and dispatched the moment the gateway comes back online |
| **Persistent server list** | Servers are saved to `servers.json` and survive restarts |
| **In-browser SMTP config** | Configure email settings and send a test email without touching config files |
| **History (7 days)** | Timeline of power, gateway and each server, a card per outage saying whether each server shut down because of it, and a full event log |

---

## Status States

| Badge | Meaning |
|---|---|
| 🟢 **ONLINE** | Server is reachable |
| 🔍 **VERIFYING…** | First ping failed; running 9 confirmation pings |
| ⚡ **SENDING WOL** | Confirmed offline; Wake-on-LAN packet dispatched |
| 🔌 **POWER LOSS** | Gateway is down; server is waiting for power restoration |

---

## Prerequisites

- **Node.js** v18 or higher
- The machine running this app must be **on the same LAN** as the monitored servers for WoL to work
- Target servers must have **Wake-on-LAN enabled** in their BIOS/firmware

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-username/pi-network-guardian.git
cd pi-network-guardian
npm install
```

### 2. Configure environment

Copy the template and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
# Your router / default gateway IP
GATEWAY_IP=192.168.1.1

# Port for the web dashboard
PORT=3000

# SMTP settings (Gmail example)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false          # false = STARTTLS on port 587, true = implicit TLS on port 465
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password   # Use a Gmail App Password, not your account password

# Where to send outage alert emails
ADMIN_EMAIL=admin@yourdomain.com

# Minutes your servers' own shutdown script waits with the gateway unreachable
SERVER_SHUTDOWN_AFTER_MIN=5
```

> **Gmail users:** Generate an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Do **not** use your Gmail account password.

### 3. Start the app

```bash
npm start
```

Open `http://localhost:3000` in your browser.

---

## Usage

### Adding a server
Fill in **Name**, **IP address**, and **MAC address** in the form at the bottom of the dashboard and click **Add Server**.

### Configuring email alerts
Click the **⚙️ Email Alerts** button in the top-right corner. Enter your SMTP settings and click **Save Settings**. Use **Send Test Email** to verify before relying on it during a real outage.

### Removing a server
Click the **Remove** button on any server card. The change is saved immediately.

---

## History

The **History** section of the dashboard shows the last 6h / 24h / 7d as a timeline (power, gateway and one row per server), a card per outage, and an event log. Data is kept in `history.jsonl` for 7 days.

The Pi has no battery, so during a power cut it is off and sees nothing. History fills that gap after the fact:

- **Power outages** – the app writes a heartbeat every 30s. After boot, if the Pi's boot time is later than the last heartbeat (and the app wasn't stopped cleanly), the gap is recorded as a power outage (start accurate to ±30s).
- **Reboot vs. deploy** – a clean stop (pm2 reload, `sudo reboot`) is not counted as an outage; an app-only restart is shown as "no data".
- **Did the servers shut down?** – 2 minutes after the gateway is back, each server is classified by comparing how long the gateway was unreachable with `SERVER_SHUTDOWN_AFTER_MIN` and whether it answers pings:

| Gateway down | Server reachable after | Verdict |
|---|---|---|
| ≥ shutdown time | no | Shut down – power failure |
| < shutdown time | yes | Stayed up on UPS |
| ≥ shutdown time | yes | Stayed up – expected shutdown (check the server's script) |
| < shutdown time | no | Down – not explained by outage |
| within 30s of the shutdown time | – | Uncertain |

  Gateway outages while the Pi has power (router reboot or fault) are assessed the same way.
- **Clock** – a Pi has no RTC, so after boot its clock is wrong until NTP syncs through the router. Events are held in memory and only written once `timedatectl` reports the clock synced (or after 10 minutes).

---

## How it works

```
Every 10s: ping each server
    │
    ├─ ONLINE  → mark green, start 5-min stability timer before resetting WoL cooldown
    │
    └─ FAIL    → run 9 confirmation pings (1/sec) → show "VERIFYING…"
                    │
                    ├─ any succeed → false alarm, back to ONLINE
                    │
                    └─ all fail → confirmed DOWN → check gateway
                                    │
                                    ├─ gateway ALIVE  → send WoL (60s cooldown)
                                    │
                                    └─ gateway DOWN   → power outage!
                                                         queue email alert
                                                         wait for gateway…
                                                         gateway UP → send email
```

---

## File structure

```
pi-network-guardian/
├── server.js          # Backend: monitoring logic, REST API, WebSocket, email
├── public/
│   └── index.html     # Frontend: real-time dashboard
├── deploy.sh          # Run on Pi to pull & reload: bash deploy.sh
├── events.js          # History: event log, heartbeat, power-outage detection
├── servers.json       # Auto-generated: persisted server list (git-ignored)
├── history.jsonl      # Auto-generated: 7 days of events (git-ignored)
├── heartbeat.json     # Auto-generated: last time the app was alive (git-ignored)
├── .env               # Your credentials (git-ignored)
├── .env.example       # Template — safe to commit
├── DEPLOY.md          # Full deployment guide
├── package.json
└── .gitignore
```

---

## Running on a Raspberry Pi (auto-start)

Use PM2 to keep the app running after reboots:

```bash
npm install -g pm2
pm2 start server.js --name pi-guardian
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

---

## License

MIT
