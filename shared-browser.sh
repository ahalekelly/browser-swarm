#!/bin/bash
# Shared headless fingerprint-chromium serving every Playwright MCP instance
# over CDP.
# MCP instances attach with: --cdp-endpoint http://localhost:9377 --isolated
# (--isolated is required: without it instances share the default context and
# hijack each other's tabs).
# Port 9377, deliberately not 9222: 9222 is the universal CDP default, and a
# leaf must never attach to some other tool's debug browser (or vice versa).
# `start` is idempotent: safe to fire blind before any fan-out. Ownership is
# derived from the port itself — the listener whose command line names our
# profile dir is ours; there is no pidfile to go stale. A foreign process on
# the port is always fatal, and `stop` refuses to kill it.
# No auto-restart by design: if the browser dies, attached MCP calls fail
# loudly and the operator runs `shared-browser.sh start` again.
# Auto-stop: `start` also spawns a watchdog that kills the browser after
# 5 minutes with no attached CDP clients, so an idle daemon never outlives
# its fan-out. A leaf holds its CDP connection for exactly the lifetime of
# its MCP process, so zero established connections means no leaf from any
# session is attached.
set -euo pipefail

PORT=9377
DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$DIR/fingerprint-browser-profile"
LOG="$DIR/shared-browser.log"
BIN="$DIR/fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium"
# Random fingerprint seed, generated once per install and persisted so the
# profile keeps a stable device identity across restarts. Never share a seed
# between installs: everyone on one seed presents the same device, which is
# itself a fingerprint.
SEED_FILE="$DIR/fingerprint-seed"
IDLE_POLL=30  # seconds between watchdog polls
IDLE_POLLS=10 # consecutive idle polls before auto-stop (10 × 30s = 5 min)

alive() { curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null; }

# Pid of the listener on $PORT that this script started (its command line names
# our profile dir). Empty when the port is free or held by a foreign process.
owner_pid() {
  local pid
  for pid in $(lsof -t -i ":$PORT" -sTCP:LISTEN 2> /dev/null | sort -u || true); do
    if ps -o command= -p "$pid" 2> /dev/null | grep -qF -- "--user-data-dir=$PROFILE"; then
      echo "$pid"
      return
    fi
  done
}

# Number of distinct processes holding an established connection to the CDP
# port, excluding the browser ($1) itself. 0 means no leaf is attached.
# Counting connections rather than contexts or pages is deliberate: a leaf
# between tabs has no pages, and a pageless context created by another CDP
# connection is invisible to playwright's contexts() — but the leaf's CDP
# connection itself is always there.
client_count() {
  lsof -t -i ":$PORT" -sTCP:ESTABLISHED 2> /dev/null | sort -u | grep -cvx "$1" || true
}

# Internal verb, spawned detached by `start`: stop the browser after
# IDLE_POLLS consecutive polls with no attached clients. Pid-bound — it
# exits the moment its browser is no longer the owned listener, so a stale
# watchdog never touches a newer browser.
watchdog() {
  local browser_pid="$1" idle=0
  echo "$(date '+%F %T') watchdog: watching browser pid $browser_pid"
  while sleep "$IDLE_POLL"; do
    [ "$(owner_pid)" = "$browser_pid" ] || exit 0
    if [ "$(client_count "$browser_pid")" -eq 0 ]; then idle=$((idle + 1)); else idle=0; fi
    if [ "$idle" -ge "$IDLE_POLLS" ]; then
      echo "$(date '+%F %T') watchdog: no attached clients for $((IDLE_POLL * IDLE_POLLS))s, stopping browser pid $browser_pid"
      kill "$browser_pid" 2> /dev/null || true
      exit 0
    fi
  done
}

# One watchdog per browser pid; the pid in the command line both prevents
# duplicates and lets `status` find it.
spawn_watchdog() {
  if ! pgrep -f "shared-browser.sh watchdog $1" > /dev/null 2>&1; then
    nohup "$DIR/shared-browser.sh" watchdog "$1" >> "$LOG" 2>&1 &
  fi
}

