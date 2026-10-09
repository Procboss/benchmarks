#!/usr/bin/env bash
# pboss-vs-pm2 Bun benchmark — crash recovery, restart storm, (optional) soak.
#
# A process manager's job is what happens when things break, so these tests
# stay SEPARATE from the throughput runs (a restart would contaminate the
# HTTP numbers):
#
#   crash recovery  — SIGKILL the managed Bun server, measure how long the
#                     manager takes to bring /health back to 200.
#   restart storm   — manager-level restart N times in a row: failed starts,
#                     orphaned processes, per-restart wall time, and the
#                     app's RSS before vs after (leak check).
#   soak            — opt-in long-run load (SOAK_MINUTES>0), resources
#                     sampled throughout.
#
# Standalone:  bash scripts/crash-recovery.sh   (then scripts/summarize.mjs)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

MANAGERS=(pboss pm2)
APP_NAME="bench-bun"
: "${SOAK_MINUTES:=0}"

# ── crash recovery ─────────────────────────────────────────────────────────
# The app pid is re-resolved before every kill: the whole point is that the
# manager respawns a NEW pid, and we must kill the live one.
phase_crash() {
  local manager pid i t0 t1
  for manager in "${MANAGERS[@]}"; do
    step "crash recovery ($manager): $BENCH_CRASH_REPEATS × SIGKILL + respawn"
    teardown_all || die "clean state unreachable before crash phase ($manager)"
    mgr_start_app "$manager" "$APP_NAME" || die "start failed ($manager)"
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
    log "crash ($manager): $(wc -l < "$RAW_DIR/$manager/recovery.jsonl" | tr -d ' ') events"
    mgr_teardown "$manager" || true
  done
}

# ── restart storm ──────────────────────────────────────────────────────────
phase_storm() {
  local manager i t0 t1 fails pid rss_before rss_after orphans
  for manager in "${MANAGERS[@]}"; do
    step "restart storm ($manager): $BENCH_STORM_RESTARTS × restart"
    teardown_all || die "clean state unreachable before storm ($manager)"
    mgr_boot_daemon "$manager" || die "daemon boot failed ($manager)"
    mgr_start_app "$manager" "$APP_NAME" || die "start failed ($manager)"
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
    log "storm ($manager): $BENCH_STORM_RESTARTS restarts, $fails failure(s), $orphans orphan(s)"
    mgr_teardown "$manager" || true
  done
}

# ── opt-in soak ────────────────────────────────────────────────────────────
phase_soak() {
  [ "${SOAK_MINUTES:-0}" -gt 0 ] || return 0
  local manager daemon_pid app_pid
  for manager in "${MANAGERS[@]}"; do
    step "soak ($manager): $SOAK_MINUTES min sustained load"
    teardown_all || die "clean state unreachable before soak ($manager)"
    mgr_start_app "$manager" "$APP_NAME" || die "start failed ($manager)"
    wait_health 30 || die "app not healthy ($manager)"
    daemon_pid="$(mgr_daemon_pid "$manager")" || die "daemon pid missing ($manager)"
    app_pid="$(mgr_app_pid "$manager")"
    [ -n "$app_pid" ] || die "app pid missing ($manager)"

    "$NODE_BIN" "$SCRIPTS_DIR/collect-resources.mjs" sample \
      --roots "$daemon_pid,$app_pid" --interval 5000 \
      --duration $((SOAK_MINUTES * 60)) --out "$RAW_DIR/$manager/soak.csv" &
    local sampler_pid=$!
    "$NODE_BIN" "$SCRIPTS_DIR/loadgen.mjs" --url "$BENCH_URL" \
      --connections 100 --duration $((SOAK_MINUTES * 60)) \
      --out "$RAW_DIR/$manager/soak-loadgen.json"
    wait "$sampler_pid" || true
    printf '{"manager":"%s","phase":"soak","minutes":%d}\n' \
      "$manager" "$SOAK_MINUTES" >> "$RAW_DIR/$manager/phases.jsonl"
    log "soak ($manager) done"
    mgr_teardown "$manager" || true
  done
}

main() {
  init_results
  phase_crash
  phase_storm
  phase_soak
  # standalone usability: refresh the reports (skipped when the orchestrator
  # invoked this script — it summarizes after ALL phases are done)
  if [ -f "$DIR/summarize.mjs" ] && [ "${BENCH_EMBEDDED:-0}" != "1" ]; then
    step "summarizing → $RESULTS_DIR/REPORT.md"
    "$NODE_BIN" "$DIR/summarize.mjs" --results "$RESULTS_DIR" || true
  fi
}

main "$@"
