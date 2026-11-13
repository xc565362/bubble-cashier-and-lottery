#!/usr/bin/env bash
# cashier v2 monolith deploy — backend (cashier-v2) + frontend (cashier-ui-v2).
#
# Two modes:
#   MODE=staging (default)  safe playtest deploy; production untouched.
#                           backend: pm2 'bubble-cashier-v2' on :5176
#                           UI:      /statics/cashier-v2/  → https://bubble.moody-vip.com/cashier-v2/
#                           API:     build with VITE_API_BASE=/cashier-api-v2 → proxy to :5176 (nginx snippet printed at the end)
#                           data:    /var/lib/bubble-online-v2 + /etc/bubble/keys/online-v2.key (fresh, isolated)
#
#   MODE=prod               CUTOVER — replaces the old bubble-cashier service.
#                           backend: pm2 'bubble-cashier' on :5175 (old process deleted, old dir /root/bubble-cashier kept for rollback)
#                           UI:      /statics/cashier/  → https://bubble.moody-vip.com/cashier/ (existing nginx conf, unchanged)
#                           API:     default /cashier-api (existing proxy to :5175, unchanged)
#                           data:    /var/lib/bubble-online + /etc/bubble/keys/online.key (INHERITED — v2 reads the old service's data)
#
# Usage (from anywhere — script locates the repo root by itself):
#   ./scripts/deploy.sh                     # staging, interactive ssh password prompts
#   MODE=prod ./scripts/deploy.sh           # cutover
#   SSHPASS='…' ./scripts/deploy.sh         # password from env (requires sshpass)
#
# Optional overrides: SERVER=root@8.154.19.74 REMOTE_DIR=/root/bubble-cashier-v2
set -euo pipefail

MODE="${MODE:-staging}"
case "$MODE" in
  staging|prod) ;;
  *) echo "MODE must be 'staging' (default) or 'prod'"; exit 1 ;;
esac

SERVER="${SERVER:-root@8.154.19.74}"
REMOTE_DIR="${REMOTE_DIR:-/root/bubble-cashier-v2}"
DOMAIN="bubble.moody-vip.com"
PUBLIC_ORIGIN="https://$DOMAIN"

if [ "$MODE" = "staging" ]; then
  PM2_NAME="bubble-cashier-v2"; APP_PORT=5176; PREFLIGHT_PORT=5177
  API_PREFIX="/cashier-api-v2"; STATIC_NAME="cashier-v2"
  DATA_DIR="${DATA_DIR:-/var/lib/bubble-online-v2}"; KEY_FILE="${KEY_FILE:-/etc/bubble/keys/online-v2.key}"
else
  PM2_NAME="bubble-cashier"; APP_PORT=5175; PREFLIGHT_PORT=5177
  API_PREFIX="/cashier-api"; STATIC_NAME="cashier"
  DATA_DIR="${DATA_DIR:-/var/lib/bubble-online}"; KEY_FILE="${KEY_FILE:-/etc/bubble/keys/online.key}"
fi

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$(cd "$BACKEND_DIR/../cashier-ui-v2" && pwd)"
[ -d "$UI_DIR" ] || { echo "cashier-ui-v2 not found next to cashier-v2 ($UI_DIR)"; exit 1; }

SSH=(ssh -o StrictHostKeyChecking=accept-new)
RSYNC_SSH="ssh -o StrictHostKeyChecking=accept-new"
if [ -n "${SSHPASS:-}" ]; then
  command -v sshpass >/dev/null || { echo "SSHPASS set but sshpass not installed (brew install hudochenkov/sshpass/sshpass)"; exit 1; }
  SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new)
  RSYNC_SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
fi

# DB credentials: prefer the local .env.local, fall back to known values.
ENV_FILE="$BACKEND_DIR/.env.local"
db_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
DB_HOST="$(db_env DB_HOST)"; DB_HOST="${DB_HOST:-rm-bp1a7pt5mb5r9uuu7so.mysql.rds.aliyuncs.com}"
DB_PORT="$(db_env DB_PORT)"; DB_PORT="${DB_PORT:-3306}"
DB_NAME="$(db_env DB_NAME)"; DB_NAME="${DB_NAME:-gm_bubble_db}"
DB_USER="$(db_env DB_USER)"; DB_USER="${DB_USER:-gm_moody_db}"
DB_PASSWORD="$(db_env DB_PASSWORD)"; DB_PASSWORD="${DB_PASSWORD:-rFpW20gfh9vRHYrA}"

