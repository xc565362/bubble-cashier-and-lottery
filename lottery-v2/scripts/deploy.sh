#!/usr/bin/env bash
# lottery-v2 STATIC-ONLY per-activity deploy — docker-compose + exact-location topology.
#
# Server layout (nginx runs in the docker compose project at
# /opt/1panel/apps/nginx-proxy-manager/nginx-proxy-manager):
#   1. host origin dir : /root/bubble-statics/huodong-<uuid>/   (plain host filesystem, created here)
#   2. compose volume  : - /root/bubble-statics/huodong-<uuid>:/data/huodong-<uuid>
#                        added to docker-compose.yml, `docker compose up -d` recreates the container
#   3. nginx conf      : root-based locations in the bubble.moody-vip.com server block:
#                          location = /huodong-<uuid>   { return 301 /huodong-<uuid>/; }
#                          location /huodong-<uuid>/    { root /data; index index.html;
#                              try_files $uri $uri/ /huodong-<uuid>/index.html; types {...} }
#                        `root /data` maps /huodong-<uuid>/x -> /data/huodong-<uuid>/x exactly
#                        (the volume mount); unlike alias+try_files it is immune to the
#                        nginx alias/ticket-#97 internal-redirection-cycle failure.
#
# Every file edit is backed up (.bak-<timestamp>) and verified; on container or
# `nginx -t` failure the backup is restored automatically before the script exits.
#
# Usage (from the repo root or this folder — script locates itself):
#   ./scripts/deploy.sh <ACTIVITY_UUID>
#   ACTIVITY_ID=<ACTIVITY_UUID> ./scripts/deploy.sh
#   SSHPASS='…' ./scripts/deploy.sh <ACTIVITY_UUID>   # password from env (requires sshpass)
#   DRY_RUN=1 ./scripts/deploy.sh <ACTIVITY_UUID>      # print the full plan, no ssh/rsync
#
# Optional overrides: SERVER=root@8.154.19.74  DOMAIN=bubble.moody-vip.com
#                     HOST_DIR=/root/bubble-statics COMPOSE_DIR=/opt/1panel/apps/nginx-proxy-manager/nginx-proxy-manager
set -euo pipefail

DOMAIN="${DOMAIN:-bubble.moody-vip.com}"
SERVER="${SERVER:-root@8.154.19.74}"
HOST_DIR="${HOST_DIR:-/root/bubble-statics}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/1panel/apps/nginx-proxy-manager/nginx-proxy-manager}"

ACTIVITY_ID="${1:-${ACTIVITY_ID:-}}"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if [ -z "$ACTIVITY_ID" ]; then
  echo "错误 / ERROR: 缺少活动 ID。用法: ./scripts/deploy.sh <ACTIVITY_UUID>（或 ACTIVITY_ID=<uuid> ./scripts/deploy.sh）" >&2
  exit 1
fi
if ! [[ "$ACTIVITY_ID" =~ $UUID_RE ]]; then
  echo "错误 / ERROR: 活动 ID '$ACTIVITY_ID' 不是合法的 36 位 UUID（例: 3f6f8a24-9f7c-4b1e-8a2d-5e9c0d1b2a34）。/ Not a valid 36-char UUID." >&2
  exit 1
fi
ACTIVITY_ID="$(echo "$ACTIVITY_ID" | tr 'A-F' 'a-f')"
PUBLIC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../public" && pwd)"

ORIGIN_DIR="$HOST_DIR/huodong-$ACTIVITY_ID"                 # host-side origin folder
CONTAINER_DIR="/data/huodong-$ACTIVITY_ID"                  # path INSIDE the container
WEB_URL="https://$DOMAIN/huodong-$ACTIVITY_ID/?a=$ACTIVITY_ID"

NGINX_BLOCK="    location = /huodong-$ACTIVITY_ID {
        return 301 /huodong-$ACTIVITY_ID/;
    }
    location /huodong-$ACTIVITY_ID/ {
        root /data;
        index index.html;
        try_files \$uri \$uri/ /huodong-$ACTIVITY_ID/index.html;
        types {
            text/html                             html;
            application/javascript                js mjs;
            text/css                              css;
            image/svg+xml                         svg;
            application/manifest+json             webmanifest;
            application/json                      json;
        }
    }"

