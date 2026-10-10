#!/usr/bin/env bash
# pboss-vs-pm2 Node benchmark — shared config + manager abstraction.
#
# THE FAIRNESS CONTRACT (why this file exists): every helper is manager-
# neutral so the two managers run the EXACT same application (server.mjs),
# the same Node binary, the same port, the same load, on the same
# machine — the ONLY difference between the two columns of the report is
# which process manager supervises the server.
#
# TWO MODES, same contract:
#   fork    — 1 managed process (mgr_start_app)
#   cluster — N managed workers of the same server sharing one port through
#             node:cluster (mgr_start_app_cluster). For Node apps BOTH
#             managers cluster natively, so this suite runs the full matrix
#             for both:
#               pboss --instances N → pboss's node:cluster mode (a wrapper
#                 primary, supervised by pboss, forks the N workers)
#               pm2 -i N           → true cluster_mode (the pm2 daemon is
#                 the primary and forks the N workers)
#             (The bun suite in this repo cannot do this: pm2's cluster mode
#             cannot wrap a non-Node interpreter, so it reports pm2 as not
#             supported there.)
#
# Isolation: each manager gets its own scratch home (PBOSS_HOME / PM2_HOME
# under a mktemp dir), so the benchmark never touches a real install's
# daemon, dump or logs — and it gets deleted on exit.
#
# Everything manager-specific lives in the "manager dispatch" section
# below; tests/bench-harness.test.ts pins that both dispatch arms start
# the same file with the same interpreter.

# ── profile ────────────────────────────────────────────────────────────────
# full     — the documented matrix (10/100/500/1000 conns × 60s × 5 repeats)
# standard — 10/100/500 conns (no 1000: a 2-core box with a same-machine
#            load generator saturates before that — the methodology notes
#            say to raise concurrency only as far as the machine allows)
# smoke    — fast end-to-end pass used to verify the harness itself
: "${BENCH_PROFILE:=standard}"
case "$BENCH_PROFILE" in
  full)
    : "${BENCH_CONNECTIONS:=10,100,500,1000}"
    : "${BENCH_DURATION:=60}"
    : "${BENCH_WARMUP:=10}"
    : "${BENCH_REPEATS:=5}"
    : "${BENCH_IDLE_DURATION:=10}"
    : "${BENCH_CRASH_REPEATS:=10}"
    : "${BENCH_STORM_RESTARTS:=50}"
    ;;
  standard)
    : "${BENCH_CONNECTIONS:=10,100,500}"
    : "${BENCH_DURATION:=60}"
    : "${BENCH_WARMUP:=10}"
    : "${BENCH_REPEATS:=5}"
    : "${BENCH_IDLE_DURATION:=10}"
    : "${BENCH_CRASH_REPEATS:=10}"
    : "${BENCH_STORM_RESTARTS:=50}"
    ;;
  smoke)
    : "${BENCH_CONNECTIONS:=10,100}"
    : "${BENCH_DURATION:=5}"
    : "${BENCH_WARMUP:=2}"
    : "${BENCH_REPEATS:=1}"
    : "${BENCH_IDLE_DURATION:=3}"
    : "${BENCH_CRASH_REPEATS:=3}"
    : "${BENCH_STORM_RESTARTS:=5}"
    ;;
  *)
    echo "bench: unknown BENCH_PROFILE '$BENCH_PROFILE' (full|standard|smoke)" >&2
    exit 1
    ;;
esac

# ── paths & binaries ──────────────────────────────────────────────────────
# This file lives in scripts/lib/ — TWO levels below the suite root.
BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS_DIR="$BENCH_DIR/scripts"
RESULTS_DIR="${BENCH_RESULTS_DIR:-$BENCH_DIR/results}"
RAW_DIR="$RESULTS_DIR/raw"

: "${BENCH_PORT:=3000}"
: "${BENCH_URL:=http://127.0.0.1:$BENCH_PORT}"
: "${BENCH_HEALTH_URL:=$BENCH_URL/health}"
: "${SAMPLE_INTERVAL_MS:=500}"

# Cluster-mode worker count. Default: one worker per core (what both
# managers' "max" resolves to on this box) — oversubscribing a 2-core box
# with the same-machine load generator would measure the OS scheduler,
# not the managers. Same N for BOTH managers, always.
: "${BENCH_INSTANCES:=$(nproc)}"
# (validated with a plain exit — `die` is not defined yet at source time)
case "$BENCH_INSTANCES" in
  ''|*[!0-9]*|0) echo "bench: BENCH_INSTANCES must be a positive integer (got '$BENCH_INSTANCES')" >&2; exit 1 ;;
