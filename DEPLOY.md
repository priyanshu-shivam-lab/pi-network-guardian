# Deployment Guide – GitHub Actions + PM2 on Raspberry Pi

This guide walks you through setting up automatic deployment so every `git push` to `main` automatically updates the app running on your Pi.

## Architecture

```
Your machine          GitHub              Raspberry Pi
──────────────        ──────────          ────────────────────────────
git push ──────────►  triggers workflow ──► self-hosted runner pulls code
                                            npm ci
                                            pm2 reload pi-guardian
```

> The Pi acts as both the **deployment target** AND the **GitHub Actions runner**.
> GitHub never needs to reach into your private network — the Pi reaches out to GitHub.

---

## Step 1 — Install Node.js and PM2 on the Pi

SSH into your Pi, then run:

```bash
# Install Node.js (LTS) via nvm – recommended
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts

# Verify
node -v && npm -v

# Install PM2 globally
npm install -g pm2
```

---

## Step 2 — Clone the repo on the Pi

```bash
cd ~
git clone https://github.com/YOUR_USERNAME/pi-server-monitor.git
cd pi-server-monitor

# Create your .env file (this is gitignored and stays only on the Pi)
cp .env.example .env
nano .env          # fill in GATEWAY_IP, SMTP credentials, ADMIN_EMAIL
```

---

## Step 3 — First manual start with PM2

```bash
cd ~/pi-server-monitor
npm ci --omit=dev
pm2 start server.js --name pi-guardian
pm2 save

# Make PM2 start automatically on boot
pm2 startup
# Copy and run the command it prints (something like: sudo env PATH=... pm2 startup systemd ...)
```

Verify it's running:

```bash
pm2 show pi-guardian
# open http://<pi-ip>:3000 in your browser
```

---

## Step 4 — Install the GitHub Actions self-hosted runner on the Pi

1. Go to your GitHub repo → **Settings** → **Actions** → **Runners** → **New self-hosted runner**
2. Select **Linux** / **ARM64** (for Pi 4/5) or **ARM** (for Pi 3 and older)
3. Run the commands GitHub shows you on the Pi — they look like:

```bash
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-arm64-2.x.x.tar.gz -L https://github.com/actions/runner/releases/download/...
tar xzf ./actions-runner-linux-arm64-2.x.x.tar.gz
./config.sh --url https://github.com/YOUR_USERNAME/pi-server-monitor --token YOUR_TOKEN
```

4. Install as a **system service** so it survives reboots:

```bash
sudo ./svc.sh install
sudo ./svc.sh start

# Check it's running
sudo ./svc.sh status
```

The runner will now appear as **Online** in your GitHub repo's Runners settings page.

---

## Step 5 — Set the APP_DIR repository variable

The workflow uses `${{ vars.APP_DIR }}` to know where the app lives on the Pi.

1. Go to your GitHub repo → **Settings** → **Variables** → **Actions** → **New repository variable**
2. Name: `APP_DIR`
3. Value: `/home/pi/pi-server-monitor` (or wherever you cloned it)

---

## Step 6 — Push and watch it deploy

```bash
# On your dev machine
git add .
git commit -m "chore: initial deployment setup"
git push origin main
```

Go to your GitHub repo → **Actions** tab → watch the workflow run in real time.

A successful run looks like:

```
✅ Pull latest code        – 2s
✅ Install dependencies    – 8s
✅ Restart app with PM2    – 2s
✅ Health check            – 4s
```

---

## What stays on the Pi (never in git)

| File | Why it's not in git |
|---|---|
| `.env` | Contains SMTP password and network config |
| `servers.json` | Contains your local server IPs and MACs |

These files are listed in `.gitignore`. The workflow uses `git pull` (not `git checkout`) so they are **never touched** by deployments.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Runner shows **Offline** in GitHub | SSH into Pi, run `sudo ./svc.sh status` in the `actions-runner` dir |
| `pm2: command not found` in workflow | PM2 isn't on PATH for the runner user. Add `export PATH="$HOME/.nvm/versions/node/.../bin:$PATH"` to `~/.bashrc` and `~/.profile`, then restart the runner service |
| Deployment runs but app doesn't update | Make sure `APP_DIR` variable points to the correct directory |
| `git pull` fails with merge conflict | On Pi: `git reset --hard origin/main` then push again to retrigger |
| Port 3000 not accessible from LAN | Make sure the Pi's firewall allows port 3000: `sudo ufw allow 3000` |

---

## Quick reference

```bash
# Check app status on Pi
pm2 show pi-guardian

# View live logs
pm2 logs pi-guardian

# Restart manually
pm2 restart pi-guardian

# View runner logs
sudo journalctl -u actions.runner.* -f
```
