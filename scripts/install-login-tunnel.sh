#!/bin/bash
# Install the user LaunchAgent that starts the Heir Studio tunnel at login.
# No sudo. Sleep-proofing is caffeinate inside scripts/tunnel.mjs, not pmset.
set -euo pipefail

LABEL="ai.heir.studio.tunnel"
ROOT="/Users/futjr/grok-studio"
SRC="${ROOT}/scripts/macos/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
SERVICE="${DOMAIN}/${LABEL}"

if [ ! -f "$SRC" ]; then
  echo "missing plist template: $SRC" >&2
  exit 1
fi
if [ ! -x "${ROOT}/scripts/macos/tunnel-login.sh" ]; then
  echo "wrapper is not executable: ${ROOT}/scripts/macos/tunnel-login.sh" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "$SRC" "$DEST"
chmod 644 "$DEST"

if ! plutil -lint "$DEST" >/dev/null; then
  echo "installed plist failed plutil -lint: $DEST" >&2
  exit 1
fi

bootout() {
  launchctl bootout "$SERVICE" 2>/dev/null \
    || launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null \
    || launchctl unload "$DEST" 2>/dev/null \
    || true
}

bootstrap() {
  if launchctl bootstrap "$DOMAIN" "$DEST"; then
    return 0
  fi
  echo "launchctl bootstrap failed; falling back to launchctl load"
  launchctl load -w "$DEST"
}

bootout
bootstrap
launchctl enable "$SERVICE" 2>/dev/null || true

echo "Installed ${LABEL}"
echo "  plist  ${DEST}"
echo "  logs   ${HOME}/Library/Logs/heir-studio-tunnel.log"
echo "  undo   ${ROOT}/scripts/uninstall-login-tunnel.sh"
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "  state  loaded in ${DOMAIN}"
else
  echo "  state  plist written; launchctl print ${SERVICE} failed (will load at next login)" >&2
fi
