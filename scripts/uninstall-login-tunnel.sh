#!/bin/bash
# Remove the user LaunchAgent that starts the Heir Studio tunnel at login.
# Does not stop a tunnel that was started by hand (npm run tunnel).
set -euo pipefail

LABEL="ai.heir.studio.tunnel"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
SERVICE="${DOMAIN}/${LABEL}"

launchctl bootout "$SERVICE" 2>/dev/null \
  || launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null \
  || launchctl unload "$DEST" 2>/dev/null \
  || true

if [ -f "$DEST" ]; then
  rm -f "$DEST"
  echo "Removed ${DEST}"
else
  echo "No plist at ${DEST}"
fi

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "warning: ${SERVICE} is still loaded" >&2
  exit 1
fi

echo "Uninstalled ${LABEL}"
