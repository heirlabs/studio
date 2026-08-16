#!/bin/bash
# LaunchAgent Program for ai.heir.studio.tunnel.
# Starts the named Cloudflare tunnel at login. Does not start a second
# server if the Studio port is already listening.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

# Interactive shells load nvm via .zshrc; login items do not.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

ROOT="/Users/futjr/grok-studio"
cd "$ROOT"

if [ -f "$ROOT/.env.tunnel" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.tunnel"
  set +a
fi

PORT="${HEIR_STUDIO_PORT:-3847}"
stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$(stamp) Heir Studio already listening on ${PORT}; not starting a second server"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "$(stamp) npm not found on PATH=${PATH}" >&2
  exit 1
fi

echo "$(stamp) starting npm run tunnel (named tunnel via .env.tunnel)"
exec npm run tunnel