echo "==> 0/6  mode=$MODE  pm2=$PM2_NAME :$APP_PORT  ui=/statics/$STATIC_NAME/  api=$API_PREFIX"

DEPLOY_PATH="/$STATIC_NAME"
echo "==> 1/6  Building UI ($UI_DIR) with VITE_API_BASE=$API_PREFIX VITE_DEPLOY_PATH=$DEPLOY_PATH"
( cd "$UI_DIR" && VITE_API_BASE="$API_PREFIX" VITE_DEPLOY_PATH="$DEPLOY_PATH" npm run build )

echo "==> 2/6  Syncing backend $BACKEND_DIR -> $SERVER:$REMOTE_DIR"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude node_modules --exclude .env.local --exclude .git \
  --exclude dist --exclude public --exclude electron --exclude release \
  --exclude tests --exclude deployment --exclude docs --exclude '验证记录*' --exclude '使用说明*' \
  "$BACKEND_DIR/" "$SERVER:$REMOTE_DIR/"

echo "==> 3/6  Syncing UI dist -> $SERVER:/statics/$STATIC_NAME/ (via nginx container mount discovery)"
rsync -az --delete -e "$RSYNC_SSH" "$UI_DIR/dist/" "$SERVER:/tmp/cashier-ui-$STATIC_NAME/"

echo "==> 4/6  Remote: deps, env, pre-flight on :$PREFLIGHT_PORT"
"${SSH[@]}" "$SERVER" "MODE='$MODE' PM2_NAME='$PM2_NAME' REMOTE_DIR='$REMOTE_DIR' APP_PORT='$APP_PORT' PREFLIGHT_PORT='$PREFLIGHT_PORT' \
DATA_DIR='$DATA_DIR' KEY_FILE='$KEY_FILE' PUBLIC_ORIGIN='$PUBLIC_ORIGIN' \
DB_HOST='$DB_HOST' DB_PORT='$DB_PORT' DB_NAME='$DB_NAME' DB_USER='$DB_USER' DB_PASSWORD='$DB_PASSWORD' \
STATIC_NAME='$STATIC_NAME' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

# Runtime deps only (mysql2 + json-source-map) — the repo package.json also
# carries vite/react for the desktop build, which the server never runs.
cat > package.json <<'PKG'
{
  "name": "bubble-cashier-v2-server",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "json-source-map": "0.6.1",
    "mysql2": "^3.24.6"
  }
}
PKG
npm install --omit=dev --no-fund --no-audit

# Node >= 24: the login shell's `node` may be v18 while pm2 runs the nvm build.
NODE_BIN="$(command -v node)"
if [ "$( "$NODE_BIN" -e "process.stdout.write(process.versions.node.split('.')[0])" )" -lt 24 ] 2>/dev/null; then
  CAND="$(ls /root/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$CAND" ] && NODE_BIN="$CAND"
fi
echo "node: $("$NODE_BIN" -v) at $NODE_BIN"
"$NODE_BIN" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || { echo '!!! node >= 24 required but not found'; exit 1; }

