#!/usr/bin/env node
/**
 * pboss-vs-pm2 Bun benchmark — aggregator + comparison report generator.
 *
 * Reads everything scripts/benchmark.sh and scripts/crash-recovery.sh wrote
 * under results/ and produces:
 *
 *   results/summary.csv          one row per (manager × load): median RPS,
 *                                latency percentiles, CPU, memory, startup
 *   results/summary-phases.csv   idle / warm-startup / recovery / storm rows
 *   results/REPORT.md            the human comparison
 *
 * The relative difference for every metric is the same formula:
 *
 *     (pboss − pm2) / pm2 × 100 %
 *
 * Positive means pboss scored the HIGHER NUMBER. For throughput higher is
 * better; for latency, CPU, memory, startup and recovery LOWER is better —
 * each table's Difference column marks the winner so a sign is never
 * misread.
 *
 * Pure math and rendering live in exported functions (tests drive them with
 * fixture data); only loadEverything() touches the filesystem.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { computeAggregates, median as medianSorted } from "./collect-resources.mjs";

// ── pure statistics ────────────────────────────────────────────────────────

export function mean(xs) {
  const vals = xs.filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
}

export function median(xs) {
  // sort a COPY — medianSorted expects pre-sorted input. Empty input is
  // UNKNOWN, not zero: autocannon's p95 can be null, and a fake 0.00 ms
  // would be a lie ("—" is the honest rendering).
  const vals = xs.filter(Number.isFinite);
  return vals.length ? medianSorted([...vals].sort((a, b) => a - b)) : NaN;
}

export function stdev(xs) {
  const vals = xs.filter(Number.isFinite);
  if (vals.length < 2) return NaN;
  const m = mean(vals);
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1));
}

export function maxOf(xs) {
  const vals = xs.filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : NaN;
}

/** (pboss − pm2) / pm2 × 100 — null when the baseline is unusable. */
export function relDiff(pbossVal, pm2Val) {
  if (!Number.isFinite(pbossVal) || !Number.isFinite(pm2Val) || pm2Val === 0) return null;
  return ((pbossVal - pm2Val) / pm2Val) * 100;
}

// ── parsing (the files the harness writes) ─────────────────────────────────

/** One resources CSV row: timestamp_ms,elapsed_s,cpu_percent,rss_mb,"pids" */
export function parseResourceCsvLine(line) {
  const m = line.match(/^(\d+),([\d.]+),(-?[\d.]+),([\d.]+),"?([^"]*)"?\s*$/);
  if (!m) return null;
  return {
    timestampMs: Number(m[1]),
    elapsedS: Number(m[2]),
    cpu: Number(m[3]),
    rssMb: Number(m[4]),
    pids: m[5],
  };
}

export function parseResourceCsv(text) {
  return text
    .split("\n")
    .slice(1) // header
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseResourceCsvLine)
    .filter(Boolean);
}

