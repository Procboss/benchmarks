#!/usr/bin/env bash
# pboss-vs-pm2 Node benchmark — crash recovery, restart storm, (optional) soak.
#
# A process manager's job is what happens when things break, so these tests
# stay SEPARATE from the throughput runs (a restart would contaminate the
# HTTP numbers):
#
#   crash recovery  — FORK: SIGKILL the managed Node server, measure how long
#                     the manager takes to bring /health back to 200.
#                     CLUSTER: SIGKILL ONE worker and measure two things —
#                     how fast the manager replaces the worker (a NEW server
#                     pid, N workers again) and whether /health stayed up at
#                     all (the node:cluster primary keeps the shared socket,
#                     so the answer should be "yes, continuously"). Cluster
#                     phases run only for managers that can cluster a Node
#                     app (mgr_supports_cluster) — in this suite that is
#                     BOTH managers, natively.
#   restart storm   — manager-level restart N times in a row: failed starts,
#                     orphaned processes, per-restart wall time, and the
#                     app's RSS before vs after (leak check). CLUSTER adds a
#                     restored-worker-count check to every restart.
#   soak            — opt-in long-run load (SOAK_MINUTES>0), resources
#                     sampled throughout.
#
# Standalone:
#   bash scripts/crash-recovery.sh                    # fork (default)
#   BENCH_MODE=cluster bash scripts/crash-recovery.sh # cluster worker kill
#   (then scripts/summarize.mjs)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

MANAGERS=(pboss pm2)
APP_NAME="bench-node"
: "${SOAK_MINUTES:=0}"
: "${BENCH_MODE:=fork}"

case "$BENCH_MODE" in
  fork)    MODE_TAG=""                ;;
  cluster) MODE_TAG="cluster-"        ;;
  *) echo "crash-recovery: unknown BENCH_MODE '$BENCH_MODE' (fork|cluster)" >&2; exit 1 ;;
esac
RECOVERY_OUT="${MODE_TAG}recovery.jsonl"
STORM_OUT="${MODE_TAG}storm.jsonl"
SOAK_CSV="${MODE_TAG}soak.csv"
SOAK_LOADGEN="${MODE_TAG}soak-loadgen.json"

# Mode-aware start: fork starts one process, cluster starts BENCH_INSTANCES
# workers on the shared port (same fairness contract as benchmark.sh).
mode_start_app() {
  if [ "$BENCH_MODE" = "cluster" ]; then
    mgr_start_app_cluster "$1" "$APP_NAME" "$BENCH_INSTANCES"
  else
    mgr_start_app "$1" "$APP_NAME"
  fi
}

# Sum of RSS (KiB) across a newline-separated pid list — the cluster memory
# footprint is ALL workers, not one of them.
sum_rss_kb() {
  local total=0 pid rss
  while read -r pid; do
    [ -n "$pid" ] || continue
    rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ -n "$rss" ] && total=$((total + rss))
  done <<< "$1"
  echo "$total"
}

# ── crash recovery (fork): the server is the only worker — kill it, time
# the manager bringing /health back ─────────────────────────────────────────
phase_crash_fork() {
  local manager pid i t0 t1
  for manager in "${MANAGERS[@]}"; do
    step "crash recovery ($manager, fork): $BENCH_CRASH_REPEATS × SIGKILL + respawn"
    teardown_all || die "clean state unreachable before crash phase ($manager)"
    mode_start_app "$manager" || die "start failed ($manager)"
    wait_health 30 || die "app not healthy ($manager)"
    : > "$RAW_DIR/$manager/recovery.jsonl"

    i=0
    while [ "$i" -lt "$BENCH_CRASH_REPEATS" ]; do
      pid="$(mgr_app_pid "$manager")"
      if [ -z "$pid" ]; then
        printf '{"recoveryFailed":true,"reason":"app-pid-not-found","iteration":%d}\n' "$i" >> "$RAW_DIR/$manager/recovery.jsonl"
        warn "app pid vanished before kill ($manager, iteration $i)"
        i=$((i + 1)); continue
      fi
      t0="$(now_ms)"
      kill -9 "$pid" 2>/dev/null || true
      if wait_health 30; then
        t1="$(now_ms)"
        printf '{"recoveryMs":%d}\n' "$((t1 - t0))" >> "$RAW_DIR/$manager/recovery.jsonl"
      else
        printf '{"recoveryFailed":true,"timeoutMs":30000,"iteration":%d}\n' "$i" >> "$RAW_DIR/$manager/recovery.jsonl"
        warn "manager did NOT recover within 30s ($manager, iteration $i)"
      fi
      i=$((i + 1))
    done
    log "crash ($manager, fork): $(wc -l < "$RAW_DIR/$manager/recovery.jsonl" | tr -d ' ') events"
    mgr_teardown "$manager" || true
  done
}

