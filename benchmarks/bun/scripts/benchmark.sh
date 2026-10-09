#!/usr/bin/env bash
# pboss-vs-pm2 Bun benchmark — the orchestrator.
#
# Runs the whole comparison end to end and produces the reports:
#
#   results/raw/<manager>/c<conns>/run.jsonl        one line per measured run
#   results/raw/<manager>/c<conns>/loadgen-<n>.json full autocannon result
#   results/raw/<manager>/c<conns>/resources-<n>.csv /proc tree samples
#   results/raw/<manager>/idle.csv                  daemon-only overhead
#   results/raw/<manager>/phases.jsonl              idle + warm-startup records
#   results/raw/<manager>/{recovery,storm}.jsonl    crash-recovery.sh output
#   results/meta.json                              environment + versions
#   results/summary.csv, summary-phases.csv, REPORT.md   the comparison
#
# Usage:
#   bash scripts/benchmark.sh                      # default profile (standard)
#   BENCH_PROFILE=full bash scripts/benchmark.sh   # 10/100/500/1000 × 60s × 5
#   BENCH_PROFILE=smoke bash scripts/benchmark.sh  # fast harness verification
#   PBOSS_CMD="bun run /path/to/pboss/src/main.ts" bash scripts/benchmark.sh
#
# Fairness rules baked in (see scripts/lib/common.sh — the manager dispatch):
#   * same server.ts, same Bun executable, same port, same machine
#   * every measured run starts from a verified-clean state (daemon killed,
#     port free, no orphans) — cold start measured on every run
#   * a discarded warmup run precedes every measured run
#   * the manager ORDER alternates (load index + repeat parity) so time-
#     of-run bias (thermals, background load) cannot favor one column
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

MANAGERS=(pboss pm2)
APP_NAME="bench-bun"

# ── preflight ──────────────────────────────────────────────────────────────
preflight() {
  step "preflight — bun $("$BUN_BIN" --version), node $("$NODE_BIN" --version), profile=$BENCH_PROFILE"

  # autocannon must be importable from the benchmark's node_modules
  "$NODE_BIN" -e 'import("autocannon").catch(() => process.exit(1))' \
    || die "autocannon not importable — run 'npm install' in $BENCH_DIR"

  # the pboss command must at least answer --version
  mgr_version pboss >/dev/null || die "pboss command not usable: $PBOSS_CMD"
  mgr_version pm2 >/dev/null || die "pm2 command not usable: $PM2_BIN"

  # nothing may be left running from a previous session — a clean start
  # is the precondition for every measurement below
  teardown_all || die "cannot reach a clean state (port $BENCH_PORT busy or stray server processes)"

  # fresh results per invocation: stale runs would corrupt the aggregates
  rm -rf "$RAW_DIR"
  init_results
}

write_meta() {
  local cpu mem_total
  cpu="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | tr -d '\"' | sed 's/^ *//;s/ *$//')"
  mem_total="$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}')"
  "$NODE_BIN" -e '
    const fs = require("fs");
    // node -e: argv = [node, ...args] — the output path is argv[1]
    const [out, profile, port, conns, dur, warm, reps, sampleMs, crash, storm,
           bunV, nodeV, pm2V, pbossV, cpu, cores, memMb, kernel, osName] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({
      startedAt: new Date().toISOString(),
      suite: "bun-fork",
      machine: { os: osName, kernel, cpu, cores: Number(cores), memMb: Number(memMb) },
      versions: { bun: bunV, node: nodeV, pm2: pm2V, pboss: pbossV },
      config: {
        profile, port: Number(port),
        connections: conns.split(",").map(Number),
        durationSec: Number(dur), warmupSec: Number(warm), repeats: Number(reps),
        sampleIntervalMs: Number(sampleMs), crashRepeats: Number(crash),
        stormRestarts: Number(storm),
      },
    }, null, 2));
  ' "$RESULTS_DIR/meta.json" \
     "$BENCH_PROFILE" "$BENCH_PORT" "$BENCH_CONNECTIONS" "$BENCH_DURATION" \
     "$BENCH_WARMUP" "$BENCH_REPEATS" "$SAMPLE_INTERVAL_MS" \
     "$BENCH_CRASH_REPEATS" "$BENCH_STORM_RESTARTS" \
     "$("$BUN_BIN" --version)" "$("$NODE_BIN" --version)" \
     "$(mgr_version pm2)" "$(mgr_version pboss)" \
     "$cpu" "$(nproc)" "${mem_total:-0}" "$(uname -r)" "$(uname -s)"
  log "meta written: $RESULTS_DIR/meta.json"
}

# ── phase: idle daemon overhead (manager alone, no application) ─────────────
phase_idle() {
  step "phase 1/4 — idle daemon overhead (${BENCH_IDLE_DURATION}s each)"
  local manager daemon_pid
  for manager in "${MANAGERS[@]}"; do
    teardown_all || die "clean state unreachable before idle ($manager)"
    mgr_boot_daemon "$manager" || die "daemon boot failed ($manager)"
    daemon_pid="$(mgr_daemon_pid "$manager")" || die "daemon pid missing ($manager)"
    "$NODE_BIN" "$SCRIPTS_DIR/collect-resources.mjs" sample \
      --roots "$daemon_pid" --interval "$SAMPLE_INTERVAL_MS" \
      --duration "$BENCH_IDLE_DURATION" --out "$RAW_DIR/$manager/idle.csv"
    printf '{"manager":"%s","phase":"idle","durationSec":%d}\n' \
      "$manager" "$BENCH_IDLE_DURATION" >> "$RAW_DIR/$manager/phases.jsonl"
    log "idle ($manager) sampled (daemon pid $daemon_pid)"
    mgr_kill_daemon "$manager"
  done
}