SSH=(ssh -o StrictHostKeyChecking=accept-new)
RSYNC_SSH="ssh -o StrictHostKeyChecking=accept-new"
if [ -n "${SSHPASS:-}" ]; then
  command -v sshpass >/dev/null || { echo "SSHPASS set but sshpass not installed (brew install hudochenkov/sshpass/sshpass)"; exit 1; }
  SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new)
  RSYNC_SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  cat <<EOF
[DRY_RUN] 活动 / activity : $ACTIVITY_ID
[DRY_RUN] 1. mkdir -p + rsync:
     rsync -az --delete "$PUBLIC_DIR/" "$SERVER:$ORIGIN_DIR/"
[DRY_RUN] 2. docker-compose volume (if not already present) in $COMPOSE_DIR/docker-compose.yml:
     - $ORIGIN_DIR:$CONTAINER_DIR
   then: cd $COMPOSE_DIR && docker compose up -d   (recreates the container; rollback on failure)
[DRY_RUN] 3. nginx exact location in the $DOMAIN server block (if not already present):
$NGINX_BLOCK
   then: docker exec <nginx> nginx -t && nginx -s reload   (conf backup + rollback on failure)
[DRY_RUN] 4. curl check: https://$DOMAIN/huodong-$ACTIVITY_ID/ expects 200
[DRY_RUN] webview: $WEB_URL
EOF
  exit 0
fi

echo "==> 1/5  Syncing $PUBLIC_DIR/ -> $SERVER:$ORIGIN_DIR/"
"${SSH[@]}" "$SERVER" "mkdir -p '$ORIGIN_DIR'"
rsync -az --delete -e "$RSYNC_SSH" "$PUBLIC_DIR/" "$SERVER:$ORIGIN_DIR/"

echo "==> 2/5  Remote: compose volume + container recreate (with backup/rollback)"
"${SSH[@]}" "$SERVER" "ORIGIN_DIR='$ORIGIN_DIR' CONTAINER_DIR='$CONTAINER_DIR' COMPOSE_DIR='$COMPOSE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$COMPOSE_DIR"
COMPOSE="$COMPOSE_DIR/docker-compose.yml"
[ -f "$COMPOSE" ] || { echo "!!! docker-compose.yml not found at $COMPOSE"; exit 1; }
NGINX_CID() { docker ps --format '{{.Names}}' | grep -i nginx | head -1; }
TS="$(date +%Y%m%d%H%M%S)"

if grep -q "$CONTAINER_DIR" "$COMPOSE"; then
  echo "volume already in compose: $CONTAINER_DIR"
else
  cp "$COMPOSE" "$COMPOSE.bak-$TS"
  # Insert the volume line after the LAST existing /data/ mount, reusing that
  # line's OWN indentation (the compose file's volumes list may not use the
  # 4-space indent this script originally assumed — a wrong indent produces
  # "yaml: did not find expected key" and breaks the whole stack).
  awk -v origin="$ORIGIN_DIR" -v target="$CONTAINER_DIR" '
    { lines[NR] = $0 }
    /^[[:space:]]*- [^:]+:\/data\// { last = NR; indent = $0; sub(/- .*/, "", indent) }
    END {
      if (!last) { print "!!! no existing :/data/ volume line found to anchor the insert" > "/dev/stderr"; exit 3 }
      for (i = 1; i <= NR; i++) { print lines[i]; if (i == last) print indent "- " origin ":" target }
    }' "$COMPOSE.bak-$TS" > "$COMPOSE"
  echo "compose updated (backup: $COMPOSE.bak-$TS):"
  grep -n "$CONTAINER_DIR" "$COMPOSE"
  BEFORE="$(NGINX_CID)"
  docker compose up -d
  sleep 4
  AFTER="$(NGINX_CID)"
  if ! docker ps --format '{{.Names}}' | grep -qi nginx; then
    echo '!!! container failed after recreate — rolling back compose'
    cp "$COMPOSE.bak-$TS" "$COMPOSE"
    docker compose up -d
    sleep 4
    docker ps --format '{{.Names}}' | grep -qi nginx || { echo '!!! ROLLBACK FAILED — container still down, fix manually'; exit 1; }
    echo 'rollback done, container back up — aborting deploy'
    exit 1
  fi
  echo "container recreated: ${BEFORE:-none} -> $AFTER"
