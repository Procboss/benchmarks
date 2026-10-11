#!/usr/bin/env bash
# pboss-vs-pup Deno benchmark — shared config + manager abstraction.
#
# THE FAIRNESS CONTRACT (why this file exists): every helper is manager-
# neutral so the two managers run the EXACT same application (server.ts),
# the same Deno binary, the same port, the same load, on the same machine —
# the ONLY difference between the two columns of the report is which
# process manager supervises the server.
#
# TWO MODES, same contract:
#   fork    — 1 managed process (mgr_start_app)
#   cluster — N managed workers of the same server behind one client-facing
#             port. For Deno apps BOTH managers cluster, each with its own
#             NATIVE model (the honest mechanism each one ships):
#               pboss --instances N          → its process-based cluster:
#                   every worker binds the SAME port via SO_REUSEPORT
#                   (the kernel balances connections).
#               pup cluster{instances:N, commonPort, startPort}
#                                             → pup runs a load balancer on
#                   commonPort inside the instance and one backend per
#                   worker on startPort+i (each backend learns its port
#                   from the PUP_CLUSTER_PORT env pup injects).
#             Both models answer the SAME benchmark URL — the measurement
#             stays apples-to-apples at the client, with each manager doing
#             its own native thing underneath.
#
# Isolation: each manager gets its own scratch home (PBOSS_HOME under a
# mktemp dir; the pup instance's config lives in its own scratch dir, so
# its .pup/ runtime state — API port, secret, logs — never collides with a
# real install), so the benchmark never touches a real install's daemon,
# dump or logs — and it gets deleted on exit.
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

# Cluster-mode worker count. Default: one worker per core (what a sane
# "max" resolves to on this box) — oversubscribing a 2-core box with the
# same-machine load generator would measure the OS scheduler, not the
# managers. Same N for BOTH managers, always.
: "${BENCH_INSTANCES:=$(nproc)}"
# (validated with a plain exit — `die` is not defined yet at source time)
case "$BENCH_INSTANCES" in
  ''|*[!0-9]*|0) echo "bench: BENCH_INSTANCES must be a positive integer (got '$BENCH_INSTANCES')" >&2; exit 1 ;;
esac

# pup cluster backends listen on startPort+i (pup's model injects
# PUP_CLUSTER_PORT per backend); the load balancer owns BENCH_PORT. High,
# arbitrary, never the benchmark port.
: "${PUP_START_PORT:=14600}"

