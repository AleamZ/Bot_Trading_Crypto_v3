#!/usr/bin/env bash
# Updates and restarts bot v3 on the VPS (docs/DEPLOY.md):
#   bash deploy.sh    pull, install, check, build, restart, wait for /health/ready, then publish the web
#                     UI to DEPLOY_WEB_ROOT from .env (or WEB_ROOT=...); it can be rebuilt from git, so no backup
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="${APP_NAME:-bot-v3}"

# A Node from nvm (if installed) wins over the system one.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi
node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 13)) { console.error(`Bot v3 cần Node.js 22.13+, đang có ${process.versions.node} (xem docs/DEPLOY.md)`); process.exit(1); }'
export BOT_V3_NODE="$(command -v node)"

if [ ! -f .env ]; then
  echo "Chưa có .env: cp .env.example .env rồi điền (docs/DEPLOY.md)" >&2
  exit 1
fi
PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2 | tr -d '[:space:]' || true)"
PORT="${PORT:-8787}"
WEB_ROOT="${WEB_ROOT:-$(grep -E '^DEPLOY_WEB_ROOT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)}"

echo "==> git pull"
git pull --ff-only
echo "==> npm ci"
npm ci
echo "==> typecheck"
npm run typecheck
echo "==> test"
npm test
echo "==> build"
npm run build

echo "==> pm2 ($APP_NAME, node $(node -v), port $PORT)"
mkdir -p logs/bot-v3
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --only "$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --only "$APP_NAME"
fi
pm2 save >/dev/null

echo "==> chờ /health/ready"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health/ready"; then
    ready=1
    echo
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "Bot không trả lời http://127.0.0.1:$PORT/health/ready. Xem: pm2 logs $APP_NAME --lines 100" >&2
  exit 1
fi

if [ -n "${WEB_ROOT:-}" ]; then
  # The folder is emptied before the copy: refuse anything that is not a real, nested web folder.
  case "$WEB_ROOT" in
    /var/www/?*) ;;
    *) echo "DEPLOY_WEB_ROOT phải nằm trong /var/www/ (đang là '$WEB_ROOT'), không chép giao diện" >&2; exit 1 ;;
  esac
  if [ ! -d "$WEB_ROOT" ]; then
    echo "Không có thư mục $WEB_ROOT, không chép giao diện" >&2
    exit 1
  fi
  echo "==> chép giao diện mới vào $WEB_ROOT"
  rm -rf "${WEB_ROOT:?}"/*
  cp -r apps/web/dist/. "$WEB_ROOT/"
fi

echo "==> xong"
pm2 status "$APP_NAME"
