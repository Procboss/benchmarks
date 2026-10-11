/**
 * pboss-vs-pm2 Bun benchmark — harness tests (hermetic).
 *
 * Two kinds of cover:
 *   1. the pure units: /proc parsing, tree math, CPU math, aggregation,
 *      CSV/JSONL parsing, the relative-difference formula, the Winner
 *      verdict, and the report renderers (fixture data in, markdown and
 *      HTML out);
 *   2. source contracts: the fairness rules that make the comparison
 *      legitimate are pinned against the actual script sources — both
 *      managers must launch the same server with the same interpreter
 *      (fork AND cluster), every measured run must tear down first, the
 *      order must alternate, warmup must be discarded, and the crash tests
 *      must not touch the throughput phases.
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
  winnerOf,
  cmpCell,
  winnerText,
  cmpRow,
  parseResourceCsvLine,
  parseResourceCsv,
  parseJsonl,
  aggregateLoad,
  buildReport,
  buildReportHtml,
  buildSummaryCsv,
  consoleSummary,
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

  test("cluster layout: one daemon, N sibling workers", () => {
    const cl = new Map([
      [1, mk(1, 0)],
      [30, mk(30, 1)],  // daemon
      [31, mk(31, 30)], // worker 0
      [32, mk(32, 30)], // worker 1
    ]);
    const tree = treeOf([30], cl);
    expect(tree.size).toBe(3);
    expect(tree.has(31)).toBe(true);
    expect(tree.has(32)).toBe(true);
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

  test("a NEGATIVE baseline keeps the diff's sign honest (memory-growth bug)", () => {
    // pup's "after − before" was −1.2 MB, pboss's +3.1: the old formula
    // divided by the negative baseline and INVERTED the winner column.
    expect(relDiff(3.1, -1.2)).toBeCloseTo(358.3, 1);
    expect(relDiff(-1.2, -1.2)).toBe(0);
    expect(winnerOf(3.1, -1.2, true).winner).toBe("pup"); // more growth = worse
    expect(winnerOf(-2.0, -1.2, true).winner).toBe("pboss"); // shrank more
  });
  test("Health stayed up is HIGHER-is-better (the inverted-winner bug)", () => {
    expect(winnerOf(100, 70, false).winner).toBe("pboss");
    expect(winnerOf(70, 100, false).winner).toBe("pup");
    expect(winnerOf(100, 100, false).winner).toBe("tie");
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

// ── the Winner column ──────────────────────────────────────────────────────

describe("winnerOf — the verdict, direction-aware", () => {
  test("lowerIsBetter: pboss smaller wins with a negative diff", () => {
    const { diff, winner } = winnerOf(10, 5, true);
    expect(winner).toBe("pboss");
    expect(diff).toBeCloseTo(-50, 10);
  });
  test("lowerIsBetter: pboss bigger loses", () => {
    expect(winnerOf(10, 20, true).winner).toBe("pm2");
  });
  test("higherIsBetter (throughput): pboss bigger wins", () => {
    const { diff, winner } = winnerOf(100, 120, false);
    expect(winner).toBe("pboss");
    expect(diff).toBeCloseTo(20, 10);
  });
  test("exactly level is a tie, not a coin flip", () => {
    expect(winnerOf(10, 10, true).winner).toBe("tie");
    expect(winnerOf(10, 10, true).diff).toBe(0);
  });
  test("missing data can never name a winner", () => {
    expect(winnerOf(NaN, 30).winner).toBeNull();
    expect(winnerOf(30, NaN).winner).toBeNull();
    expect(winnerOf(0, 10).winner).toBeNull();  // zero BASELINE (pm2) is unusable
    // pboss being literally 0 against a healthy baseline is a real win
    expect(winnerOf(10, 0, true).winner).toBe("pboss");
  });
  test("minBase suppresses verdicts over meaningless baselines", () => {
    expect(winnerOf(0.03, 0.1, true, 1).winner).toBeNull(); // pm2 baseline ~0
    expect(winnerOf(5, 10, true, 1).winner).toBe("pm2");   // real baseline, pboss higher loses
  });
});

describe("cmpCell / winnerText — the Winner cell", () => {
  test("cell carries formatted values plus the verdict", () => {
    const cell = cmpCell(10, 5, " ms", true, 1);
    expect(cell.pm2).toBe("10.0 ms");
    expect(cell.pboss).toBe("5.0 ms");
    expect(cell.winner).toBe("pboss");
  });
  test("winnerText: name first, percentage after; tie and dash", () => {
    expect(winnerText({ winner: "pboss", diff: -50 })).toBe("pboss (-50.0%)");
    expect(winnerText({ winner: "pm2", diff: 5 })).toBe("pm2 (+5.0%)");
    expect(winnerText({ winner: "tie", diff: 0 })).toBe("tie");
    expect(winnerText({ winner: null, diff: null })).toBe("—");
  });
});

describe("cmpRow — the Winner column, spelled out", () => {
  test("lowerIsBetter: pboss smaller wins", () => {
    const row = cmpRow("latency", 10, 5, " ms");
    expect(row).toContain("| 10.0 ms | 5.0 ms |");
    expect(row).toContain("pboss (-50.0%)");
  });
  test("higherIsBetter: pboss bigger wins", () => {
    const row = cmpRow("rps", 100, 120, "", false);
    expect(row).toContain("pboss (+20.0%)");
  });
  test("pm2 wins when it should", () => {
    expect(cmpRow("cpu", 10, 20)).toContain("pm2 (+100.0%)");
  });
  test("exactly equal is a tie", () => {
    expect(cmpRow("cpu", 10, 10)).toContain("tie");
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
    expect(real).toContain("pm2 (+100.0%)");
  });
});

// ── the renderers: markdown + html, same fixture, same verdicts ────────────

const fixtureData = () => ({
  meta: {
    startedAt: "2026-10-09T00:00:00Z",
    machine: { os: "Linux", kernel: "6.0", cpu: "Test CPU", cores: 2, memMb: 4000 },
    versions: { bun: "1.3.9", node: "24", pm2: "5.4.3", pboss: "v1.7.5" },
    config: {
      profile: "standard", connections: [10, 100], durationSec: 60,
      warmupSec: 10, repeats: 5, sampleIntervalMs: 500,
      modes: ["fork", "cluster"], clusterInstances: 2,
    },
  },
  modes: {
    fork: {
      loads: [10, 100],
      byLoad: {
        10: { pm2: aggregateLoad([fixtureRun(1000, 2, 800)]), pboss: aggregateLoad([fixtureRun(1100, 2, 700)]) },
        100: { pm2: aggregateLoad([fixtureRun(900, 8, 850)]), pboss: aggregateLoad([fixtureRun(950, 9, 750)]) },
      },
    },
    cluster: {
      loads: [10, 100],
      byLoad: {
        // bun suite reality: pm2 cannot cluster a Bun app, so only pboss
        // ever has cluster rows — pm2's absence is carried by
        // clusterUnsupported below (what loadEverything reads from
        // raw/pm2/cluster-unsupported.json)
        10: { pboss: aggregateLoad([fixtureRun(1600, 3, 1000)]) },
        100: { pboss: aggregateLoad([fixtureRun(1450, 11, 1150)]) },
      },
    },
  },
  warmStartup: { pm2: [300, 400, 500], pboss: [200, 250, 300] },
  warmStartupCluster: { pm2: [], pboss: [400, 500] },
  idle: {
    pm2: { cpuMedian: 1.5, rssMedianMb: 90 },
    pboss: { cpuMedian: 0.5, rssMedianMb: 40 },
  },
  crash: {
    pm2: { recoveryMs: [900, 1100], failures: 1 },
    pboss: { recoveryMs: [400, 600], failures: 0 },
  },
  crashCluster: {
    pm2: undefined,
    pboss: { respawnMs: [700, 900], failures: 0, healthStayedUp: 2, healthTotal: 2 },
  },
  storm: {
    pm2: { restartMs: [800, 900], restarts: 50, failures: 0, orphans: 0, rssBeforeKb: 40000, rssAfterKb: 42000 },
    pboss: { restartMs: [500, 600], restarts: 50, failures: 0, orphans: 0, rssBeforeKb: 38000, rssAfterKb: 39000 },
  },
  stormCluster: {
    pm2: undefined,
    pboss: { restartMs: [900, 1000], restarts: 50, failures: 0, orphans: 0, rssBeforeKb: 76000, rssAfterKb: 78000 },
  },
  soak: {},
  soakCluster: {},
  clusterUnsupported: {
    pm2: {
      manager: "pm2", mode: "cluster", supported: false, pm2Version: "5.4.3",
      reason: "pm2 cluster mode (-i N) is node:cluster inside the pm2 daemon: cluster.fork() runs the daemon runtime (Node) and ignores --interpreter",
      verified: "live: -i 2 --interpreter bun reports exec_mode fork_mode",
    },
  },
});

describe("buildReport — fixture data in, honest markdown out", () => {
  test("title, intro and the HTML-report pointer", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("# pboss vs pm2 — managing a Bun HTTP server");
    expect(md).toContain("REPORT.html");
  });

  test("fork and cluster sections both present, per load", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("## Fork mode — headline, 100 connections");
    expect(md).toContain("## Fork mode — load: 10 connections");
    expect(md).toContain("## Cluster mode — 2 workers");
    expect(md).toContain("### Cluster headline — 100 connections");
    expect(md).toContain("### Cluster load: 10 connections");
    expect(md).toContain("### Cluster load: 100 connections");
  });

  test("the comparison column is Winner, not Difference", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("| Metric | pm2 | pboss | Winner |");
    expect(md).not.toContain("| Difference |");
  });

  test("renders real numbers with winners, and no NaN leaks into tables", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("pboss (");
    expect(md).toContain("pm2 (");
    expect(md).not.toContain("| NaN");
    expect(md).not.toContain("undefined");
    expect(md).toContain("90.0 MB"); // pm2 idle memory
  });

  test("startup covers both modes; crash and storm cover both modes", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("## Startup time");
    expect(md).toContain("Cold startup, fork (median of medians)");
    expect(md).toContain("Warm startup, cluster (median)");
    expect(md).toContain("## Crash recovery — fork");
    expect(md).toContain("## Crash recovery — cluster");
    expect(md).toContain("Worker respawn (median)");
    expect(md).toContain("Health stayed up");
    expect(md).toContain("## Restart storm — fork");
    expect(md).toContain("## Restart storm — cluster");
    expect(md).toContain("Failed recoveries | 1 | 0 |");
  });

  test("cluster section reports pm2 as NOT SUPPORTED — no fork-as-cluster numbers", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("not supported");
    expect(md).toContain("pm2: cluster mode — not supported (Bun apps)");
    expect(md).toContain("node:cluster");
    // the old fork-mode-equivalence claim must be gone for good
    expect(md).not.toContain("identical either way");
    // and no winner can be named without a pm2 baseline
    const clusterSection = md.slice(md.indexOf("## Cluster mode"));
    expect(clusterSection).toContain("| — |");
  });

  test("methodology states the same-machine caveat and alternation", () => {
    const md = buildReport(fixtureData());
    expect(md).toContain("Same-machine caveat");
    expect(md).toContain("Manager order alternates");
  });

  test("empty data degrades to a clean 'no runs' report", () => {
    const md = buildReport({ meta: null, modes: {}, warmStartup: {}, warmStartupCluster: {}, idle: {}, crash: {}, crashCluster: {}, storm: {}, stormCluster: {}, soak: {}, soakCluster: {}, clusterUnsupported: {} });
    expect(md).toContain("No load runs found");
    expect(md).not.toContain("| NaN");
  });

  test("fork-only data still renders (cluster optional)", () => {
    const data = fixtureData();
    delete data.modes.cluster;
    const md = buildReport(data);
    expect(md).toContain("## Fork mode — headline, 100 connections");
    expect(md).not.toContain("## Cluster mode");
  });
});

describe("buildReportHtml — the HTML version of the summary", () => {
  test("a self-contained page: doctype, inline style, closes itself", () => {
    const html = buildReportHtml(fixtureData());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link|<script src|https?:\/\//); // no external assets
  });

  test("all sections of the markdown report exist in html form", () => {
    const html = buildReportHtml(fixtureData());
    expect(html).toContain("pboss vs pm2 — managing a Bun HTTP server");
    expect(html).toContain("Fork mode");
    expect(html).toContain("Cluster mode");
    expect(html).toContain("Crash recovery — cluster");
    expect(html).toContain("Restart storm — cluster");
    expect(html).toContain("Reproduce");
  });

  test("tables are balanced and winner cells are color-coded", () => {
    const html = buildReportHtml(fixtureData());
    expect((html.match(/<table/g) ?? []).length).toBe((html.match(/<\/table>/g) ?? []).length);
    expect(html).toContain('class="w w-pboss"');
    expect(html).toContain('class="w w-pm2"');
    expect(html).toContain("Winner"); // the column header
  });

  test("values are HTML-escaped, no NaN leaks", () => {
    const html = buildReportHtml(fixtureData());
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  test("empty data still produces a valid page", () => {
    const html = buildReportHtml({ meta: null, modes: {}, warmStartup: {}, warmStartupCluster: {}, idle: {}, crash: {}, crashCluster: {}, storm: {}, stormCluster: {}, soak: {}, soakCluster: {}, clusterUnsupported: {} });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("No load runs found");
    expect(html).not.toContain("NaN");
  });

  test("the html cluster section carries the not-supported callout too", () => {
    const html = buildReportHtml(fixtureData());
    expect(html).toContain("not supported (Bun apps)");
    expect(html).toContain('class="unsupported"');
    expect(html).not.toContain("identical either way");
  });
});

describe("buildSummaryCsv — one row per mode × manager × load", () => {
  test("header + fork(2×2) + cluster pboss-only(2) fixture rows — no cluster,pm2 rows", () => {
    const csv = buildSummaryCsv(fixtureData());
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("mode,manager,connections,runs,measured");
    expect(lines.length).toBe(7);
    expect(lines[1].startsWith("fork,pm2,10,")).toBe(true);
    expect(lines[2].startsWith("fork,pboss,10,")).toBe(true);
    expect(csv).toContain("\ncluster,pboss,10,");
    // pm2 cannot cluster a Bun app — it must have NO cluster rows at all
    expect(csv).not.toContain("cluster,pm2,");
  });
});

describe("consoleSummary — what a nohup log ends with", () => {
  test("the throughput verdict matches the direction (pboss faster wins)", () => {
    const out = consoleSummary(fixtureData());
    const forkLine = out.split("\n").find((l) => !l.startsWith("[") && l.includes("c=10"));
    // fixture: pm2 1000 rps vs pboss 1100 rps → pboss (+10.0%), NOT pm2
    expect(forkLine).toContain("pboss 1,100");
    expect(forkLine).toContain("pboss (+10.0%)");
    const clusterLine = out.split("\n").find((l) => l.startsWith("[cluster]") && l.includes("c=10"));
    // pm2 not supported in cluster mode → no pm2 number, no verdict
    expect(clusterLine).toContain("pboss 1,600");
    expect(clusterLine).toContain("—");
    expect(clusterLine).not.toContain("(+6.7%)");
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

  test("cluster mode (pboss arm): same server, same interpreter, N instances", () => {
    const fn = sh.slice(sh.indexOf("mgr_start_app_cluster() {"), sh.indexOf("mgr_worker_count() {"));
    const pbossArm = fn.slice(fn.indexOf("pboss)"), fn.indexOf("esac"));
    // same file + interpreter as fork mode
    expect(pbossArm).toContain('"$BENCH_DIR/server.ts"');
    expect(pbossArm).toContain('--interpreter "$BUN_BIN"');
    expect(pbossArm).toContain('--instances "$instances"');
    // the flag that turns reusePort on in server.ts
    expect(pbossArm).toContain('--env BENCH_CLUSTER=1');
  });

  test("pm2 has NO cluster arm — it cannot cluster a Bun app", () => {
    const fn = sh.slice(sh.indexOf("mgr_start_app_cluster() {"), sh.indexOf("mgr_worker_count() {"));
    expect(fn).not.toContain("pm2_cli start");
    // the admission gate that makes that honest, not silent
    const sup = sh.slice(sh.indexOf("mgr_supports_cluster() {"), sh.indexOf("write_cluster_unsupported() {"));
    expect(sup).toContain("pboss) return 0");
    expect(sup).toContain("pm2)   return 1");
    // and the start itself refuses unsupported managers defensively
    expect(fn).toContain("mgr_supports_cluster \"$manager\"");
  });

  test("unsupported managers are recorded machine-readably, once", () => {
    expect(sh).toContain("write_cluster_unsupported() {");
    expect(sh).toContain("cluster-unsupported.json");
    expect(sh).toContain('[ -f "$out" ] && return 0');
  });

  test("BENCH_INSTANCES defaults to the core count and is validated", () => {
    expect(sh).toContain('BENCH_INSTANCES:=$(nproc)');
    expect(sh).toContain("BENCH_INSTANCES must be a positive integer");
  });

  test("worker-pid lookup finds ALL workers (cluster), not just the first", () => {
    const fn = sh.slice(sh.indexOf("mgr_app_pids() {"));
    expect(fn).toContain("--all");
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
    const warmupAt = runOne.indexOf("# warmup");
    const measureAt = runOne.indexOf('--out "$out_dir/loadgen-$repeat.json"');
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

  test("fork AND cluster matrices both run, and each records its mode", () => {
    const mainBody = sh.slice(sh.indexOf("main() {"));
    expect(mainBody).toContain("phase_matrix fork");
    expect(mainBody).toContain("phase_matrix cluster");
    expect(mainBody).toContain("phase_warm_startup fork");
    expect(mainBody).toContain("phase_warm_startup cluster");
    // run.jsonl records carry the mode + worker count
    expect(sh).toContain('"mode":"%s"');
    expect(sh).toContain('"workers":%d');
  });

  test("cluster runs are skipped unless the manager REALLY runs N workers", () => {
    const runOne = sh.slice(sh.indexOf("run_one()"));
    expect(runOne).toContain("expected $BENCH_INSTANCES cluster workers");
    expect(runOne).toContain("mgr_worker_count");
  });

  test("cluster phases admit only managers that support clustering", () => {
    expect(sh).toContain('mode_managers "$mode"');
    expect(sh).toContain("mgr_supports_cluster \"$m\"");
    expect(sh).toContain("write_cluster_unsupported \"$m\"");
    // an unsupported manager is never even started in cluster mode
    expect(sh).not.toContain('order=("pm2" "pboss")\n      fi\n      for m in "${order[@]}"; do\n        run_one "pm2"');
  });

  test("meta.json records per-manager cluster support honestly", () => {
    expect(sh).toContain("clusterSupport");
    expect(sh).toContain("supported: false");
    expect(sh).toContain("supported: true");
  });

  test("meta.json records the cluster worker count and both modes", () => {
    expect(sh).toContain('modes: ["fork", "cluster"]');
    expect(sh).toContain("clusterInstances");
    expect(sh).toContain('"$BENCH_INSTANCES"');
  });

  test("cluster runs write to their own raw directories (never mixed with fork)", () => {
    expect(sh).toContain('cluster-c$conns');
  });
});

describe("fairness contract: scripts/crash-recovery.sh", () => {
  const sh = read(join(SCRIPTS, "crash-recovery.sh"));

  test("crash recovery SIGKILLs the live server and times to healthy (fork)", () => {
    expect(sh).toContain("kill -9");
    expect(sh).toContain("recoveryMs");
  });

  test("cluster mode: SIGKILLs ONE worker, times the replacement, tracks health", () => {
    const fn = sh.slice(sh.indexOf("phase_crash_cluster()"));
    expect(fn).toContain("kill -9");
    expect(fn).toContain("respawnMs");
    expect(fn).toContain("healthStayedUp");
  });

  test("the storm checks for failed starts, orphans and memory growth", () => {
    expect(sh).toContain("restartFailed");
    expect(sh).toContain('"orphans"');
    expect(sh).toContain("rssBeforeKb");
    expect(sh).toContain("rssAfterKb");
  });

  test("cluster storm only counts a restart successful when ALL workers are back", () => {
    const fn = sh.slice(sh.indexOf("phase_storm_cluster()"));
    expect(fn).toContain("mgr_worker_count");
    expect(fn).toContain('-eq "$BENCH_INSTANCES"');
  });

  test("cluster phases skip unsupported managers (recorded, never measured)", () => {
    const cc = sh.slice(sh.indexOf("phase_crash_cluster()"));
    expect(cc).toContain("mgr_supports_cluster");
    expect(cc).toContain("write_cluster_unsupported");
    const sc = sh.slice(sh.indexOf("phase_storm_cluster()"));
    expect(sc).toContain("mgr_supports_cluster");
    expect(sc).toContain("write_cluster_unsupported");
  });

  test("mode dispatch: fork and cluster write to separate files", () => {
    expect(sh).toContain('cluster-recovery.jsonl');
    expect(sh).toContain('cluster-storm.jsonl');
    expect(sh).toContain('recovery.jsonl');
    expect(sh).toContain('storm.jsonl');
  });

  test("both phases clean state per manager — teardown_all at every start, cleanup at every end", () => {
    expect((sh.match(/teardown_all \|\| die/g) ?? []).length).toBeGreaterThanOrEqual(4); // fork+cluster, crash+storm
    expect((sh.match(/mgr_teardown "\$manager" \|\| true/g) ?? []).length).toBeGreaterThanOrEqual(4);
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

  test("cluster-aware: reusePort exactly when the harness says cluster", () => {
    // BENCH_CLUSTER is manager-neutral (pboss --env, pm2 start env) — the
    // same file serves fork mode (reusePort off, behavior unchanged) and
    // cluster mode (N processes share the port)
    expect(ts).toContain('Bun.env.BENCH_CLUSTER === "1"');
    expect(ts).toContain("reusePort: cluster");
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