fi
CID="$(NGINX_CID)"
[ -n "$CID" ] || { echo '!!! no nginx container running'; exit 1; }
docker exec "$CID" test -f "$CONTAINER_DIR/index.html" || { echo "!!! $CONTAINER_DIR/index.html not visible inside the container — volume mapping failed"; exit 1; }
echo "verified inside container: $CONTAINER_DIR/index.html"
REMOTE

echo "==> 3/5  Remote: exact nginx location (with conf backup/rollback)"
"${SSH[@]}" "$SERVER" "ACTIVITY_ID='$ACTIVITY_ID' CONTAINER_DIR='$CONTAINER_DIR' DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
set -euo pipefail
COMPOSE_DIR="$(dirname "$(find /opt/1panel/apps/nginx-proxy-manager -maxdepth 3 -name docker-compose.yml | head -1)")"
CONF_DIR="$COMPOSE_DIR/data/data/nginx/proxy_host"
CID="$(docker ps --format '{{.Names}}' | grep -i nginx | head -1)"
[ -n "$CID" ] || { echo '!!! no nginx container running'; exit 1; }
CONF="$(grep -l "server_name $DOMAIN;" "$CONF_DIR"/* 2>/dev/null | head -1)"
[ -n "$CONF" ] || { echo "!!! no nginx conf for $DOMAIN in $CONF_DIR"; exit 1; }
echo "nginx conf: $CONF"

if grep -q "location = /huodong-$ACTIVITY_ID" "$CONF"; then
  echo "exact location already present for /huodong-$ACTIVITY_ID"
else
  TS="$(date +%Y%m%d%H%M%S)"
  cp "$CONF" "$CONF.bak-$TS"
  BLOCK_FILE="$(mktemp)"
  cat > "$BLOCK_FILE" <<BLOCK
    location = /huodong-$ACTIVITY_ID {
        return 301 /huodong-$ACTIVITY_ID/;
    }
    location /huodong-$ACTIVITY_ID/ {
        root /data;
        index index.html;
        try_files \$uri \$uri/ /huodong-$ACTIVITY_ID/index.html;
        types {
            text/html                             html;
            application/javascript                js mjs;
            text/css                              css;
            image/svg+xml                         svg;
            application/manifest+json             webmanifest;
            application/json                      json;
        }
    }
BLOCK
  awk -v blockfile="$BLOCK_FILE" '
    /^[[:space:]]*location \/ \{/ && !done {
      while ((getline line < blockfile) > 0) print line
      close(blockfile)
      done = 1
    }
    { print }
    END { if (!done) { print "!!! could not find \"location / {\" — no insert performed" > "/dev/stderr"; exit 3 } }' "$CONF.bak-$TS" > "$CONF"
  rm -f "$BLOCK_FILE"
  echo "conf updated (backup: $CONF.bak-$TS)"
fi

if docker exec "$CID" nginx -t 2>&1 | tail -2; then
  docker exec "$CID" nginx -s reload
  echo '--- nginx reloaded'
else
  echo '!!! nginx -t FAILED — restoring conf backup'
  LATEST_BAK="$(ls -t "$CONF".bak-* 2>/dev/null | head -1)"
  [ -n "$LATEST_BAK" ] && cp "$LATEST_BAK" "$CONF"
  docker exec "$CID" nginx -t && docker exec "$CID" nginx -s reload
  echo 'conf restored and reloaded — fix the block manually'
  exit 1
fi
REMOTE

echo "==> 4/5  Local check: https://$DOMAIN/huodong-$ACTIVITY_ID/ expects 200"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/huodong-$ACTIVITY_ID/" || true)"
echo "huodong-$ACTIVITY_ID/ HTTP $HTTP_CODE"
[ "$HTTP_CODE" = "200" ] || { echo '!!! non-200 — inspect the nginx conf block and container mounts above'; exit 1; }

echo "==> 5/5  Webview 入口"
cat <<EOF
活动 H5 地址（小程序 webview 打开）:
  $WEB_URL
--- 部署完成 / deploy done.
EOF
