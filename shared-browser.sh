#!/bin/bash
# Shared headless fingerprint-chromium serving every Playwright MCP instance
# over CDP.
# MCP instances attach with: --cdp-endpoint http://localhost:9377 --isolated
# (--isolated is required: without it instances share the default context and
# hijack each other's tabs).
# Port 9377, deliberately not 9222: 9222 is the universal CDP default, and an
# agent must never attach to some other tool's debug browser (or vice versa).
# `start` is idempotent: safe to fire blind before any fan-out. Ownership is
# derived from the port itself — the listener whose command line names our
# profile dir is ours; there is no pidfile to go stale. A foreign process on
# the port is always fatal, and `stop` refuses to kill it.
# Crash-aware auto-start: agents launch through browser-swarm-mcp.sh, whose
# `ensure` verb starts the daemon whenever it is down. After a crash it still
# starts the browser but exits nonzero, sacrificing that one agent's MCP so
# the agent reports the crash to the orchestrator instead of silently papering
# over it; the start clears the crash state, so every later agent — including
# the sacrificed one relaunched — attaches normally.
# Auto-stop: `start` also spawns a watchdog that kills the browser after
# 5 minutes with no attached CDP clients, so an idle daemon never outlives
# its fan-out. An agent holds its CDP connection for exactly the lifetime of
# its MCP process, so zero established connections means no agent from any
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
# Shutdown marker for crash detection only — ownership stays port-derived.
# `running <boot-epoch>` while the daemon is up; `clean` after a deliberate
# stop. Found still `running` with the daemon down and the boot unchanged,
# the previous instance died unannounced: that is a crash.
STATE_FILE="$DIR/daemon-state"
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
# port, excluding the browser ($1) itself. 0 means no agent is attached.
# Counting connections rather than contexts or pages is deliberate: an agent
# between tabs has no pages, and a pageless context created by another CDP
# connection is invisible to playwright's contexts() — but the agent's CDP
# connection itself is always there.
client_count() {
  lsof -t -i ":$PORT" -sTCP:ESTABLISHED 2> /dev/null | sort -u | grep -cvx "$1" || true
}

boot_epoch() { sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\),.*/\1/'; }

mark_running() { echo "running $(boot_epoch)" > "$STATE_FILE"; }
mark_clean() { echo "clean" > "$STATE_FILE"; }

# True when the previous daemon instance died without a deliberate stop in
# this boot session. A marker from before a reboot is not a crash: the
# reboot took the daemon down, and alerting on it would just be noise.
crashed() {
  local state boot
  [ -f "$STATE_FILE" ] || return 1
  read -r state boot < "$STATE_FILE" || return 1
  [ "$state" = "running" ] && [ "$boot" = "$(boot_epoch)" ]
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
      mark_clean
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
    [ -n "$OWNER" ] && { mark_running; spawn_watchdog "$OWNER"; echo "shared browser already up: pid $OWNER, CDP http://localhost:$PORT"; exit 0; }
    echo "ERROR: a foreign CDP browser is serving port $PORT — refusing to share it (see: lsof -i :$PORT)" >&2
    exit 1
  fi
  if lsof -i ":$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "ERROR: port $PORT is taken by a non-CDP process:" >&2
    lsof -i ":$PORT" -sTCP:LISTEN >&2
    exit 1
  fi
  crashed && echo "warning: previous shared browser instance shut down uncleanly (crashed or killed) — see $LOG" >&2
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
      [ -n "$OWNER" ] && { mark_running; spawn_watchdog "$OWNER"; echo "shared browser up: pid $OWNER, CDP http://localhost:$PORT"; exit 0; }
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
    crashed && { echo "note: previous instance shut down uncleanly — clearing crash state"; mark_clean; }
    echo "shared browser already stopped"
    exit 0
  fi
  mark_clean
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
      crashed && echo "last shutdown: unclean — daemon crashed or was killed (the next agent attach restarts it and reports the crash; \`$0 start\` clears the state now)"
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

# Crash-aware auto-start for agents (called by browser-swarm-mcp.sh, not
# operators): starts the daemon; after a crash it still starts the browser but
# exits nonzero, so this one agent's MCP fails to initialize and the agent
# reports the crash to the orchestrator — auto-recovery without hiding the
# crash. The start clears the crash state, so every later agent (including
# this one relaunched) attaches normally.
ensure() {
  if ! alive && [ -z "$(owner_pid)" ] && crashed; then
    ( start )
    echo "ERROR: shared browser crashed since its last clean shutdown (see $LOG) — it has been restarted, but this agent's MCP is deliberately failed so the crash gets reported. Relaunch the agent to attach normally." >&2
    exit 1
  fi
  start
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  ensure) ensure ;; # internal, called by browser-swarm-mcp.sh
  watchdog) watchdog "${2:?watchdog needs the browser pid}" ;; # internal, spawned by start
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
