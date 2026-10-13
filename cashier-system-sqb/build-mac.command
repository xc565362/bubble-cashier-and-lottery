#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "Please install Node.js, then run this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
if ! node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"; then
  echo "Please install Node.js 24 LTS or newer, then run this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
npm ci
npm test
npm run dist:mac
open release
read -r -p "Build complete. Press Enter to close..."