# ── crash recovery (cluster): kill ONE worker. The surviving workers keep
# serving through the primary's shared socket (that is the whole point of
# clustering), so the measurement is (a) worker replacement time,
# (b) /health continuity ─────────────────────────────────────────────────────
phase_crash_cluster() {
  local manager i t0 t1
  for manager in "${MANAGERS[@]}"; do
    if ! mgr_supports_cluster "$manager"; then
      write_cluster_unsupported "$manager"
      continue
    fi
    step "crash recovery ($manager, cluster ×$BENCH_INSTANCES): $BENCH_CRASH_REPEATS × SIGKILL one worker"
    teardown_all || die "clean state unreachable before cluster crash phase ($manager)"
    mode_start_app "$manager" || die "cluster start failed ($manager)"
    wait_health 30 || die "app not healthy ($manager)"
    if [ "$(mgr_worker_count "$manager")" -ne "$BENCH_INSTANCES" ]; then
      die "cluster came up with $(mgr_worker_count "$manager") worker(s), expected $BENCH_INSTANCES ($manager)"
    fi
    : > "$RAW_DIR/$manager/cluster-recovery.jsonl"

    i=0
    while [ "$i" -lt "$BENCH_CRASH_REPEATS" ]; do
      local pids count
      pids="$(mgr_app_pids "$manager")"
      count="$(mgr_worker_count "$manager")"
      if [ "$count" -lt 2 ]; then
        printf '{"recoveryFailed":true,"reason":"too-few-workers","workers":%d,"iteration":%d}\n' "${count:-0}" "$i" \
          >> "$RAW_DIR/$manager/cluster-recovery.jsonl"
        warn "need at least 2 workers for a worker-kill test, found ${count:-0} ($manager, iteration $i)"
        i=$((i + 1)); continue
      fi

      local victim
      victim="$(echo "$pids" | head -1)"
      t0="$(now_ms)"
      kill -9 "$victim" 2>/dev/null || true

      # Poll: a REPLACEMENT worker exists (a pid that was not there before
      # the kill) and the worker count is back to N. Meanwhile keep probing
      # /health — every non-200 is a recorded availability break.
      local replaced=0 health_up=true waited=0 newpids p
      while [ $(( $(now_ms) - t0 )) -lt 30000 ]; do
        if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$BENCH_HEALTH_URL" 2>/dev/null || true)" != "200" ]; then
          health_up=false
        fi
        if [ "$(mgr_worker_count "$manager")" -ge "$BENCH_INSTANCES" ]; then
          newpids="$(mgr_app_pids "$manager")"
          while read -r p; do
            [ -n "$p" ] || continue
            if ! printf '%s\n' "$pids" | grep -qx "$p"; then replaced=1; break; fi
          done <<< "$newpids"
        fi
        [ "$replaced" -eq 1 ] && break
        sleep 0.02
      done
      t1="$(now_ms)"

      if [ "$replaced" -eq 1 ] && wait_health 30; then
        printf '{"respawnMs":%d,"healthStayedUp":%s}\n' "$((t1 - t0))" "$health_up" \
          >> "$RAW_DIR/$manager/cluster-recovery.jsonl"
      else
        printf '{"recoveryFailed":true,"timeoutMs":30000,"iteration":%d}\n' "$i" \
          >> "$RAW_DIR/$manager/cluster-recovery.jsonl"
        warn "manager did NOT replace the worker within 30s ($manager, iteration $i)"
      fi
      i=$((i + 1))
    done
    log "crash ($manager, cluster): $(wc -l < "$RAW_DIR/$manager/cluster-recovery.jsonl" | tr -d ' ') events"
    mgr_teardown "$manager" || true
  done
}