esac

# The Node binary both managers must launch the server with. Explicit and
# ABSOLUTE (never "whatever node resolves to later") so both columns run one
# runtime — and so the stray-process pattern below matches cmdlines exactly.
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "bench: node not found on PATH (set NODE_BIN)" >&2; exit 1; }
case "$NODE_BIN" in
  /*) ;;
  *) NODE_BIN="$(command -v "$NODE_BIN" 2>/dev/null || true)" ;;
esac
[ -n "$NODE_BIN" ] || { echo "bench: NODE_BIN must resolve to an absolute path" >&2; exit 1; }

# pboss command. A normal install needs nothing (`pboss`); a repo checkout
# runs the CLI from source:  PBOSS_CMD="bun run /path/to/pboss/src/main.ts"
: "${PBOSS_CMD:=pboss}"
read -r -a PBOSS_CMD_ARR <<< "$PBOSS_CMD"

# pm2: the local devDependency first (pinned by this suite), PATH fallback.
# Invoked THROUGH $NODE_BIN (not the shebang) so the pm2 daemon — and with
# it every cluster.fork() worker, which inherits the daemon's execPath —
# provably runs the same Node binary the app was started with.
: "${PM2_BIN:=$BENCH_DIR/node_modules/pm2/bin/pm2}"
[ -f "$PM2_BIN" ] || PM2_BIN="$BENCH_DIR/node_modules/.bin/pm2"
[ -f "$PM2_BIN" ] || PM2_BIN="$(command -v pm2 || true)"
[ -n "$PM2_BIN" ] || { echo "bench: pm2 not found (run 'npm install' in benchmarks/node)" >&2; exit 1; }

# ── isolated manager homes ─────────────────────────────────────────────────
BENCH_SCRATCH="${BENCH_SCRATCH:-$(mktemp -d /tmp/pboss-bench.XXXXXXXX)}"
PBOSS_HOME_DIR="$BENCH_SCRATCH/pboss-home"
PM2_HOME_DIR="$BENCH_SCRATCH/pm2-home"
mkdir -p "$PBOSS_HOME_DIR" "$PM2_HOME_DIR"

# ── logging ───────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[bench]\033[0m %s\n' "$*" >&2; }
step() { printf '\033[1;36m[bench]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[bench]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[bench]\033[0m %s\n' "$*" >&2; exit 1; }

now_ms() {
  local t
  t="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$t" =~ ^[0-9]+$ ]]; then echo "$t"; else "$NODE_BIN" -e 'console.log(Date.now())'; fi
}

# ── HTTP readiness ─────────────────────────────────────────────────────────
# Poll /health until it answers 200 (exit 0) or the timeout (exit 1).
wait_health() {
  local timeout_s="${1:-30}" waited=0 code
  while [ "$waited" -lt $((timeout_s * 1000)) ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$BENCH_HEALTH_URL" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep 0.05
    waited=$((waited + 50))
  done
  return 1
}

# Wait until the port stops answering (teardown completeness check).
wait_http_down() {
  local timeout_s="${1:-15}" waited=0
  while [ "$waited" -lt $((timeout_s * 1000)) ]; do
    curl -s -o /dev/null --max-time 1 "$BENCH_HEALTH_URL" >/dev/null 2>&1 || return 0
    sleep 0.05
    waited=$((waited + 50))
  done
  return 1
}

# ── manager dispatch ───────────────────────────────────────────────────────
# Every manager difference in the entire benchmark lives in this section.

pboss_cli() { PBOSS_HOME="$PBOSS_HOME_DIR" "${PBOSS_CMD_ARR[@]}" "$@"; }
pm2_cli()   { PM2_HOME="$PM2_HOME_DIR" "$NODE_BIN" "$PM2_BIN" "$@"; }

# Is the manager's daemon process running (pid file names a live pid)?
mgr_daemon_pid() {
  local pidfile pid
  case "$1" in
    pboss) pidfile="$PBOSS_HOME_DIR/daemon.pid" ;;
    pm2)   pidfile="$PM2_HOME_DIR/pm2.pid" ;;
    *) return 1 ;;
  esac
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid" || return 1
}

# Boot the daemon WITHOUT any application (idle-overhead measurement).
# `ping` auto-spawns for both managers — the one command that brings the
# daemon up without registering anything.
mgr_boot_daemon() {
  case "$1" in
    pboss) pboss_cli ping >/dev/null 2>&1 || return 1 ;;
    pm2)   pm2_cli ping >/dev/null 2>&1 || return 1 ;;
  esac
  local waited=0
  while [ $waited -lt 10000 ]; do
    mgr_daemon_pid "$1" >/dev/null && return 0
    sleep 0.05
    waited=$((waited + 50))
  done
  return 1
}

mgr_kill_daemon() {
  case "$1" in
    pboss) pboss_cli kill >/dev/null 2>&1 || true ;;
    pm2)   pm2_cli kill >/dev/null 2>&1 || true ;;
  esac
}

# Start the benchmark app. Cold path: the daemon must already be DOWN (the
# caller tears down first) so every measured run starts from the same state.
mgr_start_app() {
  local manager="$1" name="$2" out rc=0
  case "$manager" in
    pboss)
      out="$(pboss_cli start "$BENCH_DIR/server.mjs" --name "$name" \
             --interpreter "$NODE_BIN" --env PORT="$BENCH_PORT" 2>&1)" || rc=$? ;;
    pm2)
      out="$(PORT="$BENCH_PORT" pm2_cli start "$BENCH_DIR/server.mjs" --name "$name" \
             --interpreter "$NODE_BIN" 2>&1)" || rc=$? ;;
  esac
  [ $rc -eq 0 ] || { warn "start ($manager) failed: $out"; return 1; }
}

# ── cluster-mode admission ─────────────────────────────────────────────────
# Which managers can REALLY cluster an app in this suite. For Node apps the
# answer is BOTH — this is the suite where pm2's cluster mode genuinely
# competes (the bun suite records pm2 as not supported instead).
mgr_supports_cluster() {
  case "$1" in
    pboss) return 0 ;;   # node:cluster mode: a supervised wrapper primary forks the N workers
    pm2)   return 0 ;;   # true cluster_mode: the pm2 daemon is the primary, -i N forks the workers
    *)     return 1 ;;
  esac
}

# Record a manager's cluster-mode absence — once per results dir, in the
# machine-readable file summarize.mjs renders into the report. (Never fires
# in this suite today — both managers cluster Node apps — but the machinery
# stays so the admission gate and the report agree if that ever changes.)
write_cluster_unsupported() {
  local manager="$1" out
  [ -d "$RAW_DIR/$manager" ] || mkdir -p "$RAW_DIR/$manager"
  out="$RAW_DIR/$manager/cluster-unsupported.json"
  [ -f "$out" ] && return 0
  printf '{"manager":"%s","mode":"cluster","supported":false,"reason":"not supported in this suite"}\n' \
    "$manager" > "$out"
  log "cluster: $manager does not support clustering a Node app — recorded as not supported (not measured)"
}

# Cluster-mode start (supported managers only): N workers of the SAME
# server.mjs, same interpreter, same port — node:cluster shares the primary's
# listening socket across the workers (the primary distributes connections).
mgr_start_app_cluster() {
  local manager="$1" name="$2" instances="$3" out rc=0
  mgr_supports_cluster "$manager" \
    || { warn "mgr_start_app_cluster: '$manager' does not support cluster mode (caller must gate on mgr_supports_cluster)"; return 1; }
  case "$manager" in
    pboss)
      # --port sets PBOSS_BASE_PORT: the wrapper primary gives every worker
      # the SAME port. --instances N selects pboss's node:cluster mode for a
      # Node app (one supervised wrapper, N forked workers).
      out="$(pboss_cli start "$BENCH_DIR/server.mjs" --name "$name" \
             --interpreter "$NODE_BIN" --instances "$instances" \
             --port "$BENCH_PORT" --env PORT="$BENCH_PORT" 2>&1)" || rc=$? ;;
    pm2)
      # -i N with a node interpreter is TRUE cluster_mode: the pm2 daemon
      # becomes the cluster primary and forks the N workers itself.
      out="$(PORT="$BENCH_PORT" pm2_cli start "$BENCH_DIR/server.mjs" --name "$name" \
             -i "$instances" --interpreter "$NODE_BIN" 2>&1)" || rc=$? ;;
  esac
  [ $rc -eq 0 ] || { warn "cluster start ($manager) failed: $out"; return 1; }
}

# Count of live worker processes in the manager's tree (cluster sanity:
# the manager must actually be running N of them, not 1, not N+1).
mgr_worker_count() {
  local manager="$1" pids
  pids="$(mgr_app_pids "$manager")"
  [ -n "$pids" ] || { echo 0; return; }
  echo "$pids" | wc -l | tr -d ' '
}

mgr_delete_app() {
  local manager="$1" name="$2"
  case "$manager" in
    pboss) pboss_cli delete "$name" --force >/dev/null 2>&1 || true ;;
    pm2)   pm2_cli delete "$name" >/dev/null 2>&1 || true ;;
  esac
}

mgr_restart_app() {
  local manager="$1" name="$2"
  case "$manager" in
    pboss) pboss_cli restart "$name" >/dev/null 2>&1 ;;
    # PORT rides along again: --update-env rebuilds the env from the
    # CURRENT shell, and PORT was only set on the start command's env.
    pm2)   PORT="$BENCH_PORT" pm2_cli restart "$name" --update-env >/dev/null 2>&1 ;;
  esac
}

mgr_version() {
  case "$1" in
    pboss) pboss_cli --version 2>/dev/null | head -1 ;;
    pm2)   pm2_cli --version 2>/dev/null | tail -1 ;;
  esac
}

# The managed Node server's pid(s): processes inside the daemon's tree whose
# cmdline mentions server.mjs. Fork mode has exactly one; cluster mode has
# BENCH_INSTANCES of them (the pboss wrapper primary's cmdline names the
# wrapper, not the app, so it is never counted).
# Re-resolved on every call — crashes and restarts change the pids.
mgr_app_pids() {
  local manager="$1" daemon_pid
  daemon_pid="$(mgr_daemon_pid "$manager")" || return 1
  "$NODE_BIN" "$SCRIPTS_DIR/collect-resources.mjs" find \
    --roots "$daemon_pid" --match "$BENCH_DIR/server.mjs" --all 2>/dev/null || true
}

mgr_app_pid() {
  mgr_app_pids "$1" | head -1
}

# Live processes still serving our server that a manager owns — a leaked
# orphan from a failed cleanup invalidates the NEXT measurement, so teardown
# waits on this. The pattern is the exact server cmdline — pm2's app
# processes re-title themselves "node <script>" (ProcessContainer), pboss
# spawns "$NODE_BIN <script>", so BOTH spellings are ours; no harness
# process (sampler, find) ends with the script path.
count_stray_servers() {
  local pids
  pids="$(pgrep -f "^(node|$NODE_BIN) $BENCH_DIR/server\\.mjs\$" 2>/dev/null || true)"
  [ -n "$pids" ] || { echo 0; return; }
  echo "$pids" | wc -l | tr -d ' '
}

# Full teardown for one manager: app deleted, daemon killed. The port and
# stray checks are DELIBERATELY NOT here — they are GLOBAL conditions one
# manager's teardown cannot fix (the other manager may hold the port);
# teardown_all owns them.
mgr_teardown() {
  mgr_delete_app "$1" "bench-node"
  mgr_kill_daemon "$1"
}

teardown_all() {
  # BOTH managers, always: a run can only measure its own server if the
  # port is provably free — the previous run of the OTHER manager must be
  # gone too, or wait_health would answer from the wrong server.
  mgr_teardown pboss
  mgr_teardown pm2
  local rc=0 strays waited=0
  wait_http_down 15 || { warn "teardown: port $BENCH_PORT still answering"; rc=1; }
  while [ $waited -lt 10000 ]; do
    strays="$(count_stray_servers)"
    [ "$strays" -eq 0 ] && break
    sleep 0.1
    waited=$((waited + 100))
  done
  if [ "${strays:-1}" -ne 0 ]; then
    warn "teardown: $strays stray server process(es) survived"
    rc=1
  fi
  return $rc
}

cleanup_scratch() {
  teardown_all
  rm -rf "$BENCH_SCRATCH"
}
trap cleanup_scratch EXIT INT TERM

# ── run artifacts ─────────────────────────────────────────────────────────
init_results() {
  mkdir -p "$RAW_DIR/pboss" "$RAW_DIR/pm2" "$RESULTS_DIR"
}