# Data dir + encryption key (prod reuses the old service's key so existing
# encrypted wx secrets in the DB stay readable).
mkdir -p "$DATA_DIR" "$(dirname "$KEY_FILE")"
if [ "$MODE" = "staging" ] || [ ! -f "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || openssl rand -hex 32 > "$KEY_FILE"
fi
chmod 600 "$KEY_FILE" 2>/dev/null || true

# The handler realpath-syncs staticRoot (../dist) at boot; the real UI is
# served by nginx from the /var/www statics mounts, so a stub is enough.
mkdir -p dist
[ -f dist/index.html ] || printf '<!doctype html><meta charset="utf-8"><title>bubble-cashier-v2</title>The cashier UI is served by nginx at %s/cashier/.' "$PUBLIC_ORIGIN" > dist/index.html

# Env file (rewritten every deploy — single source of truth is this script).
umask 077
cat > .env.local <<ENV
PORT=$APP_PORT
# nginx reaches this service through the docker host gateway, so binding to
# loopback only breaks every proxy_pass after each redeploy.
HOST=${BIND_HOST:-0.0.0.0}
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
COUPON_ENV=production
BUBBLE_ONLINE_DATA_DIR=$DATA_DIR
BUBBLE_ONLINE_KEY_FILE=$KEY_FILE
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
ENV
chmod 600 .env.local

HOST_HEADER="${PUBLIC_ORIGIN#http://}"; HOST_HEADER="${HOST_HEADER#https://}"

echo "--- pre-flight on :$PREFLIGHT_PORT (any live service on :$APP_PORT untouched)"
# Preflight must NOT share the live data dir: the running service holds an
# exclusive lock on it and the probe would fail to boot.
rm -rf /tmp/cashier-v2-preflight-data
PORT="$PREFLIGHT_PORT" BUBBLE_ONLINE_DATA_DIR=/tmp/cashier-v2-preflight-data \
  nohup "$NODE_BIN" --env-file-if-exists="$REMOTE_DIR/.env.local" "$REMOTE_DIR/online/server.cjs" > /tmp/cashier-v2-preflight.log 2>&1 &
PRE=$!
sleep 4
OK=0
curl -s -m 5 -H "Host: $HOST_HEADER" "http://127.0.0.1:$PREFLIGHT_PORT/healthz" | grep -q '"ok":true' && OK=1
if [ "$OK" != "1" ]; then
  kill "$PRE" 2>/dev/null || true
  echo '!!! pre-flight healthz FAILED — last log lines:'
  tail -15 /tmp/cashier-v2-preflight.log
  echo '!!! nothing switched; old service (if any) untouched'
  exit 1
fi
# Deeper probe: the online session endpoint must answer 401 JSON (proves DB + auth wired).
curl -s -m 5 -o /dev/null -w 'session probe HTTP %{http_code}\n' -H "Host: $HOST_HEADER" "http://127.0.0.1:$PREFLIGHT_PORT/api/online/session"
kill "$PRE" 2>/dev/null || true
sleep 1

echo "--- publishing UI statics (/var/www/<name> -> container /statics/<name> via compose mounts)"
STATICS_HOST="${STATICS_HOST:-/var/www}"
mkdir -p "$STATICS_HOST/$STATIC_NAME"
rsync -az --delete "/tmp/cashier-ui-$STATIC_NAME/" "$STATICS_HOST/$STATIC_NAME/"
ls "$STATICS_HOST/$STATIC_NAME/" | head -5

# Compose mounts are per-path; a NEW statics folder needs its own volume line.
# (prod reuses the long-standing /var/www/cashier mount — skip there.)
if [ "$STATIC_NAME" != "cashier" ]; then
  COMPOSE_DIR="${COMPOSE_DIR:-/opt/1panel/apps/nginx-proxy-manager/nginx-proxy-manager}"
  CONTAINER_MOUNT="/statics/$STATIC_NAME"
  cd "$COMPOSE_DIR"
  if grep -q "$CONTAINER_MOUNT" docker-compose.yml; then
    echo "compose volume already present: $CONTAINER_MOUNT"
  else
    TS="$(date +%Y%m%d%H%M%S)"
    cp docker-compose.yml "docker-compose.yml.bak-$TS"
    awk -v vol="$STATICS_HOST/$STATIC_NAME:$CONTAINER_MOUNT" '
      /^[[:space:]]*- .*:\/statics\// { last = NR; lines[NR] = $0; indent = $0; sub(/- .*/, "", indent); next }
      { lines[NR] = $0 }
      END {
        if (!last) { print "!!! no :/statics/ volume anchor found in compose" > "/dev/stderr"; exit 3 }
        for (i = 1; i <= NR; i++) { print lines[i]; if (i == last) print indent "- " vol }
      }' "docker-compose.yml.bak-$TS" > docker-compose.yml
    echo "compose volume added (backup: docker-compose.yml.bak-$TS); recreating container"
    docker compose up -d
    sleep 4
    docker ps --format '{{.Names}}' | grep -qi nginx || {
      echo '!!! container down after recreate — rolling back compose'
      cp "docker-compose.yml.bak-$TS" docker-compose.yml
      docker compose up -d; sleep 4
      docker ps --format '{{.Names}}' | grep -qi nginx || { echo '!!! ROLLBACK FAILED — fix manually'; exit 1; }
      exit 1
    }
  fi
fi

echo "--- cutover: pm2 '$PM2_NAME' now runs $REMOTE_DIR on :$APP_PORT"
cd "$REMOTE_DIR"   # the compose step above changed directory; pm2 must resolve the script from here
if [ "$MODE" = "prod" ]; then
  pm2 delete bubble-cashier >/dev/null 2>&1 || true   # the 0.7.x service; its dir /root/bubble-cashier stays for rollback
fi
pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
pm2 start "$REMOTE_DIR/online/server.cjs" --name "$PM2_NAME" --interpreter "$NODE_BIN" --node-args "--env-file-if-exists=$REMOTE_DIR/.env.local"
pm2 save
sleep 2
curl -s -m 5 -H "Host: $HOST_HEADER" "http://127.0.0.1:$APP_PORT/healthz" | grep -q '"ok":true' || { echo '!!! post-cutover healthz FAILED'; tail -15 /root/.pm2/logs/"$PM2_NAME"-error.log; exit 1; }
echo "--- post-cutover healthz OK"
REMOTE

echo "==> 5/6  External checks via https://$DOMAIN"
curl -s -o /dev/null -w "UI  https://$DOMAIN/$STATIC_NAME/  HTTP %{http_code}\n" "https://$DOMAIN/$STATIC_NAME/"
curl -s -m 8 -o /dev/null -w "API https://$DOMAIN$( [ "$MODE" = staging ] && echo /cashier-api-v2 || echo /cashier-api )/online/session  HTTP %{http_code} (expect 401)\n" \
  "https://$DOMAIN$( [ "$MODE" = staging ] && echo /cashier-api-v2 || echo /cashier-api )/online/session"

echo "==> 6/6  Done."
if [ "$MODE" = "staging" ]; then
cat <<EOF

Deployed STAGING:
  UI    https://$DOMAIN/cashier-v2/
  API   https://$DOMAIN/cashier-api-v2/  (backend on :5176, pm2 '$PM2_NAME')

Add these blocks to the bubble.moody-vip.com nginx conf (then reload):
  location /cashier-v2/ {
      alias /statics/cashier-v2/;
      index index.html;
      try_files \$uri \$uri/ /cashier-v2/index.html;
  }
  location /cashier-api-v2/ {
      rewrite ^/cashier-api-v2(/.*)\$ /api\$1 break;
      proxy_pass http://172.18.0.1:5176;
      proxy_set_header Host \$host;
      proxy_set_header X-Forwarded-Proto https;
  }
  # public activity API used by every /huodong-<uuid>/ H5 (session + call):
  location /activity/ {
      proxy_pass http://172.18.0.1:5176;
      proxy_set_header Host \$host;
      proxy_set_header X-Forwarded-Proto https;
  }

Production is untouched. Cutover when approved:
  MODE=prod ./scripts/deploy.sh
Rollback (prod): pm2 delete bubble-cashier; cd /root/bubble-cashier && pm2 start online/server.cjs --name bubble-cashier --node-args "--env-file-if-exists=.env.local" && pm2 save
EOF
else
cat <<EOF

Deployed PROD (cutover complete):
  UI    https://$DOMAIN/cashier/       (nginx conf unchanged)
  API   https://$DOMAIN/cashier-api/   (:5175, pm2 '$PM2_NAME')
  Data  inherited: $DATA_DIR + $KEY_FILE (old service's key — existing encrypted config stays readable)

Add this block to the bubble.moody-vip.com nginx conf (the old backend had no /activity/ routes):
  # public activity API used by every /huodong-<uuid>/ H5 (session + call):
  location /activity/ {
      proxy_pass http://172.18.0.1:5175;
      proxy_set_header Host \$host;
      proxy_set_header X-Forwarded-Proto https;
  }

Old service: /root/bubble-cashier (dir kept, process stopped). Rollback:
  pm2 delete bubble-cashier; cd /root/bubble-cashier && pm2 start online/server.cjs --name bubble-cashier --node-args "--env-file-if-exists=.env.local" && pm2 save
EOF
fi