# ── restart storm (fork) ────────────────────────────────────────────────────
phase_storm_fork() {
  local manager i t0 t1 fails pid rss_before rss_after orphans
  for manager in "${MANAGERS[@]}"; do
    step "restart storm ($manager, fork): $BENCH_STORM_RESTARTS × restart"
    teardown_all || die "clean state unreachable before storm ($manager)"
    mgr_boot_daemon "$manager" || die "daemon boot failed ($manager)"
    mode_start_app "$manager" || die "start failed ($manager)"
    wait_health 30 || die "app not healthy ($manager)"
    : > "$RAW_DIR/$manager/storm.jsonl"

    pid="$(mgr_app_pid "$manager")"
    rss_before="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ -n "$rss_before" ] || rss_before=0

    i=0; fails=0
    while [ "$i" -lt "$BENCH_STORM_RESTARTS" ]; do
      t0="$(now_ms)"
      if mgr_restart_app "$manager" "$APP_NAME" && wait_health 30; then
        t1="$(now_ms)"
        printf '{"restartMs":%d}\n' "$((t1 - t0))" >> "$RAW_DIR/$manager/storm.jsonl"
      else
        fails=$((fails + 1))
        printf '{"restartFailed":true,"iteration":%d}\n' "$i" >> "$RAW_DIR/$manager/storm.jsonl"
        warn "restart failed ($manager, iteration $i)"
      fi
      i=$((i + 1))
    done

    sleep 1
    # Orphans = live servers NOT owned by this manager's tree. The managed
    # app itself is (and must be) running here — subtract it; anything left
    # beyond it is a process the manager lost track of.
    local total orphans app_pid_now
    total="$(count_stray_servers)"
    app_pid_now="$(mgr_app_pid "$manager")"
    orphans="$total"
    [ -n "$app_pid_now" ] && orphans=$((total - 1))
    [ "$orphans" -lt 0 ] && orphans=0

    pid="$(mgr_app_pid "$manager")"
    rss_after="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ -n "$rss_after" ] || rss_after=0
    printf '{"summary":true,"restarts":%d,"failures":%d,"orphans":%d,"rssBeforeKb":%s,"rssAfterKb":%s}\n' \
      "$BENCH_STORM_RESTARTS" "$fails" "$orphans" "$rss_before" "$rss_after" \
      >> "$RAW_DIR/$manager/storm.jsonl"
    log "storm ($manager, fork): $BENCH_STORM_RESTARTS restarts, $fails failure(s), $orphans orphan(s)"
    mgr_teardown "$manager" || true
  done
}