# The Deno binary both managers must launch the server with. Explicit and
# ABSOLUTE (never "whatever deno resolves to later") so both columns run one
# runtime — and so the stray-process pattern below matches cmdlines exactly.
DENO_BIN="$(command -v deno || true)"
[ -n "$DENO_BIN" ] || DENO_BIN="$HOME/.deno/bin/deno"
case "$DENO_BIN" in
  /*) ;;
  *) DENO_BIN="$(command -v "$DENO_BIN" 2>/dev/null || true)" ;;
esac
[ -n "$DENO_BIN" ] || { echo "bench: deno not found on PATH (set DENO_BIN)" >&2; exit 1; }
[ -x "$DENO_BIN" ] || { echo "bench: DENO_BIN must resolve to an executable path" >&2; exit 1; }

# Node drives the harness's own tooling only — autocannon (loadgen.mjs) and
# the /proc resource sampler (collect-resources.mjs). It is NEVER in the
# measured app's path: the server and both managers run Deno.
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "bench: node not found on PATH (the load generator needs it)" >&2; exit 1; }

# pboss command. A normal install needs nothing (`pboss`); a repo checkout
# runs the CLI from source:  PBOSS_CMD="bun run /path/to/pboss/src/main.ts"
: "${PBOSS_CMD:=pboss}"
read -r -a PBOSS_CMD_ARR <<< "$PBOSS_CMD"

# pup: hexagon/pup on PATH (installed with `deno install -g jsr:@pup/pup`).
# Resolved through PATH exactly the way a user invokes it.
PUP_BIN="$(command -v pup || true)"
[ -n "$PUP_BIN" ] || PUP_BIN="$HOME/.deno/bin/pup"
[ -n "$PUP_BIN" ] || { echo "bench: pup not found (deno install -g jsr:@pup/pup)" >&2; exit 1; }

# ── isolated manager homes ─────────────────────────────────────────────────
BENCH_SCRATCH="${BENCH_SCRATCH:-$(mktemp -d /tmp/pboss-bench.XXXXXXXX)}"
PBOSS_HOME_DIR="$BENCH_SCRATCH/pboss-home"
PUP_HOME_DIR="$BENCH_SCRATCH/pup-home"
mkdir -p "$PBOSS_HOME_DIR" "$PUP_HOME_DIR"
# pup's instance identity (IPC port + secret + runtime state) is keyed to the
# config file's DIRECTORY — one config per scratch home, nothing shared.
PUP_CONFIG="$PUP_HOME_DIR/pup.json"
PUP_PIDFILE="$PUP_HOME_DIR/instance.pid"

# ── logging ───────────────────────────────────────────────────────────────
log()  { printf '\033[bench]\033 %s\n' "$*" >&2; }
step() { printf '\033[bench]\033 %s\n' "$*" >&2; }
warn() { printf '\033[bench]\033 %s\n' "$*" >&2; }
die()  { printf '\033[bench]\033 %s\n' "$*" >&2; exit 1; }

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
pup_cli()   { "$PUP_BIN" -c "$PUP_CONFIG" "$@"; }

# Is the manager's daemon/instance process running (pid file names a live pid)?
mgr_daemon_pid() {
  local pidfile pid
  case "$1" in
    pboss) pidfile="$PBOSS_HOME_DIR/daemon.pid" ;;
    pup)   pidfile="$PUP_PIDFILE" ;;
    *) return 1 ;;
  esac
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid" || return 1
}

# Boot the daemon/instance WITHOUT any application (idle-overhead measurement).
# $2 (optional) mode: "cluster" makes the pup config carry the cluster spec —
# a RUNNING pup instance keeps the config it booted with, so a cluster-mode
# warm start needs the instance booted with the cluster config in the
# first place (pboss ignores the argument: its daemon is mode-blind).
mgr_boot_daemon() {
  local mode="${2:-}"
  case "$1" in
    pboss)
      # `ping` auto-spawns the daemon — the one command that brings it up
      # without registering anything.
      pboss_cli ping >/dev/null 2>&1 || return 1
      local waited=0
      while [ $waited -lt 10000 ]; do
        mgr_daemon_pid pboss >/dev/null && return 0
        sleep 0.05
        waited=$((waited + 50))
      done
      return 1
      ;;
    pup)
      # A pup instance requires >= 1 process in its config — the honest
      # idle equivalent is one DEFINED but not started process
      # (autostart: false, never `pup start`ed). It supervises config
      # state only: no child process exists until asked.
      mgr_kill_daemon pup
      if [ "$mode" = "cluster" ]; then
        write_pup_config false "$BENCH_INSTANCES"
      else
        write_pup_config false ""
      fi
      pup_boot_and_record
      ;;
  esac
}

# Boot the pup instance from the (already-written) config and record its
# pid. setsid detaches the instance into its own session — $! cannot reach
# it, so it is found by its unique config path in the cmdline, verified
# alive, remembered in the pidfile, and the instance's IPC port file is
# waited on (the REST API answering = the boot actually finished; every
# later helper — teardown, sampling, worker counting — depends on that).
pup_boot_and_record() {
  (setsid nohup "$PUP_BIN" run -c "$PUP_CONFIG" >/dev/null 2>&1 &)
  local waited=0 pid portfile
  portfile="$(dirname "$PUP_CONFIG")/.pup/$(basename "$PUP_CONFIG")-tmp/.main.port"
  while [ $waited -lt 15000 ]; do
    pid="$(pgrep -f "pup run -c $PUP_CONFIG\$" | head -1 || true)"
    # pid alive AND the IPC port file AND a full `pup status` round trip —
    # the smoke run caught the race where the port file exists but the
    # instance's IPC secret is not ready yet, making the very first
    # `pup start` fail. A successful status request proves the whole
    # path (API up, secret published, tokens valid).
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -f "$portfile" ] \
       && "$PUP_BIN" status -c "$PUP_CONFIG" >/dev/null 2>&1; then
      echo "$pid" > "$PUP_PIDFILE"
      return 0
    fi
    sleep 0.05
    waited=$((waited + 50))
  done
  warn "pup instance did not boot (pid: ${pid:-none}, port file: $portfile)"
  return 1
}

# An IPC command with a short retry — the very first request after a boot
# can still race the instance's IPC plumbing (observed once in the smoke run:
# "Action failed: Error" on the first `pup start`); retrying turns that
# transient into a non-event. All arguments pass through (subcommand + id),
# the config flag is appended last.
pup_ipc() {
  local attempt rc=1
  for attempt in 1 2 3; do
    "$PUP_BIN" "$@" -c "$PUP_CONFIG" >/dev/null 2>&1 && { rc=0; break; }
    sleep 0.2
  done
  return $rc
}

mgr_kill_daemon() {
  case "$1" in
    pboss) pboss_cli kill >/dev/null 2>&1 || true ;;
    pup)
      # graceful first (IPC), then the pid we recorded — SIGTERM, wait,
      # SIGKILL. The instance's own beforeunload handler terminates its
      # children (terminateTimeout caps the wait at 5s in our config).
      "$PUP_BIN" terminate -c "$PUP_CONFIG" >/dev/null 2>&1 || true
      local pid waited=0
      pid="$(cat "$PUP_PIDFILE" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        while [ $waited -lt 6000 ] && kill -0 "$pid" 2>/dev/null; do
          sleep 0.1; waited=$((waited + 100))
        done
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$PUP_PIDFILE"
      ;;
  esac
}

# ── the pup config (rewritten before each instance boot) ───────────────────
# pup is config-file driven: the config IS the registry. The same file path
# is reused for every boot so the instance identity (IPC port + secret in
# <dir>/.pup/) stays stable across phases; a RUNNING instance keeps the
# config it loaded at boot, so rewriting only affects the NEXT boot.
#   $1: autostart true|false   $2: cluster spec ("" = fork, "N" = instances)
write_pup_config() {
  local autostart="$1" cluster="$2" cluster_json=""
  if [ -n "$cluster" ]; then
    cluster_json="\"cluster\": { \"instances\": $cluster, \"commonPort\": $BENCH_PORT, \"startPort\": $PUP_START_PORT },"
  fi
  cat > "$PUP_CONFIG" <<EOF
{
  "terminateTimeout": 5,
  "processes": [
    {
      "id": "bench",
      "cmd": "$DENO_BIN run --allow-net --allow-env $BENCH_DIR/server.ts",
      "env": { "PORT": "$BENCH_PORT" },
      "autostart": $autostart,
      "restart": "always",
      $cluster_json
      "pidFile": "$PUP_HOME_DIR/bench.pid"
    }
  ]
}
EOF
}

# Start the benchmark app. Cold path: the daemon/instance must already be
# DOWN (the caller tears down first) so every measured run starts from the
# same state. Warm path: the instance is up and the app stopped → IPC start.
mgr_start_app() {
  local manager="$1" name="$2" out rc=0
  case "$manager" in
    pboss)
      out="$(pboss_cli start "$BENCH_DIR/server.ts" --name "$name" \
             --interpreter "$DENO_BIN" --permissions allow-net,allow-env \
             --env PORT="$BENCH_PORT" 2>&1)" || rc=$? ;;
    pup)
      if mgr_daemon_pid pup >/dev/null; then
        out="$(pup_ipc start bench 2>&1)" || rc=$?
      else
        write_pup_config true ""
        pup_boot_and_record || rc=1
      fi
      ;;
  esac
  [ $rc -eq 0 ] || { warn "start ($manager) failed: $out"; return 1; }
}

# ── cluster-mode admission ─────────────────────────────────────────────────
# Which managers can REALLY cluster an app in this suite. For Deno apps the
# answer is BOTH — each with its own native model (pboss: SO_REUSEPORT
# process cluster; pup: built-in load balancer over per-worker ports).
mgr_supports_cluster() {
  case "$1" in
    pboss) return 0 ;;   # process-based cluster: N workers, one SO_REUSEPORT port
    pup)   return 0 ;;   # cluster{}: a load balancer on the common port over N backends
    *)     return 1 ;;
  esac
}

# Record a manager's cluster-mode absence — once per results dir, in the
# machine-readable file summarize.mjs renders into the report. (Never fires
# in this suite today — both managers cluster Deno apps — but the machinery
# stays so the admission gate and the report agree if that ever changes.)
write_cluster_unsupported() {
  local manager="$1" out
  [ -d "$RAW_DIR/$manager" ] || mkdir -p "$RAW_DIR/$manager"
  out="$RAW_DIR/$manager/cluster-unsupported.json"
  [ -f "$out" ] && return 0
  printf '{"manager":"%s","mode":"cluster","supported":false,"reason":"not supported in this suite"}\n' \
    "$manager" > "$out"
  log "cluster: $manager does not support clustering a Deno app — recorded as not supported (not measured)"
}

# Cluster-mode start (supported managers only): N workers of the SAME
# server.ts, same interpreter, same client-facing port.
mgr_start_app_cluster() {
  local manager="$1" name="$2" instances="$3" out rc=0
  mgr_supports_cluster "$manager" \
    || { warn "mgr_start_app_cluster: '$manager' does not support cluster mode (caller must gate on mgr_supports_cluster)"; return 1; }
  case "$manager" in
    pboss)
      # --port sets the base port every worker binds (SO_REUSEPORT makes
      # the kernel balance across them); --instances N selects pboss's
      # process-based cluster for a Deno app.
      out="$(pboss_cli start "$BENCH_DIR/server.ts" --name "$name" \
             --interpreter "$DENO_BIN" --permissions allow-net,allow-env \
             --instances "$instances" --port "$BENCH_PORT" \
             --env PORT="$BENCH_PORT" 2>&1)" || rc=$? ;;
    pup)
      if mgr_daemon_pid pup >/dev/null; then
        out="$(pup_ipc start bench 2>&1)" || rc=$?
      else
        # cluster{instances, commonPort, startPort}: pup's load balancer
        # owns BENCH_PORT, one backend per worker on startPort+i (each
        # backend reads PUP_CLUSTER_PORT — server.ts does exactly that).
        write_pup_config true "$instances"
        pup_boot_and_record || rc=1
      fi
      ;;
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
    # pup's registry IS the config; "deleting" the app for a phase = a
    # clean stop of the process (the instance keeps supervising nothing).
    pup)   pup_ipc stop bench || true ;;
  esac
}

mgr_restart_app() {
  local manager="$1" name="$2"
  case "$manager" in
    pboss) pboss_cli restart "$name" >/dev/null 2>&1 ;;
    pup)   pup_ipc restart bench ;;
  esac
}

mgr_version() {
  case "$1" in
    pboss) pboss_cli --version 2>/dev/null | head -1 ;;
    pup)   "$PUP_BIN" --version 2>/dev/null | head -1 ;;
  esac
}

# The managed Deno server's pid(s): processes inside the daemon/instance's
# tree whose cmdline mentions server.ts. Fork mode has exactly one; cluster
# mode has BENCH_INSTANCES of them (pup's load-balancer worker thread is
# INSIDE the instance process, never a separate server process; pboss's
# deno workers are daemon descendants).
# Re-resolved on every call — crashes and restarts change the pids.
mgr_app_pids() {
  local manager="$1" daemon_pid
  daemon_pid="$(mgr_daemon_pid "$manager")" || return 1
  "$NODE_BIN" "$SCRIPTS_DIR/collect-resources.mjs" find \
    --roots "$daemon_pid" --match "$BENCH_DIR/server.ts" --all 2>/dev/null || true
}

mgr_app_pid() {
  mgr_app_pids "$1" | head -1
}

# Live processes still serving our server that a manager owns — a leaked
# orphan from a failed cleanup invalidates the NEXT measurement, so teardown
# waits on this. The pattern anchors the script path at the END of the
# cmdline: pboss spawns "deno --allow-net --allow-env …/server.ts" and pup
# spawns "deno run --allow-net --allow-env …/server.ts" — both end with it,
# while no harness process (sampler, find — whose --match argument sits in
# the MIDDLE of its cmdline, never the end) can match.
count_stray_servers() {
  local pids
  pids="$(pgrep -f "deno.*$BENCH_DIR/server\\.ts\$" 2>/dev/null || true)"
  [ -n "$pids" ] || { echo 0; return; }
  echo "$pids" | wc -l | tr -d ' '
}

# Full teardown for one manager: app stopped, daemon/instance killed. The
# port and stray checks are DELIBERATELY NOT here — they are GLOBAL
# conditions one manager's teardown cannot fix (the other manager may hold
# the port); teardown_all owns them.
mgr_teardown() {
  mgr_delete_app "$1" "bench-deno"
  mgr_kill_daemon "$1"
}

teardown_all() {
  # BOTH managers, always: a run can only measure its own server if the
  # port is provably free — the previous run of the OTHER manager must be
  # gone too, or wait_health would answer from the wrong server.
  mgr_teardown pboss
  mgr_teardown pup
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
  mkdir -p "$RAW_DIR/pboss" "$RAW_DIR/pup" "$RESULTS_DIR"
}
