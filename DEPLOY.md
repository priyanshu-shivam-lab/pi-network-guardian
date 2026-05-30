# Deployment Guide – PM2 on Raspberry Pi 4

This guide sets up the app as a managed background service on your Pi using **PM2**.
Deployments are manual: you `git push` from your dev machine, then SSH into the Pi and run `bash deploy.sh`.

## Architecture

```
Your machine              Raspberry Pi 4 (1 GB RAM)
──────────────            ──────────────────────────────
git push origin main      SSH into Pi
                          bash deploy.sh
                            │
                            ├── git pull origin main
                            ├── npm ci --omit=dev
                            └── pm2 reload pi-guardian
```

### Approximate idle RAM usage

| Process | RAM |
|---|---|
| Node.js app (server.js) | ~50–80 MB |
| PM2 daemon | ~30–50 MB |
| **Total** | **~80–130 MB** |

This leaves ~870 MB free for the OS and other tasks — comfortable on a 1 GB Pi 4.

---

## One-time setup on the Pi

### Step 1 — Install Node.js via nvm

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

# Install Node.js LTS
nvm install --lts
nvm use --lts

# Verify
node -v   # should print v20.x.x or higher
npm -v
```

### Step 2 — Install PM2 globally

```bash
npm install -g pm2
pm2 --version   # verify install
```

### Step 3 — Clone the repository

```bash
cd ~
git clone https://github.com/YOUR_USERNAME/pi-server-monitor.git
cd pi-server-monitor
```

### Step 4 — Create your .env file

```bash
cp .env.example .env
nano .env
```

Fill in all the values:

```dotenv
GATEWAY_IP=192.168.1.1        # your router IP
PORT=3000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password   # Gmail App Password
ADMIN_EMAIL=admin@yourdomain.com
```

> **Never commit `.env`** — it is already listed in `.gitignore`.

### Step 5 — Install dependencies

```bash
npm ci --omit=dev
```

### Step 6 — Start the app with PM2

```bash
pm2 start server.js --name pi-guardian
pm2 save
```

Check it's running:

```bash
pm2 show pi-guardian
# Open http://<pi-ip-address>:3000 in your browser
```

### Step 7 — Enable PM2 on boot

This ensures the app restarts automatically if the Pi reboots (e.g. after a power cut):

```bash
pm2 startup
```

PM2 will print a command like:

```
sudo env PATH=$PATH:/home/pi/.nvm/versions/node/v20.x.x/bin pm2 startup systemd -u pi --hp /home/pi
```

**Copy and run that exact command**, then:

```bash
pm2 save   # save current process list so it's restored on boot
```

---

## Deploying updates

Whenever you push new code to GitHub, SSH into the Pi and run:

```bash
cd ~/pi-server-monitor
bash deploy.sh
```

The script does three things:
1. `git pull origin main` — fetches your latest code
2. `npm ci --omit=dev` — updates dependencies if `package-lock.json` changed
3. `pm2 reload pi-guardian` — **zero-downtime** reload (the old process keeps serving until the new one is ready)

---

## Daily operations reference

```bash
# View live logs
pm2 logs pi-guardian

# Check status
pm2 show pi-guardian

# Restart (hard restart, brief downtime)
pm2 restart pi-guardian

# Reload (zero-downtime, preferred)
pm2 reload pi-guardian

# Stop
pm2 stop pi-guardian

# View all running processes and RAM usage
pm2 list

# Monitor CPU + RAM in real time
pm2 monit
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| App not accessible from browser | Check port: `pm2 show pi-guardian` confirms it's `online`. Check firewall: `sudo ufw allow 3000` |
| App crashes on startup | Check logs: `pm2 logs pi-guardian --lines 50` |
| App doesn't restart after reboot | Re-run `pm2 startup`, copy the printed command, run it, then `pm2 save` |
| `git pull` fails (merge conflict) | `git reset --hard origin/main` — caution: discards any local changes |
| `npm ci` fails | Delete `node_modules/` and retry: `rm -rf node_modules && npm ci --omit=dev` |
| `.env` overwritten by pull | It won't be — `.env` is gitignored and `git pull` never touches gitignored files |
| `servers.json` lost after pull | Same as above — gitignored, safe |