# ── restart storm (cluster): every restart must bring back ALL N workers ────
phase_storm_cluster() {
  local manager i t0 t1 fails rss_before rss_after orphans
  for manager in "${MANAGERS[@]}"; do
    if ! mgr_supports_cluster "$manager"; then
      write_cluster_unsupported "$manager"
      continue
    fi
    step "restart storm ($manager, cluster ×$BENCH_INSTANCES): $BENCH_STORM_RESTARTS × restart"
    teardown_all || die "clean state unreachable before cluster storm ($manager)"
    mgr_boot_daemon "$manager" || die "daemon boot failed ($manager)"
    mode_start_app "$manager" || die "cluster start failed ($manager)"
    wait_health 30 || die "app not healthy ($manager)"
    [ "$(mgr_worker_count "$manager")" -eq "$BENCH_INSTANCES" ] \
      || die "cluster came up with $(mgr_worker_count "$manager") worker(s) ($manager)"
    : > "$RAW_DIR/$manager/cluster-storm.jsonl"

    rss_before="$(sum_rss_kb "$(mgr_app_pids "$manager")")"
    [ -n "$rss_before" ] || rss_before=0

    i=0; fails=0
    while [ "$i" -lt "$BENCH_STORM_RESTARTS" ]; do
      t0="$(now_ms)"
      # A cluster restart is only successful when the port answers AND all
      # N workers are back — a restart that loses workers is a failure.
      if mgr_restart_app "$manager" "$APP_NAME" && wait_health 30 \
         && [ "$(mgr_worker_count "$manager")" -eq "$BENCH_INSTANCES" ]; then
        t1="$(now_ms)"
        printf '{"restartMs":%d}\n' "$((t1 - t0))" >> "$RAW_DIR/$manager/cluster-storm.jsonl"
      else
        fails=$((fails + 1))
        printf '{"restartFailed":true,"iteration":%d}\n' "$i" >> "$RAW_DIR/$manager/cluster-storm.jsonl"
        warn "cluster restart failed or lost workers ($manager, iteration $i)"
      fi
      i=$((i + 1))
    done

    sleep 1
    # Orphans = live servers beyond the N this manager should own.
    local total
    total="$(count_stray_servers)"
    orphans=$((total - BENCH_INSTANCES))
    [ "$orphans" -lt 0 ] && orphans=0

    rss_after="$(sum_rss_kb "$(mgr_app_pids "$manager")")"
    [ -n "$rss_after" ] || rss_after=0
    printf '{"summary":true,"restarts":%d,"failures":%d,"orphans":%d,"rssBeforeKb":%s,"rssAfterKb":%s}\n' \
      "$BENCH_STORM_RESTARTS" "$fails" "$orphans" "$rss_before" "$rss_after" \
      >> "$RAW_DIR/$manager/cluster-storm.jsonl"
    log "storm ($manager, cluster): $BENCH_STORM_RESTARTS restarts, $fails failure(s), $orphans orphan(s)"
    mgr_teardown "$manager" || true
  done
}

# ── opt-in soak ────────────────────────────────────────────────────────────
phase_soak() {
  [ "${SOAK_MINUTES:-0}" -gt 0 ] || return 0
  local manager daemon_pid app_pid
  for manager in "${MANAGERS[@]}"; do
    step "soak ($manager, $BENCH_MODE): $SOAK_MINUTES min sustained load"
    teardown_all || die "clean state unreachable before soak ($manager)"
    mode_start_app "$manager" || die "start failed ($manager)"
    wait_health 30 || die "app not healthy ($manager)"
    daemon_pid="$(mgr_daemon_pid "$manager")" || die "daemon pid missing ($manager)"
    app_pid="$(mgr_app_pid "$manager")"
    [ -n "$app_pid" ] || die "app pid missing ($manager)"

    "$NODE_BIN" "$SCRIPTS_DIR/collect-resources.mjs" sample \
      --roots "$daemon_pid,$app_pid" --interval 5000 \
      --duration $((SOAK_MINUTES * 60)) --out "$RAW_DIR/$manager/$SOAK_CSV" &
    local sampler_pid=$!
    "$NODE_BIN" "$SCRIPTS_DIR/loadgen.mjs" --url "$BENCH_URL" \
      --connections 100 --duration $((SOAK_MINUTES * 60)) \
      --out "$RAW_DIR/$manager/$SOAK_LOADGEN"
    wait "$sampler_pid" || true
    printf '{"manager":"%s","phase":"soak","mode":"%s","minutes":%d}\n' \
      "$manager" "$BENCH_MODE" "$SOAK_MINUTES" >> "$RAW_DIR/$manager/phases.jsonl"
    log "soak ($manager, $BENCH_MODE) done"
    mgr_teardown "$manager" || true
  done
}

main() {
  init_results
  if [ "$BENCH_MODE" = "cluster" ]; then
    phase_crash_cluster
    phase_storm_cluster
  else
    phase_crash_fork
    phase_storm_fork
  fi
  phase_soak
  # standalone usability: refresh the reports (skipped when the orchestrator
  # invoked this script — it summarizes after ALL phases are done)
  if [ -f "$DIR/summarize.mjs" ] && [ "${BENCH_EMBEDDED:-0}" != "1" ]; then
    step "summarizing → $RESULTS_DIR/REPORT.md + REPORT.html"
    "$NODE_BIN" "$DIR/summarize.mjs" --results "$RESULTS_DIR" || true
  fi
}

main "$@"
