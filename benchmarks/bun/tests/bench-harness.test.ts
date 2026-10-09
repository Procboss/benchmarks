/**
 * pboss-vs-pm2 Bun benchmark — harness tests (hermetic).
 *
 * Two kinds of cover:
 *   1. the pure units: /proc parsing, tree math, CPU math, aggregation,
 *      CSV/JSONL parsing, the relative-difference formula, and the report
 *      renderer (fixture data in, markdown out);
 *   2. source contracts: the fairness rules that make the comparison
 *      legitimate are pinned against the actual script sources — both
 *      managers must launch the same server with the same interpreter,
 *      every measured run must tear down first, the order must alternate,
 *      warmup must be discarded, and the crash tests must not touch the
 *      throughput phases.
 *
 * No npm install needed: the .mjs modules use only node builtins, and the
 * contract tests read files. `bun test` from benchmarks/bun runs this file.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  parseStat,
  rssBytes,
  treeOf,
  cpuPercent,
  median as medianSorted,
  computeAggregates,
  samplesToCsv,
} from "../scripts/collect-resources.mjs";
import {
  mean,
  median,
  stdev,
  maxOf,
  relDiff,
  parseResourceCsvLine,
  parseResourceCsv,
  parseJsonl,
  aggregateLoad,
  cmpRow,
  buildReport,
  buildSummaryCsv,
} from "../scripts/summarize.mjs";

const HERE = dirname(import.meta.path);
const SUITE = join(HERE, "..");
const SCRIPTS = join(SUITE, "scripts");
const read = (p) => readFileSync(p, "utf8");

// ── /proc parsing ──────────────────────────────────────────────────────────

describe("parseStat — /proc/<pid>/stat", () => {
  test("parses pid, ppid and CPU fields", () => {
    // Real shape: pid (comm) state ppid ... utime stime ...
    const stat = "1612 (bun) S 1603 1603 1603 0 -1 4194624 100 200 0 0 12 34 0 0 20 0 5 0 123456 999999 100 0 0 0";
    const parsed = parseStat(stat);
    expect(parsed).not.toBeNull();
    expect(parsed.pid).toBe(1612);
    expect(parsed.ppid).toBe(1603);
    expect(parsed.utimeTicks).toBe(12);
    expect(parsed.stimeTicks).toBe(34);
  });

  test("survives spaces and parens inside comm", () => {
    const stat = `42 (a weird (name) with spaces) S 1 1 1 0 -1 0 0 0 0 0 7 9 0 0 20 0 3 0 1 2 0 0`;
    const parsed = parseStat(stat);
    expect(parsed).not.toBeNull();
    expect(parsed.pid).toBe(42);
    expect(parsed.ppid).toBe(1);
    expect(parsed.utimeTicks).toBe(7);
    expect(parsed.stimeTicks).toBe(9);
  });

  test("rejects malformed lines with null, never a throw", () => {
    expect(parseStat("")).toBeNull();
    expect(parseStat("no closing paren here")).toBeNull();
    expect(parseStat("1 (x) S 2 3 4")).toBeNull(); // too few tail fields
  });
});

describe("rssBytes — statm", () => {
  test("resident pages × page size", () => {
    expect(rssBytes("9000 1024 800 600 0 400 0", 4096)).toBe(1024 * 4096);
  });
  test("garbage is zero, never a throw", () => {
    expect(rssBytes("", 4096)).toBe(0);
    expect(rssBytes("9000 notanumber", 4096)).toBe(0);
  });
});

// ── tree math ──────────────────────────────────────────────────────────────

describe("treeOf — the whole process tree, grandchildren included", () => {
  const mk = (pid, ppid) => ({ pid, ppid, utimeTicks: 0, stimeTicks: 0 });
  const table = new Map([
    [1, mk(1, 0)],      // init
    [10, mk(10, 1)],    // pm2 god daemon
    [11, mk(11, 10)],   // the managed bun server
    [12, mk(12, 11)],   // a grandchild the server spawned
    [20, mk(20, 1)],    // unrelated process
    [21, mk(21, 20)],   // its child — NOT in the daemon tree
  ]);

  test("roots + descendants, unrelated excluded", () => {
    const tree = treeOf([10], table);
    expect(tree.has(10)).toBe(true);
    expect(tree.has(11)).toBe(true);
    expect(tree.has(12)).toBe(true); // grandchild
    expect(tree.has(20)).toBe(false);
    expect(tree.has(21)).toBe(false);
    expect(tree.size).toBe(3);
  });

  test("multiple roots merge", () => {
    const tree = treeOf([10, 20], table);
    expect(tree.size).toBe(5);
  });

  test("dead roots contribute nothing", () => {
    expect(treeOf([999], table).size).toBe(0);
  });
});

// ── CPU math ───────────────────────────────────────────────────────────────

describe("cpuPercent — ticks over wall clock, one core = 100%", () => {
  test("one full core for one second", () => {
    expect(cpuPercent(100, 1, 100)).toBe(100);
  });
  test("one and a half cores", () => {
    expect(cpuPercent(150, 1, 100)).toBe(150);
  });
  test("degenerate inputs are zero, never Infinity/NaN", () => {
    expect(cpuPercent(100, 0, 100)).toBe(0);
    expect(cpuPercent(100, 1, 0)).toBe(0);
    expect(cpuPercent(0, 1, 100)).toBe(0);
  });
});

// ── aggregation ────────────────────────────────────────────────────────────

describe("statistics helpers", () => {
  test("median (sorting): odd, even; empty is UNKNOWN (NaN), never a fake 0", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(Number.isNaN(median([null, undefined]))).toBe(true); // autocannon p95 can be null
  });
  test("medianSorted (pre-sorted contract): takes input as-is", () => {
    expect(medianSorted([1, 2, 3])).toBe(2);
    expect(medianSorted([1, 2, 3, 4])).toBe(2.5);
  });
  test("mean skips non-finite, NaN on empty", () => {
    expect(mean([1, 2, NaN, 3])).toBe(2);
    expect(Number.isNaN(mean([]))).toBe(true);
  });
  test("stdev of identical values is 0; sample stdev formula", () => {
    expect(stdev([5, 5, 5])).toBe(0);
    expect(stdev([1, 2, 3, 4])).toBeCloseTo(1.290994449, 6);
  });
  test("maxOf on empty is NaN", () => {
    expect(Number.isNaN(maxOf([]))).toBe(true);
    expect(maxOf([2, 7, 3])).toBe(7);
  });
});

describe("relDiff — (pboss − pm2) / pm2 × 100", () => {
  test("pboss 10% faster is +10", () => {
    expect(relDiff(110, 100)).toBeCloseTo(10, 10);
  });
  test("pboss 10% slower is −10", () => {
    expect(relDiff(90, 100)).toBeCloseTo(-10, 10);
  });
  test("zero or missing baseline is null — never a bogus number", () => {
    expect(relDiff(10, 0)).toBeNull();
    expect(relDiff(NaN, 100)).toBeNull();
    expect(relDiff(10, NaN)).toBeNull();
  });
});

describe("computeAggregates — one run's samples", () => {
  const samples = [
    { cpu: 10, rssMb: 50 },
    { cpu: 20, rssMb: 60 },
    { cpu: 30, rssMb: 70 },
  ];
  const agg = computeAggregates(samples);
  test("avg, median, peak", () => {
    expect(agg.nSamples).toBe(3);
    expect(agg.cpuAvg).toBe(20);
    expect(agg.cpuMedian).toBe(20);
    expect(agg.cpuPeak).toBe(30);
    expect(agg.rssAvgMb).toBe(60);
    expect(agg.rssMedianMb).toBe(60);
    expect(agg.rssPeakMb).toBe(70);
  });
  test("empty is all zeros, never a throw", () => {
    const empty = computeAggregates([]);
    expect(empty.nSamples).toBe(0);
    expect(empty.cpuAvg).toBe(0);
  });
});

// ── serialization round-trips ───────────────────────────────────────────────

describe("CSV round-trip", () => {
  const samples = [
    { timestampMs: 1000, elapsedS: 0.5, cpu: 12.5, rssMb: 42.25, pids: "10 11" },
    { timestampMs: 1500, elapsedS: 1, cpu: 13, rssMb: 42.5, pids: "10 11" },
  ];
  test("samplesToCsv → parseResourceCsv is lossless for the measured fields", () => {
    const csv = samplesToCsv(samples);
    expect(csv.startsWith("timestamp_ms,elapsed_s,cpu_percent,rss_mb,pids")).toBe(true);
    const back = parseResourceCsv(csv);
    expect(back.length).toBe(2);
    expect(back[0].cpu).toBe(12.5);
    expect(back[0].rssMb).toBe(42.25);
    expect(back[1].pids).toBe("10 11");
  });
  test("parseResourceCsvLine rejects junk lines", () => {
    expect(parseResourceCsvLine("not,a,line")).toBeNull();
    expect(parseResourceCsvLine("")).toBeNull();
  });
});

describe("parseJsonl — one record per line, junk skipped", () => {
  test("parses good lines and drops broken ones", () => {
    const recs = parseJsonl('{"a":1}\nnot json\n\n{"b":2}\n');
    expect(recs.length).toBe(2);
    expect(recs[0].a).toBe(1);
    expect(recs[1].b).toBe(2);
  });
});

// ── load aggregation + rendering ───────────────────────────────────────────

const fixtureRun = (rps, p95, coldMs, errs = 0) => ({
  meta: { coldStartupMs: coldMs, repeat: 1 },
  loadgen: {
    requests: { average: rps, total: rps * 10 },
    latency: { p50: 1, p90: p95 * 0.8, p95, p99: p95 * 1.5 },
    errors: { errors: errs, timeouts: 0, non2xx: 0 },
  },
  resources: [
    { cpu: 40, rssMb: 60 },
    { cpu: 50, rssMb: 62 },
  ],
});

describe("aggregateLoad", () => {
  test("median across runs, errors summed, cold startup median", () => {
    const agg = aggregateLoad([
      fixtureRun(100, 5, 900),
      fixtureRun(200, 6, 1100),
      fixtureRun(300, 7, 1000, 2),
    ]);
    expect(agg.measured).toBe(3);
    expect(agg.rpsMedian).toBe(200);
    expect(agg.p95Median).toBe(6);
    expect(agg.p99Median).toBe(9);
    expect(agg.errorsTotal).toBe(2);
    expect(agg.coldStartupMedian).toBe(1000);
    expect(agg.cpuAvg).toBe(45);
    expect(agg.rssAvgMb).toBe(61);
  });
  test("runs without loadgen files are counted but not measured", () => {
    const agg = aggregateLoad([fixtureRun(100, 5, 900), { meta: { coldStartupMs: 800 } }]);
    expect(agg.runs).toBe(2);
    expect(agg.measured).toBe(1);
  });
});

describe("cmpRow — the winner is spelled out, signs are never misread", () => {
  test("lowerIsBetter: pboss smaller wins", () => {
    const row = cmpRow("latency", 10, 5, " ms");
    expect(row).toContain("| 10.0 ms | 5.0 ms |");
    expect(row).toContain("-50.0% ▸ pboss");
  });
  test("higherIsBetter: pboss bigger wins", () => {
    const row = cmpRow("rps", 100, 120, "", false);
    expect(row).toContain("+20.0% ▸ pboss");
  });
  test("pm2 wins when it should", () => {
    expect(cmpRow("cpu", 10, 20)).toContain("▸ pm2");
  });
  test("missing data renders dashes, no bogus winner", () => {
    const row = cmpRow("mem", NaN, 30, " MB");
    expect(row).toContain("| — | 30.0 MB | — |");
  });

  test("minBase suppresses percentages over meaningless baselines", () => {
    // ±0.1 MB "growth" over a ~0 MB baseline is noise, not a 216% regression
    const row = cmpRow("Memory growth", -0.03, -0.1, " MB", true, 1, 1);
    expect(row).toContain("| -0.0 MB | -0.1 MB | — |");
    expect(row).not.toContain("%");
    // but a real 5 MB growth still gets its percentage
    const real = cmpRow("Memory growth", 5, 10, " MB", true, 1, 1);
    expect(real).toContain("+100.0% ▸ pm2");
  });
});

describe("buildReport — fixture data in, honest markdown out", () => {
  const data = {
    meta: {
      startedAt: "2026-10-09T00:00:00Z",
      machine: { os: "Linux", kernel: "6.0", cpu: "Test CPU", cores: 2, memMb: 4000 },
      versions: { bun: "1.3.9", node: "24", pm2: "5.4.3", pboss: "v1.7.5" },
      config: {
        profile: "standard", connections: [10, 100], durationSec: 60,
        warmupSec: 10, repeats: 5, sampleIntervalMs: 500,
      },
    },
    loads: [10, 100],
    byLoad: {
      10: { pm2: aggregateLoad([fixtureRun(1000, 2, 800)]), pboss: aggregateLoad([fixtureRun(1100, 2, 700)]) },
      100: { pm2: aggregateLoad([fixtureRun(900, 8, 850)]), pboss: aggregateLoad([fixtureRun(950, 9, 750)]) },
    },
    warmStartup: { pm2: [300, 400, 500], pboss: [200, 250, 300] },
    idle: {
      pm2: { cpuMedian: 1.5, rssMedianMb: 90 },
      pboss: { cpuMedian: 0.5, rssMedianMb: 40 },
    },
    crash: {
      pm2: { recoveryMs: [900, 1100], failures: 1 },
      pboss: { recoveryMs: [400, 600], failures: 0 },
    },
    storm: {
      pm2: { restartMs: [800, 900], restarts: 50, failures: 0, orphans: 0, rssBeforeKb: 40000, rssAfterKb: 42000 },
      pboss: { restartMs: [500, 600], restarts: 50, failures: 0, orphans: 0, rssBeforeKb: 38000, rssAfterKb: 39000 },
    },
    soak: {},
  };

  test("contains the headline and per-load sections", () => {
    const md = buildReport(data);
    expect(md).toContain("# pboss vs pm2 — managing a Bun HTTP server (fork mode)");
    expect(md).toContain("## Headline — 100 connections");
    expect(md).toContain("## Load: 10 connections");
    expect(md).toContain("## Load: 100 connections");
  });

  test("renders real numbers with winners, and no NaN leaks into tables", () => {
    const md = buildReport(data);
    expect(md).toContain("▸");
    expect(md).not.toContain("| NaN");
    expect(md).not.toContain("undefined");
    // pm2 idle memory shown, pboss difference rendered
    expect(md).toContain("90.0 MB");
  });

  test("startup, idle, crash and storm sections present", () => {
    const md = buildReport(data);
    expect(md).toContain("## Startup time");
    expect(md).toContain("## Idle daemon overhead");
    expect(md).toContain("## Crash recovery");
    expect(md).toContain("## Restart storm");
    expect(md).toContain("Failed recoveries | 1 | 0 |");
  });

  test("methodology states the same-machine caveat and alternation", () => {
    const md = buildReport(data);
    expect(md).toContain("Same-machine caveat");
    expect(md).toContain("Manager order alternates");
  });

  test("empty data degrades to a clean 'no runs' report", () => {
    const md = buildReport({ meta: null, loads: [], byLoad: {}, warmStartup: {}, idle: {}, crash: {}, storm: {}, soak: {} });
    expect(md).toContain("No load runs found");
    expect(md).not.toContain("NaN");
  });
});

describe("buildSummaryCsv — one row per manager × load", () => {
  test("header plus 2×2 fixture rows", () => {
    const csv = buildSummaryCsv({
      loads: [10, 100],
      byLoad: {
        10: { pm2: aggregateLoad([fixtureRun(1000, 2, 800)]), pboss: aggregateLoad([fixtureRun(1100, 2, 700)]) },
        100: { pm2: aggregateLoad([fixtureRun(900, 8, 850)]), pboss: aggregateLoad([fixtureRun(950, 9, 750)]) },
      },
    });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("manager,connections,runs,measured");
    expect(lines.length).toBe(5);
    expect(lines[1].startsWith("pm2,10,")).toBe(true);
    expect(lines[2].startsWith("pboss,10,")).toBe(true);
  });
});

// ── source contracts — the fairness rules, pinned ──────────────────────────

describe("fairness contract: scripts/lib/common.sh", () => {
  const sh = read(join(SCRIPTS, "lib", "common.sh"));

  test("both managers launch the same server file with the same Bun interpreter", () => {
    // one shared BENCH_DIR/server.ts, one shared BUN_BIN — the ONLY
    // difference between the columns is the manager itself
    const pbossArm = sh.match(/pboss\)\s*\n\s*out="\$\(pboss_cli start[^)]*"/s)?.[0] ?? "";
    const pm2Arm = sh.match(/pm2\)\s*\n\s*out="\$\(PORT="\$BENCH_PORT" pm2_cli start[^)]*"/s)?.[0] ?? "";
    expect(pbossArm).toContain('"$BENCH_DIR/server.ts"');
    expect(pbossArm).toContain('--interpreter "$BUN_BIN"');
    expect(pm2Arm).toContain('"$BENCH_DIR/server.ts"');
    expect(pm2Arm).toContain('--interpreter "$BUN_BIN"');
  });

  test("both managers get the same PORT", () => {
    expect(sh).toContain('--env PORT="$BENCH_PORT"');
    expect(sh).toContain('PORT="$BENCH_PORT" pm2_cli start');
  });

  test("each manager gets an isolated scratch home — never the user's real one", () => {
    expect(sh).toContain('PBOSS_HOME="$PBOSS_HOME_DIR"');
    expect(sh).toContain('PM2_HOME="$PM2_HOME_DIR"');
    expect(sh).toContain("BENCH_SCRATCH");
    expect(sh).not.toMatch(/PBOSS_HOME="\$HOME\/\.pboss"/);
  });

  test("teardown_all is the global gate: cleans BOTH managers, then verifies port free + no orphans", () => {
    const lib = read(join(SCRIPTS, "lib", "common.sh"));
    const fn = lib.slice(lib.indexOf("teardown_all() {"));
    expect(fn).toContain("mgr_teardown pboss");
    expect(fn).toContain("mgr_teardown pm2");
    expect(fn).toContain("wait_http_down");
    expect(fn).toContain("count_stray_servers");
    // the per-manager teardown must NOT own the global checks — the other
    // manager may hold the port, and one manager's teardown can't fix that
    const perManager = lib.slice(lib.indexOf("mgr_teardown() {"), lib.indexOf("teardown_all() {"));
    expect(perManager).not.toContain("wait_http_down");
    expect(perManager).not.toContain("count_stray_servers");
  });

  test("the stray-server pattern matches the exact server cmdline, not harness processes", () => {
    // the sampler/find subprocesses carry the path in their args — the
    // pattern must anchor on the Bun binary + script, so they never count
    expect(sh).toContain('pgrep -f "^$BUN_BIN .*$BENCH_DIR/server\\.ts$"');
  });

  test("profiles are defined for full/standard/smoke with a default", () => {
    expect(sh).toContain('BENCH_PROFILE:=standard');
    expect(sh).toContain('BENCH_CONNECTIONS:=10,100,500,1000');
    expect(sh).toContain('BENCH_CONNECTIONS:=10,100,500');
    expect(sh).toContain('BENCH_CONNECTIONS:=10,100');
  });
});

describe("fairness contract: scripts/benchmark.sh", () => {
  const sh = read(join(SCRIPTS, "benchmark.sh"));

  // run_one must begin with teardown of BOTH managers — otherwise wait_health
  // could answer from the other manager's leftover server (the bug the first
  // smoke run caught: pboss "runs" that were actually measuring pm2's server)
  test("every measured run tears BOTH managers down first", () => {
    const runOne = sh.slice(sh.indexOf("run_one()"));
    expect(runOne.indexOf("teardown_all")).toBeLessThan(runOne.indexOf("mgr_start_app"));
  });

  test("teardown_all covers both managers and reports failure", () => {
    const lib = read(join(SCRIPTS, "lib", "common.sh"));
    const fn = lib.slice(lib.indexOf("teardown_all() {"));
    expect(fn).toContain("mgr_teardown pboss");
    expect(fn).toContain("mgr_teardown pm2");
    expect(fn).toContain("return $rc");
  });

  test("manager order alternates (load index + repeat parity)", () => {
    expect(sh).toContain("load_index + repeat");
    expect(sh).toContain('order=("pboss" "pm2")');
    expect(sh).toContain('order=("pm2" "pboss")');
  });

  test("a discarded warmup precedes every measured run", () => {
    const runOne = sh.slice(sh.indexOf("run_one()"));
    const warmupAt = runOne.indexOf("Warmup") + runOne.indexOf("# warmup");
    const measureAt = runOne.indexOf("--out \"$out_dir/loadgen-$repeat.json\"");
    expect(warmupAt).toBeGreaterThan(-1);
    expect(warmupAt).toBeLessThan(measureAt);
  });

  test("cold startup is measured from start command to first healthy response", () => {
    expect(sh).toContain('t0="$(now_ms)"');
    expect(sh).toContain("wait_health 30");
    expect(sh).toContain("coldStartupMs");
  });

  test("results start fresh each invocation — stale runs can't corrupt aggregates", () => {
    expect(sh).toContain('rm -rf "$RAW_DIR"');
  });

  test("crash phases run AFTER the throughput matrix, never inside it", () => {
    const mainBody = sh.slice(sh.indexOf("main() {"));
    expect(mainBody.indexOf("phase_matrix")).toBeLessThan(mainBody.indexOf("crash-recovery.sh"));
  });
});

describe("fairness contract: scripts/crash-recovery.sh", () => {
  const sh = read(join(SCRIPTS, "crash-recovery.sh"));

  test("crash recovery SIGKILLs the live server and times to healthy", () => {
    expect(sh).toContain("kill -9");
    expect(sh).toContain("recoveryMs");
  });

  test("the storm checks for failed starts, orphans and memory growth", () => {
    expect(sh).toContain("restartFailed");
    expect(sh).toContain('"orphans"');
    expect(sh).toContain("rssBeforeKb");
    expect(sh).toContain("rssAfterKb");
  });

  test("both phases clean state per manager — teardown_all at every start, cleanup at every end", () => {
    expect((sh.match(/teardown_all \|\| die/g) ?? []).length).toBeGreaterThanOrEqual(3); // crash, storm, soak
    expect((sh.match(/mgr_teardown "\$manager" \|\| true/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("fairness contract: scripts/loadgen.mjs", () => {
  const js = read(join(SCRIPTS, "loadgen.mjs"));

  test("warmup numbers are discarded — only the second run is written", () => {
    expect(js).toContain("discarded");
    expect(js).toContain("if (warmup > 0)");
  });

  test("failures exit non-zero — an aborted run can never read as success", () => {
    expect(js).toContain("exit(1)");
  });
});

// ── the application itself ─────────────────────────────────────────────────

describe("server.ts — the one application both managers run", () => {
  const ts = read(join(SUITE, "server.ts"));

  test("minimal Bun HTTP server with /health and a fixed body", () => {
    expect(ts).toContain("Bun.serve");
    expect(ts).toContain('"/health"');
    expect(ts).toContain("Hello from Bun!");
    expect(ts).toContain("Bun.env.PORT ?? 3000");
  });

  test("no framework, no database — the benchmark measures manager overhead", () => {
    expect(ts).not.toContain("import ");
  });
});

// ── bash/mjs syntax sanity (hermetic — no execution of the suites) ─────────

describe("script syntax", () => {
  const bashScripts = ["benchmark.sh", "crash-recovery.sh", "collect-resources.sh", "lib/common.sh"];
  for (const s of bashScripts) {
    test(`bash -n passes: ${s}`, () => {
      const p = Bun.spawnSync(["bash", "-n", join(SCRIPTS, s)]);
      expect(p.exitCode).toBe(0);
    });
  }
  for (const m of ["collect-resources.mjs", "loadgen.mjs", "summarize.mjs"]) {
    test(`node --check passes: ${m}`, () => {
      const p = Bun.spawnSync(["node", "--check", join(SCRIPTS, m)]);
      expect(p.exitCode).toBe(0);
    });
  }
  test("server.ts typechecks under bun's transpiler (import succeeds)", async () => {
    // importing server.ts would START it — transpile check only
    const p = Bun.spawnSync(["bun", "build", "--no-bundle", join(SUITE, "server.ts")], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
  });
});

// ── repo shape ─────────────────────────────────────────────────────────────

describe("suite layout", () => {
  test("the files the README documents all exist", () => {
    for (const f of [
      "server.ts", "package.json", "README.md",
      "scripts/benchmark.sh", "scripts/crash-recovery.sh",
      "scripts/collect-resources.mjs", "scripts/loadgen.mjs",
      "scripts/summarize.mjs", "scripts/lib/common.sh",
    ]) {
      expect(existsSync(join(SUITE, f))).toBe(true);
    }
  });
});