start() {
  if alive; then
    OWNER="$(owner_pid)"
    [ -n "$OWNER" ] && { spawn_watchdog "$OWNER"; echo "shared browser already up: pid $OWNER, CDP http://localhost:$PORT"; exit 0; }
    echo "ERROR: a foreign CDP browser is serving port $PORT — refusing to share it (see: lsof -i :$PORT)" >&2
    exit 1
  fi
  if lsof -i ":$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "ERROR: port $PORT is taken by a non-CDP process:" >&2
    lsof -i ":$PORT" -sTCP:LISTEN >&2
    exit 1
  fi
  [ -x "$BIN" ] || { echo "ERROR: fingerprint-chromium is not installed (run $DIR/install-fingerprint-chromium.sh)" >&2; exit 1; }
  # Modulo keeps the seed inside int32, which is what Chromium's flag parser takes.
  [ -s "$SEED_FILE" ] || echo $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 100000000 )) > "$SEED_FILE"
  FINGERPRINT="$(cat "$SEED_FILE")"
  mkdir -p "$PROFILE"
  # taskpolicy -c utility: every Chromium child inherits the QoS clamp, so
  # headless work never competes with the user's foreground apps.
  nohup taskpolicy -c utility "$BIN" \
    --headless \
    "--fingerprint=$FINGERPRINT" \
    --fingerprint-platform=macos \
    --fingerprint-brand=Chrome \
    "--remote-debugging-port=$PORT" \
    "--user-data-dir=$PROFILE" \
    --no-first-run >> "$LOG" 2>&1 &
  for _ in $(seq 1 20); do
    if alive; then
      # The owner may be a concurrent `start`'s browser rather than our child
      # (ours loses the profile lock and dies) — either way the daemon is up,
      # which is all `start` promises.
      OWNER="$(owner_pid)"
      [ -n "$OWNER" ] && { spawn_watchdog "$OWNER"; echo "shared browser up: pid $OWNER, CDP http://localhost:$PORT"; exit 0; }
      echo "ERROR: lost port $PORT to a foreign CDP browser while starting (see: lsof -i :$PORT)" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "ERROR: browser did not answer on port $PORT within 10s; last log lines:" >&2
  tail -5 "$LOG" >&2
  exit 1
}

stop() {
  OWNER="$(owner_pid)"
  if [ -z "$OWNER" ]; then
    if alive; then
      echo "ERROR: the CDP browser on port $PORT is not ours — refusing to kill it (see: lsof -i :$PORT)" >&2
      exit 1
    fi
    echo "shared browser already stopped"
    exit 0
  fi
  kill "$OWNER"
  for _ in $(seq 1 20); do
    kill -0 "$OWNER" 2> /dev/null || { echo "shared browser stopped"; exit 0; }
    sleep 0.5
  done
  echo "ERROR: pid $OWNER still alive after 10s" >&2
  exit 1
}

status() {
  OWNER="$(owner_pid)"
  if [ -z "$OWNER" ]; then
    if alive; then
      echo "foreign CDP browser on port $PORT (not started by this script):"
      lsof -i ":$PORT" -sTCP:LISTEN
    else
      echo "not running (port $PORT closed)"
    fi
    exit 1
  fi
  echo "pid: $OWNER"
  # head -1: the watchdog's own command substitutions fork subshells that
  # briefly match the same pattern.
  WD="$(pgrep -f "shared-browser.sh watchdog $OWNER" | head -1 || true)"
  if [ -n "$WD" ]; then
    echo "watchdog: pid $WD (auto-stop after $((IDLE_POLL * IDLE_POLLS))s with no attached clients)"
  else
    echo "watchdog: not running — browser will not auto-stop"
  fi
  echo "attached clients: $(client_count "$OWNER")"
  node -e "
    require('$DIR/node_modules/playwright-core').chromium.connectOverCDP('http://localhost:$PORT', { timeout: 5000 }).then(async (b) => {
      const cs = b.contexts();
      console.log('contexts: ' + cs.length);
      for (const c of cs)
        console.log('  pages: ' + (c.pages().map((p) => p.url()).join(', ') || '(none)'));
      await b.close();
    }).catch((e) => { console.error('CDP query failed: ' + e.message); process.exit(1); });
  "
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  watchdog) watchdog "${2:?watchdog needs the browser pid}" ;; # internal, spawned by start
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
