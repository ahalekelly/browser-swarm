#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${1:-$ROOT/shared-browser.sh}"
NODE="$(command -v node)"
TEMP_ROOT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "${TEMP_ROOT%/}/browser-swarm-test.XXXXXX")"
SCRIPT="$TEMP_DIR/shared-browser.sh"
PORT="$($NODE -e "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });")"
LABEL_PREFIX="com.lancelotlabs.browser-swarm.$PORT."

cleanup() {
  "$SCRIPT" stop > /dev/null 2>&1 || true
  for label in $(launchctl print "gui/$(id -u)" | awk -v prefix="$LABEL_PREFIX" 'index($3, prefix) == 1 { print $3 }'); do
    launchctl remove "$label"
  done
  trash "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TEMP_DIR/fingerprint-chromium/Chromium.app/Contents/MacOS"
cp "$SOURCE" "$SCRIPT"
cp "$ROOT/tests/fixtures/fake-browser.js" "$TEMP_DIR/fake-browser.js"
sed -e "s|__NODE__|$NODE|g" -e "s|__FAKE_BROWSER__|$TEMP_DIR/fake-browser.js|g" \
  "$ROOT/tests/fixtures/fake-chromium.sh" > "$TEMP_DIR/fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium"
sed -i '' "s/^PORT=9377$/PORT=$PORT/" "$SCRIPT"
chmod +x "$SCRIPT" "$TEMP_DIR/fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium"

wait_for_port() {
  for _ in $(seq 1 40); do
    curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" > /dev/null && return
    sleep 0.1
  done
  return 1
}

wait_for_closed_port() {
  for _ in $(seq 1 40); do
    curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" > /dev/null || return 0
    sleep 0.1
  done
  return 1
}

"$SCRIPT" start &
first_start=$!
"$SCRIPT" start &
second_start=$!
wait "$first_start"
wait "$second_start"
test "$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | sort -u | wc -l | tr -d ' ')" = 1

browser_pid="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)"
kill "$browser_pid"
wait_for_closed_port
grep -q '^running ' "$TEMP_DIR/daemon-state"

"$NODE" "$ROOT/tests/fixtures/kill-launcher-descendants.js" "$SCRIPT"
wait_for_port

browser_pid="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)"
wrapper_pid="$(ps -o ppid= -p "$browser_pid" | tr -d ' ')"
test "$(ps -o ppid= -p "$wrapper_pid" | tr -d ' ')" = 1
pgrep -f "$SCRIPT watchdog $browser_pid" > /dev/null

"$SCRIPT" ensure
"$SCRIPT" stop
wait_for_closed_port
test "$(cat "$TEMP_DIR/daemon-state")" = clean

echo "crash recovery survives launcher descendant cleanup"