export function parseJsonl(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ── aggregation over one manager × load's runs ─────────────────────────────

/**
 * runs: [{ meta (run.jsonl line), loadgen (loadgen-N.json), resources (samples) }]
 * → the metric bundle the report and summary.csv show for that pair.
 */
export function aggregateLoad(runs) {
  const ok = runs.filter((r) => r.loadgen);
  const rps = ok.map((r) => r.loadgen.requests?.average ?? 0).filter(Number.isFinite);
  const cold = runs.map((r) => r.meta?.coldStartupMs).filter(Number.isFinite);
  const lat = (p) => ok.map((r) => r.loadgen.latency?.[p]).filter(Number.isFinite);
  const resourceAggs = ok
    .map((r) => computeAggregates(r.resources))
    .filter((a) => a && a.nSamples > 0);
  const pick = (fn) => (resourceAggs.length ? mean(resourceAggs.map(fn)) : NaN);
  return {
    runs: runs.length,
    measured: ok.length,
    rpsMean: mean(rps),
    rpsMedian: median(rps),
    rpsStdev: stdev(rps),
    rpsAll: rps,
    latencyAverageMedian: median(ok.map((r) => r.loadgen.latency?.average).filter(Number.isFinite)),
    p50Median: median(lat("p50")),
    p90Median: median(lat("p90")),
    p95Median: median(lat("p95")),
    p99Median: median(lat("p99")),
    errorsTotal: ok.reduce((a, r) => a + (r.loadgen.errors?.errors ?? 0), 0),
    timeoutsTotal: ok.reduce((a, r) => a + (r.loadgen.errors?.timeouts ?? 0), 0),
    non2xxTotal: ok.reduce((a, r) => a + (r.loadgen.errors?.non2xx ?? 0), 0),
    cpuAvg: pick((a) => a.cpuAvg),
    cpuMedian: pick((a) => a.cpuMedian),
    cpuPeak: pick((a) => a.cpuPeak),
    rssAvgMb: pick((a) => a.rssAvgMb),
    rssMedianMb: pick((a) => a.rssMedianMb),
    coldStartupMedian: median(cold),
    coldStartupMean: mean(cold),
  };
}

// ── formatting ─────────────────────────────────────────────────────────────

const n0 = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const pct = (v) => (v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/**
 * A comparison row. `lowerIsBetter` decides which sign wins — the winner is
 * spelled out in the cell so the reader never has to recall the direction.
 * `dec` = decimal places (latency wants 2 — autocannon percentiles are
 * integer-ms and a sub-ms bun server saturates them at 0; the AVERAGE is
 * fractional and carries the real precision). `minBase` = smallest
 * baseline magnitude a percentage is meaningful for (a ±0.1 MB "growth"
 * over a ~0 MB baseline is noise, not a 216% regression).
 */
export function cmpRow(label, pm2Val, pbossVal, unit = "", lowerIsBetter = true, dec = 1, minBase = 0) {
  let d = relDiff(pbossVal, pm2Val);
  if (d !== null && Math.abs(pm2Val) < minBase) d = null;
  const winner =
    d === null || !Number.isFinite(d) || d === 0
      ? ""
      : lowerIsBetter
        ? d < 0 ? " ▸ pboss" : " ▸ pm2"
        : d > 0 ? " ▸ pboss" : " ▸ pm2";
  const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(dec)}${unit}` : "—");
  return `| ${label} | ${fmt(pm2Val)} | ${fmt(pbossVal)} | ${pct(d)}${winner} |`;
}

function mdTable(header, rows) {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows].join("\n");
}

// ── report rendering (pure: data in, markdown out) ─────────────────────────

export function buildReport(data) {
  const { meta, byLoad, loads, warmStartup, idle, crash, storm, soak } = data;
  const L = [];

  L.push("# pboss vs pm2 — managing a Bun HTTP server (fork mode)", "");
  L.push(
    "The same `server.ts`, the same Bun executable, the same machine, the same",
    "load — the only difference is which process manager supervises it. This",
    "measures the **overhead of managing** a Bun server, not Bun's raw HTTP",
    "performance.",
    "",
  );

  if (meta) {
    const m = meta.machine ?? {};
    const v = meta.versions ?? {};
    const c = meta.config ?? {};
    L.push(mdTable(["Environment", ""], [
      `| Date | ${meta.startedAt ?? "unknown"} |`,
      `| OS | ${m.os ?? "?"} — kernel ${m.kernel ?? "?"} |`,
      `| CPU | ${m.cores ?? "?"} × ${m.cpu ?? "?"} |`,
      `| Memory | ${Number.isFinite(m.memMb) ? `${m.memMb} MB` : "?"} |`,
      `| Versions | bun ${v.bun ?? "?"} · node ${v.node ?? "?"} · pm2 ${v.pm2 ?? "?"} · pboss ${v.pboss ?? "?"} |`,
      `| Profile | ${c.profile ?? "?"} — loads ${(c.connections ?? []).join("/")} conns, ` +
        `${c.durationSec ?? "?"}s each, ${c.warmupSec ?? "?"}s warmup, ${c.repeats ?? "?"} repeat(s) per manager |`,
    ]), "");
  }

  L.push("## Methodology", "");
  L.push(
    "- Every measured run starts from a verified-clean state: app deleted, daemon",
    "  killed, port free, no orphaned processes — each run is a **cold start** of",
    "  the whole manager stack (that cold-start time is itself measured).",
    "- A discarded warmup run precedes every measured run.",
    "- Manager order alternates between runs (load index + repeat parity) so",
    "  time-of-run bias cannot favor one column.",
    `- CPU and memory cover the **whole process tree** (daemon + managed Bun`,
    `  server), sampled from \`/proc\` every ${(meta?.config?.sampleIntervalMs ?? 500) / 1000}s during the measured run.`,
    "- Crash-recovery and restart-storm runs are separate phases and never",
    "  overlap the HTTP measurements.",
    "- **Same-machine caveat:** the load generator shares the CPUs with the",
    "  servers (a dedicated load machine is better); absolute numbers are",
    "  specific to this box — compare the two columns, don't quote them as",
    "  platform throughput.",
    "",
  );

  if (!loads.length) {
    L.push("_No load runs found — run `bash scripts/benchmark.sh` first._", "");
  }

  // ── headline table (the user-facing summary, at the busiest sane load) ──
  const headlineLoad = loads.includes(100) ? 100 : loads[Math.floor(loads.length / 2)];
  if (loads.length) {
    const pm2 = byLoad[headlineLoad]?.pm2;
    const pboss = byLoad[headlineLoad]?.pboss;
    L.push(`## Headline — ${headlineLoad} connections`, "");
    L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
      cmpRow("Average requests/sec", pm2?.rpsMean, pboss?.rpsMean, "", false),
      cmpRow("Average latency (mean)", pm2?.latencyAverageMedian, pboss?.latencyAverageMedian, " ms", true, 2),
      cmpRow("Median p50 latency", pm2?.p50Median, pboss?.p50Median, " ms", true, 2),
      cmpRow("Median p95 latency", pm2?.p95Median, pboss?.p95Median, " ms", true, 2),
      cmpRow("Median p99 latency", pm2?.p99Median, pboss?.p99Median, " ms", true, 2),
      cmpRow("Average CPU usage (tree)", pm2?.cpuAvg, pboss?.cpuAvg, " %"),
      cmpRow("Average memory (tree)", pm2?.rssAvgMb, pboss?.rssAvgMb, " MB"),
      cmpRow("Average cold startup", pm2?.coldStartupMean, pboss?.coldStartupMean, " ms"),
      cmpRow("Average crash recovery", mean(crash?.pm2?.recoveryMs ?? []), mean(crash?.pboss?.recoveryMs ?? []), " ms"),
    ]), "");
    L.push(
      "_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as",
      "0.00 — read the average-latency row for sub-ms precision, and p99 for",
      "tail behavior._",
      "",
    );
    L.push(
      "_Throughput relative difference = (pboss − pm2) / pm2 × 100. For every other",
      "metric lower is better, and the arrow names the column that won._",
      "",
    );
  }

  // ── per-load tables ──────────────────────────────────────────────────────
  for (const conns of loads) {
    const pm2 = byLoad[conns]?.pm2;
    const pboss = byLoad[conns]?.pboss;
    L.push(`## Load: ${conns} connections`, "");
    if (!pm2 && !pboss) {
      L.push("_no data_", "");
      continue;
    }
    L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
      cmpRow("Median requests/sec", pm2?.rpsMedian, pboss?.rpsMedian, "", false),
      cmpRow("Mean requests/sec", pm2?.rpsMean, pboss?.rpsMean, "", false),
      cmpRow("RPS stdev (variability)", pm2?.rpsStdev, pboss?.rpsStdev),
      cmpRow("Average latency (mean)", pm2?.latencyAverageMedian, pboss?.latencyAverageMedian, " ms", true, 2),
      cmpRow("Median p50 latency", pm2?.p50Median, pboss?.p50Median, " ms", true, 2),
      cmpRow("Median p90 latency", pm2?.p90Median, pboss?.p90Median, " ms", true, 2),
      cmpRow("Median p95 latency", pm2?.p95Median, pboss?.p95Median, " ms", true, 2),
      cmpRow("Median p99 latency", pm2?.p99Median, pboss?.p99Median, " ms", true, 2),
      cmpRow("Errors (total)", pm2?.errorsTotal, pboss?.errorsTotal, "", true, 0),
      cmpRow("Timeouts (total)", pm2?.timeoutsTotal, pboss?.timeoutsTotal, "", true, 0),
      cmpRow("Non-2xx (total)", pm2?.non2xxTotal, pboss?.non2xxTotal, "", true, 0),
      cmpRow("Avg CPU % of tree", pm2?.cpuAvg, pboss?.cpuAvg),
      cmpRow("Median CPU % of tree", pm2?.cpuMedian, pboss?.cpuMedian),
      cmpRow("Peak CPU % of tree", pm2?.cpuPeak, pboss?.cpuPeak),
      cmpRow("Avg tree memory", pm2?.rssAvgMb, pboss?.rssAvgMb, " MB"),
      cmpRow("Median tree memory", pm2?.rssMedianMb, pboss?.rssMedianMb, " MB"),
      cmpRow("Cold startup (median)", pm2?.coldStartupMedian, pboss?.coldStartupMedian, " ms"),
    ]), "");
    L.push(
      `_Runs: ${pm2?.measured ?? 0} pm2 / ${pboss?.measured ?? 0} pboss.` +
        " RPS per run: pm2 [" + (pm2?.rpsAll ?? []).map(n0).join(", ") + "]" +
        " · pboss [" + (pboss?.rpsAll ?? []).map(n0).join(", ") + "]_",
      "",
    );
  }

  // ── startup ──────────────────────────────────────────────────────────────
  L.push("## Startup time", "");
  L.push(
    "Cold = daemon down, start command → first 200 from `/health` (daemon boot",
    "included; median over the load runs). Warm = daemon already up.",
    "",
  );
  const coldPm2 = loads.map((c) => byLoad[c]?.pm2?.coldStartupMedian).filter(Number.isFinite);
  const coldPboss = loads.map((c) => byLoad[c]?.pboss?.coldStartupMedian).filter(Number.isFinite);
  L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
    cmpRow("Cold startup (median of medians)", median(coldPm2), median(coldPboss), " ms"),
    cmpRow("Warm startup (median)", median(warmStartup?.pm2 ?? []), median(warmStartup?.pboss ?? []), " ms"),
    cmpRow("Warm startup (max)", maxOf(warmStartup?.pm2 ?? []), maxOf(warmStartup?.pboss ?? []), " ms"),
  ]), "");

  // ── idle ─────────────────────────────────────────────────────────────────
  L.push("", "## Idle daemon overhead (no application running)", "");
  L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
    cmpRow("Median CPU %", idle?.pm2?.cpuMedian, idle?.pboss?.cpuMedian),
    cmpRow("Median memory", idle?.pm2?.rssMedianMb, idle?.pboss?.rssMedianMb, " MB"),
  ]), "");

  // ── crash recovery ───────────────────────────────────────────────────────
  L.push("", "## Crash recovery (SIGKILL the server → `/health` back to 200)", "");
  L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
    cmpRow("Recovery (mean)", mean(crash?.pm2?.recoveryMs ?? []), mean(crash?.pboss?.recoveryMs ?? []), " ms"),
    cmpRow("Recovery (median)", median(crash?.pm2?.recoveryMs ?? []), median(crash?.pboss?.recoveryMs ?? []), " ms"),
    cmpRow("Recovery (max)", maxOf(crash?.pm2?.recoveryMs ?? []), maxOf(crash?.pboss?.recoveryMs ?? []), " ms"),
    cmpRow("Failed recoveries", crash?.pm2?.failures, crash?.pboss?.failures, "", true, 0),
  ]), "");

  // ── restart storm ────────────────────────────────────────────────────────
  L.push("", "## Restart storm", "");
  L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
    cmpRow("Restarts attempted", storm?.pm2?.restarts, storm?.pboss?.restarts, "", false, 0),
    cmpRow("Restart time (median)", median(storm?.pm2?.restartMs ?? []), median(storm?.pboss?.restartMs ?? []), " ms"),
    cmpRow("Failed restarts", storm?.pm2?.failures, storm?.pboss?.failures, "", true, 0),
    cmpRow("Orphaned processes after", storm?.pm2?.orphans, storm?.pboss?.orphans, "", true, 0),
    cmpRow("App RSS before", (storm?.pm2?.rssBeforeKb ?? NaN) / 1024, (storm?.pboss?.rssBeforeKb ?? NaN) / 1024, " MB"),
    cmpRow("App RSS after", (storm?.pm2?.rssAfterKb ?? NaN) / 1024, (storm?.pboss?.rssAfterKb ?? NaN) / 1024, " MB"),
    cmpRow("Memory growth (after − before)",
      Number.isFinite(storm?.pm2?.rssAfterKb) && Number.isFinite(storm?.pm2?.rssBeforeKb)
        ? (storm.pm2.rssAfterKb - storm.pm2.rssBeforeKb) / 1024 : NaN,
      Number.isFinite(storm?.pboss?.rssAfterKb) && Number.isFinite(storm?.pboss?.rssBeforeKb)
        ? (storm.pboss.rssAfterKb - storm.pboss.rssBeforeKb) / 1024 : NaN,
      " MB", true, 1, 1),
  ]), "");

  // ── soak (optional) ──────────────────────────────────────────────────────
  if (soak?.pm2 || soak?.pboss) {
    L.push("", "## Soak (sustained load)", "");
    L.push(mdTable(["Metric", "pm2", "pboss", "Difference"], [
      cmpRow("Median CPU % of tree", soak?.pm2?.cpuMedian, soak?.pboss?.cpuMedian),
      cmpRow("Median tree memory", soak?.pm2?.rssMedianMb, soak?.pboss?.rssMedianMb, " MB"),
      cmpRow("Median p95 latency", soak?.pm2?.p95, soak?.pboss?.p95, " ms"),
      cmpRow("Median p99 latency", soak?.pm2?.p99, soak?.pboss?.p99, " ms"),
      cmpRow("Errors (total)", soak?.pm2?.errors, soak?.pboss?.errors),
    ]), "");
  }

  L.push("", "## Reproduce", "");
  L.push(
    "```bash",
    "cd benchmarks/bun",
    "npm install                     # pm2 + autocannon (local, pinned)",
    "bash scripts/benchmark.sh       # default profile — BENCH_PROFILE=smoke first",
    "BENCH_PROFILE=full bash scripts/benchmark.sh    # + the 1000-conn stress level",
    "# from a pboss repo checkout instead of an installed CLI:",
    '# PBOSS_CMD="bun run /path/to/pboss/src/main.ts" bash scripts/benchmark.sh',
    "```",
    "",
    "Raw data: every number above traces to a file under `results/raw/` —",
    "`run.jsonl` records, full autocannon JSON, `/proc` resource CSVs, recovery",
    "and storm event logs. `results/summary.csv` is the same data in one sheet.",
    "",
    "_Don't read one run. The medians and the per-run lists above show the",
    "repeats and the variability; a single run never decides a column._",
    "",
  );

  return L.join("\n");
}

