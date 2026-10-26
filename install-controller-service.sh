#!/bin/bash
# Install the controller as a user service and start it. Agent sandboxes can
# reach a listener on the host's loopback but cannot start one, so the
# controller has to be running before any agent asks for a context. The
# service manager also makes it a singleton, which is what keeps one browser
# and one context registry per machine.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"

if [[ "$(uname -s)" == "Darwin" ]]; then
  LABEL=com.browser-swarm.controller
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/src/controller.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/controller.log</string>
  <key>StandardErrorPath</key><string>$DIR/controller.log</string>
</dict>
</plist>
PLIST_BODY
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST"
  echo "installed $PLIST"
  exit 0
fi

UNIT="$HOME/.config/systemd/user/browser-swarm.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT_BODY
[Unit]
Description=BrowserSwarm controller

[Service]
ExecStart=$NODE $DIR/src/controller.ts
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT_BODY
systemctl --user daemon-reload
systemctl --user enable browser-swarm.service
systemctl --user restart browser-swarm.service
echo "installed $UNIT"