# ── one measured HTTP run ──────────────────────────────────────────────────
# Cold-starts the manager (caller guarantees teardown), warms up, samples the
# daemon+app /proc tree while autocannon fires the measured run.
run_one() {
  local manager="$1" conns="$2" repeat="$3"
  local out_dir="$RAW_DIR/$manager/c$conns"
  mkdir -p "$out_dir"

  # BOTH managers down and the port provably free — otherwise wait_health
  # could answer from the OTHER manager's leftover server and the run
  # would measure the wrong process. A skipped run beats a poisoned one.
  teardown_all \
    || { warn "clean state unreachable (port $BENCH_PORT busy or strays) — run skipped: $manager c=$conns r=$repeat"; return 1; }

  local t0 t1 startup_ms
  t0="$(now_ms)"
  mgr_start_app "$manager" "$APP_NAME" || { warn "start failed ($manager) — run skipped"; return 1; }
  wait_health 30 || { warn "app never became healthy ($manager) — run skipped"; return 1; }
  t1="$(now_ms)"
  startup_ms=$((t1 - t0))

  local daemon_pid app_pid
  daemon_pid="$(mgr_daemon_pid "$manager")" || { warn "daemon pid missing ($manager)"; return 1; }
  app_pid="$(mgr_app_pid "$manager")"
  [ -n "$app_pid" ] || { warn "app pid not found in tree ($manager) — run skipped"; return 1; }

  # warmup (numbers discarded)
  "$NODE_BIN" "$SCRIPTS_DIR/loadgen.mjs" --url "$BENCH_URL" \
    --connections "$conns" --duration "$BENCH_WARMUP" >/dev/null 2>&1 || true

  # resource sampler runs alongside the measured run
  "$NODE_BIN" "$SCRIPTS_DIR/collect-resources.mjs" sample \
    --roots "$daemon_pid,$app_pid" --interval "$SAMPLE_INTERVAL_MS" \
    --duration "$BENCH_DURATION" --out "$out_dir/resources-$repeat.csv" &
  local sampler_pid=$!

  "$NODE_BIN" "$SCRIPTS_DIR/loadgen.mjs" --url "$BENCH_URL" \
    --connections "$conns" --duration "$BENCH_DURATION" \
    --out "$out_dir/loadgen-$repeat.json"

  wait "$sampler_pid" || true

  printf '{"manager":"%s","repeat":%d,"connections":%d,"duration":%d,"coldStartupMs":%d,"startedAt":"%s","daemonPid":%s,"appPid":%s}\n' \
    "$manager" "$repeat" "$conns" "$BENCH_DURATION" "$startup_ms" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${daemon_pid:-0}" "${app_pid:-0}" \
    >> "$out_dir/run.jsonl"
  log "run done: $manager c=$conns repeat=$repeat (cold start ${startup_ms} ms, app pid $app_pid)"
}

# ── phase: the HTTP matrix ─────────────────────────────────────────────────
phase_matrix() {
  step "phase 2/4 — HTTP matrix: c=[$BENCH_CONNECTIONS] × ${BENCH_DURATION}s × ${BENCH_REPEATS} repeat(s)"
  local conns_arr conns repeat load_index=0 m
  IFS=',' read -r -a conns_arr <<< "$BENCH_CONNECTIONS"

  for conns in "${conns_arr[@]}"; do
    repeat=1
    while [ "$repeat" -le "$BENCH_REPEATS" ]; do
      # alternate who runs first (load index + repeat parity)
      local order
      if [ $(( (load_index + repeat) % 2 )) -eq 0 ]; then
        order=("pboss" "pm2")
      else
        order=("pm2" "pboss")
      fi
      for m in "${order[@]}"; do
        run_one "$m" "$conns" "$repeat" || true
      done
      repeat=$((repeat + 1))
    done
    load_index=$((load_index + 1))
  done
}

# ── phase: warm startup (daemon already up — app start only) ───────────────
phase_warm_startup() {
  step "phase 3/4 — warm startup (daemon up, $BENCH_REPEATS × per manager)"
  local manager i t0 t1
  for manager in "${MANAGERS[@]}"; do
    teardown_all || die "clean state unreachable before warm startup ($manager)"
    mgr_boot_daemon "$manager" || die "daemon boot failed ($manager)"
    i=0
    while [ "$i" -lt "$BENCH_REPEATS" ]; do
      t0="$(now_ms)"
      if mgr_start_app "$manager" "$APP_NAME" && wait_health 30; then
        t1="$(now_ms)"
        printf '{"manager":"%s","phase":"warm-startup","startupMs":%d}\n' \
          "$manager" "$((t1 - t0))" >> "$RAW_DIR/$manager/phases.jsonl"
      else
        warn "warm start failed ($manager, iteration $i)"
      fi
      mgr_delete_app "$manager" "$APP_NAME"
      wait_http_down 15 || warn "port did not free after delete ($manager)"
      i=$((i + 1))
    done
    log "warm startup ($manager): $(grep -c warm-startup "$RAW_DIR/$manager/phases.jsonl" || true) sample(s)"
    mgr_kill_daemon "$manager"
  done
}

# ── main ───────────────────────────────────────────────────────────────────
main() {
  preflight
  write_meta
  phase_idle
  phase_matrix
  phase_warm_startup

  step "phase 4/4 — crash recovery + restart storm"
  BENCH_EMBEDDED=1 bash "$DIR/crash-recovery.sh" || warn "crash phases reported failures (see above)"

  step "summarizing → $RESULTS_DIR/summary.csv + REPORT.md"
  "$NODE_BIN" "$DIR/summarize.mjs" --results "$RESULTS_DIR" || die "summarize failed"

  log "done. report: $RESULTS_DIR/REPORT.md"
}

main "$@"