// ── summary.csv (pure) ─────────────────────────────────────────────────────

export function buildSummaryCsv(data) {
  const cols = [
    "manager", "connections", "runs", "measured",
    "rps_mean", "rps_median", "rps_stdev",
    "p50_ms_median", "p90_ms_median", "p95_ms_median", "p99_ms_median",
    "errors_total", "timeouts_total", "non2xx_total",
    "cpu_avg_pct", "cpu_median_pct", "cpu_peak_pct",
    "rss_avg_mb", "rss_median_mb",
    "cold_startup_ms_median",
  ];
  const lines = [cols.join(",")];
  const v = (x) => (Number.isFinite(x) ? (Number.isInteger(x) ? x : x.toFixed(2)) : "");
  for (const conns of data.loads) {
    for (const manager of ["pm2", "pboss"]) {
      const a = data.byLoad[conns]?.[manager];
      if (!a) continue;
      lines.push([
        manager, conns, a.runs, a.measured,
        v(a.rpsMean), v(a.rpsMedian), v(a.rpsStdev),
        v(a.p50Median), v(a.p90Median), v(a.p95Median), v(a.p99Median),
        a.errorsTotal, a.timeoutsTotal, a.non2xxTotal,
        v(a.cpuAvg), v(a.cpuMedian), v(a.cpuPeak),
        v(a.rssAvgMb), v(a.rssMedianMb),
        v(a.coldStartupMedian),
      ].join(","));
    }
  }
  return lines.join("\n") + "\n";
}

