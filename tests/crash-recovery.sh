#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
TEMP_ROOT="${TMPDIR:?TMPDIR must be set}"
TEMP_DIR="$(mktemp -d "${TEMP_ROOT%/}/browser-swarm-test.XXXXXX")"
SCRIPT="$TEMP_DIR/shared-browser.sh"
PORT="$("$NODE" -e "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });")"
FOREIGN_PID=""

fail() { echo "ERROR: $*" >&2; exit 1; }

cleanup() {
  if [ -n "$FOREIGN_PID" ]; then
    kill "$FOREIGN_PID" 2> /dev/null || true
    wait "$FOREIGN_PID" 2> /dev/null || true
  fi
  "$SCRIPT" stop > /dev/null 2>&1 || true
  if [ -s "$TEMP_DIR/fingerprint-seed" ]; then
    label="com.lancelotlabs.browser-swarm.$PORT.$(cat "$TEMP_DIR/fingerprint-seed")"
    launchctl bootout "gui/$(id -u)/$label" > /dev/null 2>&1 || true
  fi
  trash "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TEMP_DIR/fingerprint-chromium/Chromium.app/Contents/MacOS"
cp "$ROOT/shared-browser.sh" "$SCRIPT"
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

profile_pids() {
  local pid profile="$TEMP_DIR/fingerprint-browser-profile"
  for pid in $(pgrep -f "user-data-dir=$profile" || true); do
    ps -o command= -p "$pid" 2> /dev/null | grep -qF -- "--user-data-dir=$profile" && echo "$pid"
  done
}

job_loaded() { launchctl print "$SERVICE" > /dev/null 2>&1; }

job_state() {
  launchctl print "$SERVICE" | awk '$1 == "state" && $2 == "=" { print substr($0, index($0, "=") + 2); exit }'
}

job_runs() { launchctl print "$SERVICE" | awk '$1 == "runs" { print $3; exit }'; }

"$SCRIPT" start &
first_start=$!
"$SCRIPT" start &
second_start=$!
wait "$first_start"
wait "$second_start"
test "$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | sort -u | wc -l | tr -d ' ')" = 1

LABEL="com.lancelotlabs.browser-swarm.$PORT.$(cat "$TEMP_DIR/fingerprint-seed")"
SERVICE="gui/$(id -u)/$LABEL"

# A wrapper failure after more than ten healthy seconds must end the whole
# process group once, without either a restart or orphaned child.
sleep 11
browser_pid="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)"
wrapper_pid="$(ps -o ppid= -p "$browser_pid" | tr -d ' ')"
ps -o command= -p "$wrapper_pid" | grep -qF -- "$SCRIPT daemon" || fail "refusing to kill an unexpected browser parent"
kill -9 "$wrapper_pid"
wait_for_closed_port
test "$(job_state)" = "not running"
test "$(job_runs)" = 1
test -z "$(profile_pids)"
"$SCRIPT" start

# An existing owned browser without a live watchdog is replaced by a complete
# service, including when the dead watchdog is waiting to be reaped.
browser_pid="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)"
watchdog="$(pgrep -f "$SCRIPT watchdog $browser_pid" | head -1)"
kill "$watchdog"
"$SCRIPT" start 2> "$TEMP_DIR/missing-watchdog.log"
grep -q 'owned browser has no watchdog' "$TEMP_DIR/missing-watchdog.log"
browser_pid="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)"
pgrep -f "$SCRIPT watchdog $browser_pid" > /dev/null

# The deliberate first post-crash launcher failure may tear down every one of
# its descendants; the launchd-owned service still survives for the relaunch.
kill "$browser_pid"
wait_for_closed_port
grep -q '^running ' "$TEMP_DIR/daemon-state"
"$NODE" "$ROOT/tests/fixtures/kill-launcher-descendants.js" "$SCRIPT"
wait_for_port
"$SCRIPT" ensure
"$SCRIPT" stop
wait_for_closed_port

# If a foreign process wins the port after bootstrap, only our service and
# profile processes are cleaned up; the foreign listener remains alive.
touch "$TEMP_DIR/delay-start"
"$SCRIPT" start > "$TEMP_DIR/foreign-race.log" 2>&1 &
start_pid=$!
for _ in $(seq 1 40); do job_loaded && break; sleep 0.1; done
job_loaded || fail "service was not loaded for foreign-port race"
"$NODE" "$TEMP_DIR/fake-browser.js" "--remote-debugging-port=$PORT" --immediate &
FOREIGN_PID=$!
wait_for_port
if wait "$start_pid"; then fail "start succeeded after a foreign process won the port"; fi
kill -0 "$FOREIGN_PID"
job_loaded && fail "foreign-port failure leaked the launchd job"
test -z "$(profile_pids)"
kill "$FOREIGN_PID"
wait "$FOREIGN_PID" 2> /dev/null || true
FOREIGN_PID=""
wait_for_closed_port
mv "$TEMP_DIR/delay-start" "$TEMP_DIR/delay-start.used"

# A browser that never binds must time out with no loaded job or owned process.
touch "$TEMP_DIR/never-listen"
if "$SCRIPT" start > "$TEMP_DIR/timeout.log" 2>&1; then fail "start succeeded without a CDP listener"; fi
job_loaded && fail "startup timeout leaked the launchd job"
test -z "$(profile_pids)"
mv "$TEMP_DIR/never-listen" "$TEMP_DIR/never-listen.used"

"$SCRIPT" start
"$SCRIPT" stop
wait_for_closed_port
test "$(cat "$TEMP_DIR/daemon-state")" = clean

echo "launchd supervision and failure cleanup verified"
