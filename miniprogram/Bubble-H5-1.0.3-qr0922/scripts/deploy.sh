#!/usr/bin/env bash
# Build the H5 and push dist/ to the web server over SSH.
#
# Usage:
#   ./scripts/deploy.sh
#
# Fill in the three variables below (or export them before running):
#   DOMAIN      public HTTPS origin of the H5, e.g. h5.example.com
#   SSH_TARGET  user@host of the web server, e.g. deploy@203.0.113.10
#   REMOTE_DIR  nginx web root on the server, e.g. /var/www/bubble-h5
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${DOMAIN:-bubble.moody-vip.com}"
SSH_TARGET="${SSH_TARGET:-root@8.154.19.74}"
REMOTE_DIR="${REMOTE_DIR:-/root/bubble-huodongchik-h5}"

if [[ "$DOMAIN" == "h5.example.com" || "$SSH_TARGET" == *"your-server-ip"* ]]; then
  echo "ERROR: set DOMAIN and SSH_TARGET first (edit this script or export them)." >&2
  exit 1
fi

echo "==> Running tests"
npm test

echo "==> Building dist/"
npm run build

echo "==> Writing production runtime-config.js (apiBase=https://${DOMAIN}/huodong-api/bubble-h5)"
cat > dist/runtime-config.js <<EOF
window.BUBBLE_H5_CONFIG = Object.freeze({
  mode: 'production',
  apiBase: 'https://${DOMAIN}/huodong-api/bubble-h5',
  miniProgramLoginPage: '/pages/bubble-h5/index'
});
EOF

echo "==> Verifying preview.mjs is NOT in the upload bundle"
if [[ -f dist/preview.mjs ]]; then
  echo "ERROR: dist/preview.mjs must not be uploaded." >&2
  exit 1
fi

echo "==> Uploading dist/ to ${SSH_TARGET}:${REMOTE_DIR}/"
ssh "$SSH_TARGET" "mkdir -p '${REMOTE_DIR}'"
scp -r dist/. "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Done. Reminder: ${DOMAIN} must serve the WeChat MP_verify_*.txt file at domain root,"
echo "    and /api/bubble-h5/ must be proxied to the bubble-h5-gateway cloud function."