export function buildPhasesCsv(data) {
  const rows = [
    "manager,phase,metric,value",
    `pm2,idle,cpu_median_pct,${Number.isFinite(data.idle?.pm2?.cpuMedian) ? data.idle.pm2.cpuMedian.toFixed(2) : ""}`,
    `pm2,idle,rss_median_mb,${Number.isFinite(data.idle?.pm2?.rssMedianMb) ? data.idle.pm2.rssMedianMb.toFixed(2) : ""}`,
    `pboss,idle,cpu_median_pct,${Number.isFinite(data.idle?.pboss?.cpuMedian) ? data.idle.pboss.cpuMedian.toFixed(2) : ""}`,
    `pboss,idle,rss_median_mb,${Number.isFinite(data.idle?.pboss?.rssMedianMb) ? data.idle.pboss.rssMedianMb.toFixed(2) : ""}`,
  ];
  const fv = (x) => (Number.isFinite(x) ? x.toFixed(2) : "");
  rows.push(`pm2,warm_startup_ms,median,${fv(median(data.warmStartup?.pm2 ?? []))}`);
  rows.push(`pboss,warm_startup_ms,median,${fv(median(data.warmStartup?.pboss ?? []))}`);
  rows.push(`pm2,crash_recovery_ms,mean,${fv(mean(data.crash?.pm2?.recoveryMs ?? []))}`);
  rows.push(`pm2,crash_recovery_ms,median,${fv(median(data.crash?.pm2?.recoveryMs ?? []))}`);
  rows.push(`pboss,crash_recovery_ms,mean,${fv(mean(data.crash?.pboss?.recoveryMs ?? []))}`);
  rows.push(`pboss,crash_recovery_ms,median,${fv(median(data.crash?.pboss?.recoveryMs ?? []))}`);
  rows.push(`pm2,crash_recovery,failures,${data.crash?.pm2?.failures ?? ""}`);
  rows.push(`pboss,crash_recovery,failures,${data.crash?.pboss?.failures ?? ""}`);
  rows.push(`pm2,restart_ms,median,${fv(median(data.storm?.pm2?.restartMs ?? []))}`);
  rows.push(`pboss,restart_ms,median,${fv(median(data.storm?.pboss?.restartMs ?? []))}`);
  rows.push(`pm2,restart_storm,failures,${data.storm?.pm2?.failures ?? ""}`);
  rows.push(`pboss,restart_storm,failures,${data.storm?.pboss?.failures ?? ""}`);
  rows.push(`pm2,restart_storm,orphans,${data.storm?.pm2?.orphans ?? ""}`);
  rows.push(`pboss,restart_storm,orphans,${data.storm?.pboss?.orphans ?? ""}`);
  return rows.join("\n") + "\n";
}

