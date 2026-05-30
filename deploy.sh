#!/bin/bash
# deploy.sh
# Run this on the Pi whenever you want to pull the latest code and restart the app.
# Usage: bash deploy.sh

set -e  # exit immediately if any command fails

# Resolve the directory this script lives in (works from anywhere)
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "========================================"
echo "  Pi Network Guardian – Deploy Script"
echo "========================================"
echo ""

# 1. Pull latest code from git
echo "📥 Pulling latest code..."
git -C "$APP_DIR" pull origin master

# 2. Install / update dependencies (skip devDependencies)
echo ""
echo "📦 Installing dependencies..."
npm ci --omit=dev --prefix "$APP_DIR"

# 3. Reload PM2 (zero-downtime) or start fresh if not yet running
echo ""
echo "♻️  Reloading app with PM2..."
if pm2 describe pi-guardian > /dev/null 2>&1; then
    pm2 reload pi-guardian
else
    echo "App not running yet – starting for the first time..."
    pm2 start "$APP_DIR/server.js" --name pi-guardian
fi

# 4. Persist PM2 process list so it survives reboots
pm2 save

echo ""
echo "✅ Deployment complete!"
echo ""
pm2 show pi-guardian