// ── filesystem loading ─────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function loadEverything(resultsDir) {
  const data = {
    meta: readJson(join(resultsDir, "meta.json")),
    byLoad: {},
    loads: [],
    warmStartup: { pm2: [], pboss: [] },
    idle: {},
    crash: {},
    storm: {},
    soak: {},
  };

  for (const manager of ["pm2", "pboss"]) {
    const mdir = join(resultsDir, "raw", manager);
    if (!existsSync(mdir)) continue;

    // load runs: raw/<manager>/c<conns>/
    for (const entry of readdirSync(mdir)) {
      const mLoad = entry.match(/^c(\d+)$/);
      if (!mLoad) continue;
      const conns = Number(mLoad[1]);
      const ldir = join(mdir, entry);
      const runs = parseJsonl(readText(join(ldir, "run.jsonl"))).map((meta) => {
        const loadgen = readJson(join(ldir, `loadgen-${meta.repeat}.json`));
        const resources = parseResourceCsv(readText(join(ldir, `resources-${meta.repeat}.csv`)));
        return { meta, loadgen, resources };
      });
      if (!runs.length) continue;
      data.byLoad[conns] = data.byLoad[conns] ?? {};
      data.byLoad[conns][manager] = aggregateLoad(runs);
    }

    // phases.jsonl: idle + warm-startup
    for (const rec of parseJsonl(readText(join(mdir, "phases.jsonl")))) {
      if (rec.phase === "warm-startup" && Number.isFinite(rec.startupMs)) {
        data.warmStartup[manager].push(rec.startupMs);
      }
    }
    if (existsSync(join(mdir, "idle.csv"))) {
      const agg = computeAggregates(parseResourceCsv(readText(join(mdir, "idle.csv"))));
      if (agg.nSamples > 0) data.idle[manager] = agg;
    }

    // recovery.jsonl: crash recoveries + failures
    const recs = parseJsonl(readText(join(mdir, "recovery.jsonl")));
    if (recs.length) {
      data.crash[manager] = {
        recoveryMs: recs.filter((r) => Number.isFinite(r.recoveryMs)).map((r) => r.recoveryMs),
        failures: recs.filter((r) => r.recoveryFailed === true).length,
      };
    }

    // storm.jsonl: restarts + summary line
    const stormRecs = parseJsonl(readText(join(mdir, "storm.jsonl")));
    if (stormRecs.length) {
      const summary = stormRecs.find((r) => r.summary === true) ?? {};
      data.storm[manager] = {
        restartMs: stormRecs.filter((r) => Number.isFinite(r.restartMs)).map((r) => r.restartMs),
        restarts: summary.restarts ?? stormRecs.filter((r) => Number.isFinite(r.restartMs)).length,
        failures: summary.failures ?? stormRecs.filter((r) => r.restartFailed === true).length,
        orphans: summary.orphans ?? NaN,
        rssBeforeKb: summary.rssBeforeKb ?? NaN,
        rssAfterKb: summary.rssAfterKb ?? NaN,
      };
    }

    // soak (optional)
    const soakLoadgen = readJson(join(mdir, "soak-loadgen.json"));
    const soakCsv = existsSync(join(mdir, "soak.csv"))
      ? computeAggregates(parseResourceCsv(readText(join(mdir, "soak.csv"))))
      : null;
    if (soakLoadgen || soakCsv?.nSamples) {
      data.soak[manager] = {
        cpuMedian: soakCsv?.cpuMedian ?? NaN,
        rssMedianMb: soakCsv?.rssMedianMb ?? NaN,
        p95: soakLoadgen?.latency?.p95 ?? NaN,
        p99: soakLoadgen?.latency?.p99 ?? NaN,
        errors: soakLoadgen?.errors?.errors ?? NaN,
      };
    }
  }

  data.loads = Object.keys(data.byLoad)
    .map(Number)
    .sort((a, b) => a - b);

  return data;
}

// ── console summary (what a nohup log ends with) ───────────────────────────

export function consoleSummary(data) {
  const lines = [];
  for (const conns of data.loads) {
    const pm2 = data.byLoad[conns]?.pm2;
    const pboss = data.byLoad[conns]?.pboss;
    lines.push(
      `c=${conns}: pm2 ${n0(pm2?.rpsMedian)} rps (p50 ${n1(pm2?.p50Median)}ms) · ` +
      `pboss ${n0(pboss?.rpsMedian)} rps (p50 ${n1(pboss?.p50Median)}ms) · ` +
      `diff ${pct(relDiff(pboss?.rpsMedian, pm2?.rpsMedian))}`,
    );
  }
  return lines.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const i = argv.indexOf("--results");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const resultsDir = i !== -1 ? argv[i + 1] : join(scriptDir, "..", "results");
  if (!existsSync(resultsDir)) {
    console.error(`summarize: results dir not found: ${resultsDir}`);
    exit(1);
  }
  const data = loadEverything(resultsDir);
  const report = buildReport(data);
  writeFileSync(join(resultsDir, "REPORT.md"), report);
  writeFileSync(join(resultsDir, "summary.csv"), buildSummaryCsv(data));
  writeFileSync(join(resultsDir, "summary-phases.csv"), buildPhasesCsv(data));
  console.log(consoleSummary(data));
  console.log(`\nreport: ${join(resultsDir, "REPORT.md")}`);
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    exit(1);
  });
}
