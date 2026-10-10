#!/usr/bin/env node
/**
 * pboss-vs-pm2 Bun benchmark — aggregator + comparison report generator.
 *
 * Reads everything scripts/benchmark.sh and scripts/crash-recovery.sh wrote
 * under results/ and produces:
 *
 *   results/summary.csv          one row per (mode × manager × load)
 *   results/summary-phases.csv   idle / warm-startup / recovery / storm rows
 *   results/REPORT.md            the human comparison (markdown)
 *   results/REPORT.html          the same comparison as a self-contained
 *                                HTML page — the HTML version of the summary
 *
 * Every comparison table's last column is the WINNER: it names the manager
 * that scored better on that row, with the relative difference next to it —
 * always the same formula:
 *
 *     (pboss − pm2) / pm2 × 100 %
 *
 * Positive means pboss scored the HIGHER NUMBER. For throughput higher is
 * better; for latency, CPU, memory, startup and recovery LOWER is better —
 * the winner already accounts for the direction, so a name is never misread
 * off a sign (and a row that is exactly level is a "tie").
 *
 * Modes: fork (one managed process) and cluster (BENCH_INSTANCES workers on
 * one SO_REUSEPORT port). A mode's tables only ever compare the two managers
 * within the same mode — the manager stays the only variable.
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

/**
 * The Winner column's logic, isolated so markdown and HTML render the SAME
 * verdict from the same numbers. `lowerIsBetter` decides which direction
 * wins; `minBase` = smallest baseline magnitude a percentage is meaningful
 * for (±0.1 MB "growth" over a ~0 MB baseline is noise, not a 216%
 * regression). Returns { diff, winner } — winner is "pboss" | "pm2" | "tie",
 * or null when the numbers cannot support a verdict at all.
 */
export function winnerOf(pm2Val, pbossVal, lowerIsBetter = true, minBase = 0) {
  let d = relDiff(pbossVal, pm2Val);
  if (d !== null && Math.abs(pm2Val) < minBase) d = null;
  if (d === null || !Number.isFinite(d)) return { diff: null, winner: null };
  if (d === 0) return { diff: 0, winner: "tie" };
  const pbossBetter = lowerIsBetter ? d < 0 : d > 0;
  return { diff: d, winner: pbossBetter ? "pboss" : "pm2" };
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
 * One comparison cell's worth of data: formatted pm2/pboss values plus the
 * Winner verdict. `dec` = decimal places (latency wants 2 — autocannon
 * percentiles are integer-ms and a sub-ms bun server saturates them at 0;
 * the AVERAGE is fractional and carries the real precision).
 */
export function cmpCell(pm2Val, pbossVal, unit = "", lowerIsBetter = true, dec = 1, minBase = 0) {
  const { diff, winner } = winnerOf(pm2Val, pbossVal, lowerIsBetter, minBase);
  const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(dec)}${unit}` : "—");
  return { pm2: fmt(pm2Val), pboss: fmt(pbossVal), winner, diff };
}

/** The Winner cell: "pboss (+8.3%)" / "pm2 (+5.0%)" / "tie" / "—". */
export function winnerText({ winner, diff }) {
  if (winner === null) return "—";
  if (winner === "tie") return "tie";
  return `${winner} (${pct(diff)})`;
}

/** A markdown comparison row with the Winner column. */
export function cmpRow(label, pm2Val, pbossVal, unit = "", lowerIsBetter = true, dec = 1, minBase = 0) {
  const cell = cmpCell(pm2Val, pbossVal, unit, lowerIsBetter, dec, minBase);
  return `| ${label} | ${cell.pm2} | ${cell.pboss} | ${winnerText(cell)} |`;
}

function mdTable(header, rows) {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows].join("\n");
}

// ── shared section data (markdown + html render these, so they cannot drift) ─

/** The row bundle the load tables show for one (mode, load). */
function loadRows(pm2, pboss) {
  return [
    { label: "Median requests/sec", cell: cmpCell(pm2?.rpsMedian, pboss?.rpsMedian, "", false) },
    { label: "Mean requests/sec", cell: cmpCell(pm2?.rpsMean, pboss?.rpsMean, "", false) },
    { label: "RPS stdev (variability)", cell: cmpCell(pm2?.rpsStdev, pboss?.rpsStdev) },
    { label: "Average latency (mean)", cell: cmpCell(pm2?.latencyAverageMedian, pboss?.latencyAverageMedian, " ms", true, 2) },
    { label: "Median p50 latency", cell: cmpCell(pm2?.p50Median, pboss?.p50Median, " ms", true, 2) },
    { label: "Median p90 latency", cell: cmpCell(pm2?.p90Median, pboss?.p90Median, " ms", true, 2) },
    { label: "Median p95 latency", cell: cmpCell(pm2?.p95Median, pboss?.p95Median, " ms", true, 2) },
    { label: "Median p99 latency", cell: cmpCell(pm2?.p99Median, pboss?.p99Median, " ms", true, 2) },
    { label: "Errors (total)", cell: cmpCell(pm2?.errorsTotal, pboss?.errorsTotal, "", true, 0) },
    { label: "Timeouts (total)", cell: cmpCell(pm2?.timeoutsTotal, pboss?.timeoutsTotal, "", true, 0) },
    { label: "Non-2xx (total)", cell: cmpCell(pm2?.non2xxTotal, pboss?.non2xxTotal, "", true, 0) },
    { label: "Avg CPU % of tree", cell: cmpCell(pm2?.cpuAvg, pboss?.cpuAvg) },
    { label: "Median CPU % of tree", cell: cmpCell(pm2?.cpuMedian, pboss?.cpuMedian) },
    { label: "Peak CPU % of tree", cell: cmpCell(pm2?.cpuPeak, pboss?.cpuPeak) },
    { label: "Avg tree memory", cell: cmpCell(pm2?.rssAvgMb, pboss?.rssAvgMb, " MB") },
    { label: "Median tree memory", cell: cmpCell(pm2?.rssMedianMb, pboss?.rssMedianMb, " MB") },
    { label: "Cold startup (median)", cell: cmpCell(pm2?.coldStartupMedian, pboss?.coldStartupMedian, " ms") },
  ];
}

/** The shortened headline bundle (the busiest sane load, one mode). */
function headlineRows(pm2, pboss) {
  return [
    { label: "Average requests/sec", cell: cmpCell(pm2?.rpsMean, pboss?.rpsMean, "", false) },
    { label: "Average latency (mean)", cell: cmpCell(pm2?.latencyAverageMedian, pboss?.latencyAverageMedian, " ms", true, 2) },
    { label: "Median p50 latency", cell: cmpCell(pm2?.p50Median, pboss?.p50Median, " ms", true, 2) },
    { label: "Median p95 latency", cell: cmpCell(pm2?.p95Median, pboss?.p95Median, " ms", true, 2) },
    { label: "Median p99 latency", cell: cmpCell(pm2?.p99Median, pboss?.p99Median, " ms", true, 2) },
    { label: "Average CPU usage (tree)", cell: cmpCell(pm2?.cpuAvg, pboss?.cpuAvg, " %") },
    { label: "Average memory (tree)", cell: cmpCell(pm2?.rssAvgMb, pboss?.rssAvgMb, " MB") },
    { label: "Average cold startup", cell: cmpCell(pm2?.coldStartupMean, pboss?.coldStartupMean, " ms") },
  ];
}

const WINNER_NOTE = [
  "_Winner names the column that scored better; the percentage beside it is the",
  "relative difference (pboss − pm2) / pm2 × 100 — positive means pboss scored",
  "the higher number. For throughput higher is better; for every other metric",
  "in these tables lower is better, and the Winner column already accounts for",
  "the direction. A row that is exactly level reads “tie”._",
].join(" ");

// ── report rendering (pure: data in, markdown out) ─────────────────────────

export function buildReport(data) {
  const fork = data.modes?.fork ?? { loads: [], byLoad: {} };
  const cluster = data.modes?.cluster ?? { loads: [], byLoad: {} };
  const hasFork = fork.loads.length > 0;
  const hasCluster = cluster.loads.length > 0;
  const L = [];

  L.push("# pboss vs pm2 — managing a Bun HTTP server", "");
  L.push(
    "The same `server.ts`, the same Bun executable, the same machine, the same",
    "load — the only difference is which process manager supervises it. This",
    "measures the **overhead of managing** a Bun server, not Bun's raw HTTP",
    "performance. Both supervision models are covered: **fork** (one managed",
    "process) and **cluster** (N workers sharing one port).",
    "",
    "_An HTML version of this summary lives beside it: `results/REPORT.html`._",
    "",
  );

  if (data.meta) {
    const m = data.meta.machine ?? {};
    const v = data.meta.versions ?? {};
    const c = data.meta.config ?? {};
    const envRows = [
      `| Date | ${data.meta.startedAt ?? "unknown"} |`,
      `| OS | ${m.os ?? "?"} — kernel ${m.kernel ?? "?"} |`,
      `| CPU | ${m.cores ?? "?"} × ${m.cpu ?? "?"} |`,
      `| Memory | ${Number.isFinite(m.memMb) ? `${m.memMb} MB` : "?"} |`,
      `| Versions | bun ${v.bun ?? "?"} · node ${v.node ?? "?"} · pm2 ${v.pm2 ?? "?"} · pboss ${v.pboss ?? "?"} |`,
      `| Profile | ${c.profile ?? "?"} — loads ${(c.connections ?? []).join("/")} conns, ` +
        `${c.durationSec ?? "?"}s each, ${c.warmupSec ?? "?"}s warmup, ${c.repeats ?? "?"} repeat(s) per manager |`,
    ];
    if (hasCluster) {
      const pm2Ns = data.clusterUnsupported?.pm2?.supported === false;
      envRows.push(`| Cluster | ${c.clusterInstances ?? "?"} workers · pboss (SO_REUSEPORT)${pm2Ns ? " · pm2: not supported" : ""} |`);
    }
    L.push(mdTable(["Environment", ""], envRows), "");
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
    `  server), sampled from \`/proc\` every ${(data.meta?.config?.sampleIntervalMs ?? 500) / 1000}s during the measured run.`,
    "- Crash-recovery and restart-storm runs are separate phases and never",
    "  overlap the HTTP measurements.",
    "- **Same-machine caveat:** the load generator shares the CPUs with the",
    "  servers (a dedicated load machine is better); absolute numbers are",
    "  specific to this box — compare the two columns, don't quote them as",
    "  platform throughput.",
  );
  if (hasCluster) {
    L.push(
      "- **Cluster mode** runs the same matrix for every manager that can",
      "  actually cluster a Bun app: pboss (its native process-based cluster,",
      "  `--instances N`, workers sharing one `SO_REUSEPORT` port). pm2",
      "  **cannot** — its cluster mode is `node:cluster` inside the pm2 daemon and",
      "  cannot wrap an app run with a non-Node interpreter — so it is reported",
      "  as **not supported** in the cluster section, never measured with",
      "  fork-mode numbers wearing a cluster label.",
    );
  }
  L.push("", WINNER_NOTE, "");

  const headlineLoad = (loads) =>
    loads.includes(100) ? 100 : loads[Math.floor(loads.length / 2)];

  if (!hasFork && !hasCluster) {
    L.push("_No load runs found — run `bash scripts/benchmark.sh` first._", "");
  }

  // ── fork sections ──
  if (hasFork) {
    const hl = headlineLoad(fork.loads);
    L.push(`## Fork mode — headline, ${hl} connections`, "");
    L.push(mdTable(["Metric", "pm2", "pboss", "Winner"],
      headlineRows(fork.byLoad[hl]?.pm2, fork.byLoad[hl]?.pboss).map((r) =>
        `| ${r.label} | ${r.cell.pm2} | ${r.cell.pboss} | ${winnerText(r.cell)} |`)), "");
    L.push(
      "_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as",
      "0.00 — read the average-latency row for sub-ms precision, and p99 for",
      "tail behavior._",
      "",
    );

    for (const conns of fork.loads) {
      const pm2 = fork.byLoad[conns]?.pm2;
      const pboss = fork.byLoad[conns]?.pboss;
      L.push(`## Fork mode — load: ${conns} connections`, "");
      if (!pm2 && !pboss) {
        L.push("_no data_", "");
        continue;
      }
      L.push(mdTable(["Metric", "pm2", "pboss", "Winner"],
        loadRows(pm2, pboss).map((r) =>
          `| ${r.label} | ${r.cell.pm2} | ${r.cell.pboss} | ${winnerText(r.cell)} |`)), "");
      L.push(
        `_Runs: ${pm2?.measured ?? 0} pm2 / ${pboss?.measured ?? 0} pboss.` +
          " RPS per run: pm2 [" + (pm2?.rpsAll ?? []).map(n0).join(", ") + "]" +
          " · pboss [" + (pboss?.rpsAll ?? []).map(n0).join(", ") + "]_",
        "",
      );
    }
  }

  // ── cluster sections ──
  const pm2ClusterUnsupported = data.clusterUnsupported?.pm2?.supported === false;
  if (hasCluster) {
    const instances = data.meta?.config?.clusterInstances;
    L.push(`## Cluster mode${Number.isFinite(instances) ? ` — ${instances} workers` : ""}`, "");
    L.push(
      "pboss supervises N Bun workers of the same `server.ts`, all binding the",
      "same port through `SO_REUSEPORT` (the kernel balances connections across",
      "them) — its native process-based cluster, `--instances N`.",
      "",
    );
    if (pm2ClusterUnsupported) {
      L.push(
        "> **pm2: cluster mode — not supported (Bun apps).** PM2's cluster mode is",
        "> implemented with `node:cluster` inside its Node daemon: `cluster.fork()`",
        "> always runs the daemon's own runtime and ignores `--interpreter`, and pm2",
        "> only selects cluster mode when the interpreter path contains \"node\" — so",
        "> `pm2 start -i N --interpreter bun` silently runs the instances in **fork",
        "> mode** (`exec_mode: fork_mode`, N plain processes, no port sharing), and",
        "> forcing `exec_mode: \"cluster_mode\"` runs the workers under **Node**, not",
        "> Bun. Rather than publish fork-mode numbers under a cluster label, this",
        "> benchmark records pm2 as not supported and measures only pboss in this",
        "> mode. (The `node` suite in this repo runs both managers' cluster modes.)",
        "",
      );
    }
    const hl = headlineLoad(cluster.loads);
    L.push(`### Cluster headline — ${hl} connections`, "");
    L.push(mdTable(["Metric", "pm2", "pboss", "Winner"],
      headlineRows(cluster.byLoad[hl]?.pm2, cluster.byLoad[hl]?.pboss).map((r) =>
        `| ${r.label} | ${r.cell.pm2} | ${r.cell.pboss} | ${winnerText(r.cell)} |`)), "");
    L.push(
      "_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as",
      "0.00 — read the average-latency row for sub-ms precision, and p99 for",
      "tail behavior._",
      "",
    );

    for (const conns of cluster.loads) {
      const pm2 = cluster.byLoad[conns]?.pm2;
      const pboss = cluster.byLoad[conns]?.pboss;
      L.push(`### Cluster load: ${conns} connections`, "");
      if (!pm2 && !pboss) {
        L.push("_no data_", "");
        continue;
      }
      L.push(mdTable(["Metric", "pm2", "pboss", "Winner"],
        loadRows(pm2, pboss).map((r) =>
          `| ${r.label} | ${r.cell.pm2} | ${r.cell.pboss} | ${winnerText(r.cell)} |`)), "");
      L.push(
        `_Runs: ${pm2?.measured ?? 0} pm2 / ${pboss?.measured ?? 0} pboss.` +
          " RPS per run: pm2 [" + (pm2?.rpsAll ?? []).map(n0).join(", ") + "]" +
          " · pboss [" + (pboss?.rpsAll ?? []).map(n0).join(", ") + "]_",
        "",
      );
    }
  }

  // ── startup ──────────────────────────────────────────────────────────────
  L.push("## Startup time", "");
  L.push(
    "Cold = daemon down, start command → first 200 from `/health` (daemon boot",
    "included; median over the load runs). Warm = daemon already up.",
    "",
  );
  const coldPm2 = fork.loads.map((c) => fork.byLoad[c]?.pm2?.coldStartupMedian).filter(Number.isFinite);
  const coldPboss = fork.loads.map((c) => fork.byLoad[c]?.pboss?.coldStartupMedian).filter(Number.isFinite);
  const coldClusterPm2 = cluster.loads.map((c) => cluster.byLoad[c]?.pm2?.coldStartupMedian).filter(Number.isFinite);
  const coldClusterPboss = cluster.loads.map((c) => cluster.byLoad[c]?.pboss?.coldStartupMedian).filter(Number.isFinite);
  L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
    cmpRow("Cold startup, fork (median of medians)", median(coldPm2), median(coldPboss), " ms"),
    cmpRow("Warm startup, fork (median)", median(data.warmStartup?.pm2 ?? []), median(data.warmStartup?.pboss ?? []), " ms"),
    cmpRow("Warm startup, fork (max)", maxOf(data.warmStartup?.pm2 ?? []), maxOf(data.warmStartup?.pboss ?? []), " ms"),
    ...(hasCluster ? [
      cmpRow("Cold startup, cluster (median of medians)", median(coldClusterPm2), median(coldClusterPboss), " ms"),
      cmpRow("Warm startup, cluster (median)", median(data.warmStartupCluster?.pm2 ?? []), median(data.warmStartupCluster?.pboss ?? []), " ms"),
      cmpRow("Warm startup, cluster (max)", maxOf(data.warmStartupCluster?.pm2 ?? []), maxOf(data.warmStartupCluster?.pboss ?? []), " ms"),
    ] : []),
  ]), "");

  // ── idle ─────────────────────────────────────────────────────────────────
  L.push("", "## Idle daemon overhead (no application running)", "");
  L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
    cmpRow("Median CPU %", data.idle?.pm2?.cpuMedian, data.idle?.pboss?.cpuMedian),
    cmpRow("Median memory", data.idle?.pm2?.rssMedianMb, data.idle?.pboss?.rssMedianMb, " MB"),
  ]), "");

  // ── crash recovery ───────────────────────────────────────────────────────
  L.push("", "## Crash recovery — fork (SIGKILL the server → `/health` back to 200)", "");
  L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
    cmpRow("Recovery (mean)", mean(data.crash?.pm2?.recoveryMs ?? []), mean(data.crash?.pboss?.recoveryMs ?? []), " ms"),
    cmpRow("Recovery (median)", median(data.crash?.pm2?.recoveryMs ?? []), median(data.crash?.pboss?.recoveryMs ?? []), " ms"),
    cmpRow("Recovery (max)", maxOf(data.crash?.pm2?.recoveryMs ?? []), maxOf(data.crash?.pboss?.recoveryMs ?? []), " ms"),
    cmpRow("Failed recoveries", data.crash?.pm2?.failures, data.crash?.pboss?.failures, "", true, 0),
  ]), "");

  if (hasCluster || data.crashCluster?.pm2 || data.crashCluster?.pboss) {
    L.push("", `## Crash recovery — cluster (SIGKILL one worker of ${data.meta?.config?.clusterInstances ?? "N"})`, "");
    L.push(
      "One worker is SIGKILLed; the survivors keep the shared port up. The",
      "numbers are the manager's worker **replacement time** and whether",
      "`/health` ever stopped answering (it should not, with workers left).",
      "",
    );
    const upRatio = (m) => {
      const d = data.crashCluster?.[m];
      if (!d || !d.healthTotal) return NaN;
      return (d.healthStayedUp / d.healthTotal) * 100;
    };
    L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
      cmpRow("Worker respawn (mean)", mean(data.crashCluster?.pm2?.respawnMs ?? []), mean(data.crashCluster?.pboss?.respawnMs ?? []), " ms"),
      cmpRow("Worker respawn (median)", median(data.crashCluster?.pm2?.respawnMs ?? []), median(data.crashCluster?.pboss?.respawnMs ?? []), " ms"),
      cmpRow("Worker respawn (max)", maxOf(data.crashCluster?.pm2?.respawnMs ?? []), maxOf(data.crashCluster?.pboss?.respawnMs ?? []), " ms"),
      cmpRow("Failed replacements", data.crashCluster?.pm2?.failures, data.crashCluster?.pboss?.failures, "", true, 0),
      cmpRow("Health stayed up", upRatio("pm2"), upRatio("pboss"), " % of kills", true, 1),
    ]), "");
  }

  // ── restart storm ────────────────────────────────────────────────────────
  L.push("", "## Restart storm — fork", "");
  L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
    cmpRow("Restarts attempted", data.storm?.pm2?.restarts, data.storm?.pboss?.restarts, "", false, 0),
    cmpRow("Restart time (median)", median(data.storm?.pm2?.restartMs ?? []), median(data.storm?.pboss?.restartMs ?? []), " ms"),
    cmpRow("Failed restarts", data.storm?.pm2?.failures, data.storm?.pboss?.failures, "", true, 0),
    cmpRow("Orphaned processes after", data.storm?.pm2?.orphans, data.storm?.pboss?.orphans, "", true, 0),
    cmpRow("App RSS before", (data.storm?.pm2?.rssBeforeKb ?? NaN) / 1024, (data.storm?.pboss?.rssBeforeKb ?? NaN) / 1024, " MB"),
    cmpRow("App RSS after", (data.storm?.pm2?.rssAfterKb ?? NaN) / 1024, (data.storm?.pboss?.rssAfterKb ?? NaN) / 1024, " MB"),
    cmpRow("Memory growth (after − before)",
      Number.isFinite(data.storm?.pm2?.rssAfterKb) && Number.isFinite(data.storm?.pm2?.rssBeforeKb)
        ? (data.storm.pm2.rssAfterKb - data.storm.pm2.rssBeforeKb) / 1024 : NaN,
      Number.isFinite(data.storm?.pboss?.rssAfterKb) && Number.isFinite(data.storm?.pboss?.rssBeforeKb)
        ? (data.storm.pboss.rssAfterKb - data.storm.pboss.rssBeforeKb) / 1024 : NaN,
      " MB", true, 1, 1),
  ]), "");

  if (hasCluster || data.stormCluster?.pm2 || data.stormCluster?.pboss) {
    L.push("", "## Restart storm — cluster (restart must bring back ALL workers)", "");
    L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
      cmpRow("Restarts attempted", data.stormCluster?.pm2?.restarts, data.stormCluster?.pboss?.restarts, "", false, 0),
      cmpRow("Restart time (median)", median(data.stormCluster?.pm2?.restartMs ?? []), median(data.stormCluster?.pboss?.restartMs ?? []), " ms"),
      cmpRow("Failed restarts", data.stormCluster?.pm2?.failures, data.stormCluster?.pboss?.failures, "", true, 0),
      cmpRow("Orphaned processes after", data.stormCluster?.pm2?.orphans, data.stormCluster?.pboss?.orphans, "", true, 0),
      cmpRow("Workers' RSS before", (data.stormCluster?.pm2?.rssBeforeKb ?? NaN) / 1024, (data.stormCluster?.pboss?.rssBeforeKb ?? NaN) / 1024, " MB"),
      cmpRow("Workers' RSS after", (data.stormCluster?.pm2?.rssAfterKb ?? NaN) / 1024, (data.stormCluster?.pboss?.rssAfterKb ?? NaN) / 1024, " MB"),
      cmpRow("Memory growth (after − before)",
        Number.isFinite(data.stormCluster?.pm2?.rssAfterKb) && Number.isFinite(data.stormCluster?.pm2?.rssBeforeKb)
          ? (data.stormCluster.pm2.rssAfterKb - data.stormCluster.pm2.rssBeforeKb) / 1024 : NaN,
        Number.isFinite(data.stormCluster?.pboss?.rssAfterKb) && Number.isFinite(data.stormCluster?.pboss?.rssBeforeKb)
          ? (data.stormCluster.pboss.rssAfterKb - data.stormCluster.pboss.rssBeforeKb) / 1024 : NaN,
        " MB", true, 1, 1),
    ]), "");
  }

  // ── soak (optional) ──────────────────────────────────────────────────────
  if (data.soak?.pm2 || data.soak?.pboss) {
    L.push("", "## Soak — fork (sustained load)", "");
    L.push(mdTable(["Metric", "pm2", "pboss", "Winner"], [
      cmpRow("Median CPU % of tree", data.soak?.pm2?.cpuMedian, data.soak?.pboss?.cpuMedian),
      cmpRow("Median tree memory", data.soak?.pm2?.rssMedianMb, data.soak?.pboss?.rssMedianMb, " MB"),
      cmpRow("Median p95 latency", data.soak?.pm2?.p95, data.soak?.pboss?.p95, " ms"),
      cmpRow("Median p99 latency", data.soak?.pm2?.p99, data.soak?.pboss?.p99, " ms"),
      cmpRow("Errors (total)", data.soak?.pm2?.errors, data.soak?.pboss?.errors),
    ]), "");
  }

  L.push("", "## Reproduce", "");
  L.push(
    "```bash",
    "cd benchmarks/bun",
    "npm install                     # pm2 + autocannon (local, pinned)",
    "bash scripts/benchmark.sh       # default profile — BENCH_PROFILE=smoke first",
    "BENCH_PROFILE=full bash scripts/benchmark.sh    # + the 1000-conn stress level",
    "BENCH_INSTANCES=4 bash scripts/benchmark.sh      # cluster workers (default: cores)",
    "# from a pboss repo checkout instead of an installed CLI:",
    '# PBOSS_CMD="bun run /path/to/pboss/src/main.ts" bash scripts/benchmark.sh',
    "```",
    "",
    "Raw data: every number above traces to a file under `results/raw/` —",
    "`run.jsonl` records, full autocannon JSON, `/proc` resource CSVs, recovery",
    "and storm event logs (fork and cluster each). `results/summary.csv` is the",
    "same data in one sheet; `results/REPORT.html` is this report as a page.",
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
    "mode", "manager", "connections", "runs", "measured",
    "rps_mean", "rps_median", "rps_stdev",
    "p50_ms_median", "p90_ms_median", "p95_ms_median", "p99_ms_median",
    "errors_total", "timeouts_total", "non2xx_total",
    "cpu_avg_pct", "cpu_median_pct", "cpu_peak_pct",
    "rss_avg_mb", "rss_median_mb",
    "cold_startup_ms_median",
  ];
  const lines = [cols.join(",")];
  const v = (x) => (Number.isFinite(x) ? (Number.isInteger(x) ? x : x.toFixed(2)) : "");
  for (const mode of ["fork", "cluster"]) {
    const md = data.modes?.[mode];
    if (!md) continue;
    for (const conns of md.loads) {
      for (const manager of ["pm2", "pboss"]) {
        const a = md.byLoad[conns]?.[manager];
        if (!a) continue;
        lines.push([
          mode, manager, conns, a.runs, a.measured,
          v(a.rpsMean), v(a.rpsMedian), v(a.rpsStdev),
          v(a.p50Median), v(a.p90Median), v(a.p95Median), v(a.p99Median),
          a.errorsTotal, a.timeoutsTotal, a.non2xxTotal,
          v(a.cpuAvg), v(a.cpuMedian), v(a.cpuPeak),
          v(a.rssAvgMb), v(a.rssMedianMb),
          v(a.coldStartupMedian),
        ].join(","));
      }
    }
  }
  return lines.join("\n") + "\n";
}

export function buildPhasesCsv(data) {
  const rows = [
    "mode,manager,phase,metric,value",
    `fork,pm2,idle,cpu_median_pct,${Number.isFinite(data.idle?.pm2?.cpuMedian) ? data.idle.pm2.cpuMedian.toFixed(2) : ""}`,
    `fork,pm2,idle,rss_median_mb,${Number.isFinite(data.idle?.pm2?.rssMedianMb) ? data.idle.pm2.rssMedianMb.toFixed(2) : ""}`,
    `fork,pboss,idle,cpu_median_pct,${Number.isFinite(data.idle?.pboss?.cpuMedian) ? data.idle.pboss.cpuMedian.toFixed(2) : ""}`,
    `fork,pboss,idle,rss_median_mb,${Number.isFinite(data.idle?.pboss?.rssMedianMb) ? data.idle.pboss.rssMedianMb.toFixed(2) : ""}`,
  ];
  const fv = (x) => (Number.isFinite(x) ? x.toFixed(2) : "");
  rows.push(`fork,pm2,warm_startup_ms,median,${fv(median(data.warmStartup?.pm2 ?? []))}`);
  rows.push(`fork,pboss,warm_startup_ms,median,${fv(median(data.warmStartup?.pboss ?? []))}`);
  rows.push(`fork,pm2,crash_recovery_ms,mean,${fv(mean(data.crash?.pm2?.recoveryMs ?? []))}`);
  rows.push(`fork,pm2,crash_recovery_ms,median,${fv(median(data.crash?.pm2?.recoveryMs ?? []))}`);
  rows.push(`fork,pboss,crash_recovery_ms,mean,${fv(mean(data.crash?.pboss?.recoveryMs ?? []))}`);
  rows.push(`fork,pboss,crash_recovery_ms,median,${fv(median(data.crash?.pboss?.recoveryMs ?? []))}`);
  rows.push(`fork,pm2,crash_recovery,failures,${data.crash?.pm2?.failures ?? ""}`);
  rows.push(`fork,pboss,crash_recovery,failures,${data.crash?.pboss?.failures ?? ""}`);
  rows.push(`fork,pm2,restart_ms,median,${fv(median(data.storm?.pm2?.restartMs ?? []))}`);
  rows.push(`fork,pboss,restart_ms,median,${fv(median(data.storm?.pboss?.restartMs ?? []))}`);
  rows.push(`fork,pm2,restart_storm,failures,${data.storm?.pm2?.failures ?? ""}`);
  rows.push(`fork,pboss,restart_storm,failures,${data.storm?.pboss?.failures ?? ""}`);
  rows.push(`fork,pm2,restart_storm,orphans,${data.storm?.pm2?.orphans ?? ""}`);
  rows.push(`fork,pboss,restart_storm,orphans,${data.storm?.pboss?.orphans ?? ""}`);
  for (const m of ["pm2", "pboss"]) {
    const cc = data.crashCluster?.[m];
    const sc = data.stormCluster?.[m];
    if (cc) {
      rows.push(`cluster,${m},worker_respawn_ms,mean,${fv(mean(cc.respawnMs ?? []))}`);
      rows.push(`cluster,${m},worker_respawn_ms,median,${fv(median(cc.respawnMs ?? []))}`);
      rows.push(`cluster,${m},crash_recovery,failures,${cc.failures ?? ""}`);
      if (cc.healthTotal) {
        rows.push(`cluster,${m},health_stayed_up,percent,${fv((cc.healthStayedUp / cc.healthTotal) * 100)}`);
      }
    }
    if (sc) {
      rows.push(`cluster,${m},restart_ms,median,${fv(median(sc.restartMs ?? []))}`);
      rows.push(`cluster,${m},restart_storm,failures,${sc.failures ?? ""}`);
      rows.push(`cluster,${m},restart_storm,orphans,${sc.orphans ?? ""}`);
    }
    rows.push(`cluster,${m},warm_startup_ms,median,${fv(median(data.warmStartupCluster?.[m] ?? []))}`);
  }
  return rows.join("\n") + "\n";
}

// ── HTML report (pure: data in, self-contained HTML out) ────────────────────

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The Winner cell as HTML: colored name + the relative difference. */
function winnerHtml(cell) {
  if (cell.winner === null) return '<td class="win">—</td>';
  if (cell.winner === "tie") return '<td class="win"><span class="w w-tie">tie</span></td>';
  return `<td class="win"><span class="w w-${cell.winner}">${cell.winner}</span>` +
    `<span class="d">${esc(pct(cell.diff))}</span></td>`;
}

function hTable(headers, rows) {
  // rows: array of {label, cell} — the same bundles the markdown renders
  const th = headers.map((h, i) => `<th${i ? ' class="num"' : ""}>${esc(h)}</th>`).join("");
  const tr = rows
    .map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${esc(r.cell.pm2)}</td>` +
      `<td class="num">${esc(r.cell.pboss)}</td>${winnerHtml(r.cell)}</tr>`)
    .join("\n");
  return `<table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tr}\n</tbody>\n</table>`;
}

function hTableFromCmpRows(rows) {
  // rows: the same {label, cell} bundles the markdown tables render
  return hTable(["Metric", "pm2", "pboss", "Winner"], rows);
}

const HTML_STYLE = `
  :root { --ink:#1f2328; --sub:#57606a; --line:#d0d7de; --pboss:#1a7f37; --pm2:#0969da; --bg:#f6f8fa; }
  * { box-sizing: border-box; }
  body { font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         color:var(--ink); background:#fff; margin:0 auto; max-width:980px; padding:2.5rem 1.25rem 5rem; }
  h1 { font-size:1.75rem; line-height:1.25; margin:.5rem 0 1rem; }
  h2 { font-size:1.3rem; margin-top:2.4rem; padding-bottom:.25rem; border-bottom:1px solid var(--line); }
  h3 { font-size:1.05rem; margin-top:1.8rem; }
  p, li { max-width:72ch; }
  code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.1em .35em; font-size:.88em; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow:auto; }
  pre code { border:0; background:none; padding:0; }
  table { border-collapse:collapse; width:100%; margin:1rem 0 1.4rem; font-size:.92rem; }
  th, td { border:1px solid var(--line); padding:6px 11px; text-align:left; vertical-align:top; }
  thead th { background:var(--bg); }
  th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.win { white-space:nowrap; }
  .w { font-weight:600; }
  .w-pboss { color:var(--pboss); }
  .w-pm2 { color:var(--pm2); }
  .w-tie { color:var(--sub); font-weight:400; }
  .d { color:var(--sub); font-size:.85em; margin-left:.4em; }
  .note { color:var(--sub); font-size:.9rem; }
  .meta-table td:first-child, .meta-table th:first-child { width:11rem; }
  .pill { display:inline-block; background:#ddf4e4; color:var(--pboss); border-radius:999px;
          padding:.1em .7em; font-size:.78rem; font-weight:600; margin-left:.5em; }
  .unsupported { border:1px solid #d4a72c66; background:#fff8c5; border-radius:8px;
                 padding:12px 14px; margin:1rem 0 1.4rem; font-size:.92rem; }
  .unsupported code { background:#fffdf0; }
  footer { margin-top:3rem; color:var(--sub); font-size:.85rem; border-top:1px solid var(--line); padding-top:1rem; }
`;

export function buildReportHtml(data) {
  const fork = data.modes?.fork ?? { loads: [], byLoad: {} };
  const cluster = data.modes?.cluster ?? { loads: [], byLoad: {} };
  const hasFork = fork.loads.length > 0;
  const hasCluster = cluster.loads.length > 0;
  const instances = data.meta?.config?.clusterInstances;
  const headlineLoad = (loads) =>
    loads.includes(100) ? 100 : loads[Math.floor(loads.length / 2)];

  const loadTable = (pm2, pboss) => hTableFromCmpRows(loadRows(pm2, pboss));
  const headlineTable = (pm2, pboss) => hTableFromCmpRows(headlineRows(pm2, pboss));
  const runsNote = (pm2, pboss) =>
    `<p class="note">Runs: ${pm2?.measured ?? 0} pm2 / ${pboss?.measured ?? 0} pboss.` +
    ` RPS per run — pm2 [${(pm2?.rpsAll ?? []).map(n0).join(", ")}] · ` +
    `pboss [${(pboss?.rpsAll ?? []).map(n0).join(", ")}]</p>`;

  const B = [];
  B.push("<!DOCTYPE html>");
  B.push('<html lang="en">');
  B.push("<head>");
  B.push('<meta charset="utf-8">');
  B.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  B.push(`<title>pboss vs pm2 — managing a Bun HTTP server</title>`);
  B.push(`<style>${HTML_STYLE}</style>`);
  B.push("</head>");
  B.push("<body>");
  B.push("<h1>pboss vs pm2 — managing a Bun HTTP server</h1>");
  B.push(
    "<p>The same <code>server.ts</code>, the same Bun executable, the same machine, the same",
    "load — the only difference is which process manager supervises it. This measures the",
    "<strong>overhead of managing</strong> a Bun server, not Bun's raw HTTP performance.",
    "Both supervision models are covered: <strong>fork</strong> (one managed process) and",
    "<strong>cluster</strong>" + (Number.isFinite(instances) ? ` (${instances} workers)` : "") +
    ".</p>",
  );

  if (data.meta) {
    const m = data.meta.machine ?? {};
    const v = data.meta.versions ?? {};
    const c = data.meta.config ?? {};
    const rows = [
      ["Date", data.meta.startedAt ?? "unknown"],
      ["OS", `${m.os ?? "?"} — kernel ${m.kernel ?? "?"}`],
      ["CPU", `${m.cores ?? "?"} × ${m.cpu ?? "?"}`],
      ["Memory", Number.isFinite(m.memMb) ? `${m.memMb} MB` : "?"],
      ["Versions", `bun ${v.bun ?? "?"} · node ${v.node ?? "?"} · pm2 ${v.pm2 ?? "?"} · pboss ${v.pboss ?? "?"}`],
      ["Profile", `${c.profile ?? "?"} — loads ${(c.connections ?? []).join("/")} conns, ` +
        `${c.durationSec ?? "?"}s each, ${c.warmupSec ?? "?"}s warmup, ${c.repeats ?? "?"} repeat(s) per manager`],
    ];
    if (hasCluster) {
      const pm2Ns = data.clusterUnsupported?.pm2?.supported === false;
      rows.push(["Cluster", `${instances ?? "?"} workers · pboss (SO_REUSEPORT)${pm2Ns ? " · pm2: not supported" : ""}`]);
    }
    B.push('<table class="meta-table">');
    for (const [k, val] of rows) B.push(`<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`);
    B.push("</table>");
  }

  B.push("<h2>Methodology</h2><ul>");
  B.push(
    "<li>Every measured run starts from a verified-clean state: app deleted, daemon killed,",
    "port free, no orphaned processes — each run is a <strong>cold start</strong> of the whole",
    "manager stack (that cold-start time is itself measured).</li>",
    "<li>A discarded warmup run precedes every measured run.</li>",
    "<li>Manager order alternates between runs (load index + repeat parity) so time-of-run",
    "bias cannot favor one column.</li>",
    "<li>CPU and memory cover the <strong>whole process tree</strong> (daemon + managed Bun",
    `server), sampled from <code>/proc</code> every ${(data.meta?.config?.sampleIntervalMs ?? 500) / 1000}s during the measured run.</li>`,
    "<li>Crash-recovery and restart-storm runs are separate phases and never overlap the",
    "HTTP measurements.</li>",
    "<li><strong>Same-machine caveat:</strong> the load generator shares the CPUs with the",
    "servers; absolute numbers are specific to this box — compare the two columns, don't",
    "quote them as platform throughput.</li>",
  );
  if (hasCluster) {
    B.push(
      "<li><strong>Cluster mode</strong> runs the same matrix for every manager that can",
      "actually cluster a Bun app: pboss (its native process-based cluster,",
      "<code>--instances N</code>, workers sharing one <code>SO_REUSEPORT</code> port). pm2",
      "<strong>cannot</strong> — its cluster mode is <code>node:cluster</code> inside the pm2 daemon and",
      "cannot wrap an app run with a non-Node interpreter — so it is reported as",
      "<strong>not supported</strong> in the cluster section, never measured with fork-mode",
      "numbers wearing a cluster label.</li>",
    );
  }
  B.push("</ul>");
  B.push(
    '<p class="note">Winner names the column that scored better; the percentage beside it is the',
    "relative difference (pboss − pm2) / pm2 × 100 — positive means pboss scored the higher",
    "number. For throughput higher is better; for every other metric in these tables lower is",
    'better, and the Winner column already accounts for the direction. A row that is exactly',
    'level reads “tie”.</p>',
  );

  if (!hasFork && !hasCluster) {
    B.push("<p><em>No load runs found — run <code>bash scripts/benchmark.sh</code> first.</em></p>");
  }

  if (hasFork) {
    const hl = headlineLoad(fork.loads);
    B.push(`<h2>Fork mode<span class="pill">1 process</span></h2>`);
    B.push(`<h3>Headline — ${hl} connections</h3>`);
    B.push(headlineTable(fork.byLoad[hl]?.pm2, fork.byLoad[hl]?.pboss));
    for (const conns of fork.loads) {
      B.push(`<h3>Load: ${conns} connections</h3>`);
      B.push(loadTable(fork.byLoad[conns]?.pm2, fork.byLoad[conns]?.pboss));
      B.push(runsNote(fork.byLoad[conns]?.pm2, fork.byLoad[conns]?.pboss));
    }
  }

  if (hasCluster) {
    const hl = headlineLoad(cluster.loads);
    B.push(`<h2>Cluster mode<span class="pill">${Number.isFinite(instances) ? `${instances} workers` : "N workers"}</span></h2>`);
    B.push(
      "<p>pboss supervises N Bun workers of the same <code>server.ts</code>, all binding the",
      "same port through <code>SO_REUSEPORT</code> (the kernel balances connections across",
      "them) — its native process-based cluster, <code>--instances N</code>.</p>",
    );
    if (data.clusterUnsupported?.pm2?.supported === false) {
      B.push(
        '<div class="unsupported">',
        "<strong>pm2: cluster mode — not supported (Bun apps).</strong>",
        "PM2's cluster mode is implemented with <code>node:cluster</code> inside its Node daemon:",
        "<code>cluster.fork()</code> always runs the daemon's own runtime and ignores",
        "<code>--interpreter</code>, and pm2 only selects cluster mode when the interpreter path",
        'contains "node" — so <code>pm2 start -i N --interpreter bun</code> silently runs the',
        "instances in <strong>fork mode</strong> (<code>exec_mode: fork_mode</code>, N plain processes, no",
        'port sharing), and forcing <code>exec_mode: "cluster_mode"</code> runs the workers under',
        "<strong>Node</strong>, not Bun. Rather than publish fork-mode numbers under a cluster label,",
        "this benchmark records pm2 as not supported and measures only pboss in this mode.",
        "(The <code>node</code> suite in this repo runs both managers' cluster modes.)</div>",
      );
    }
    B.push(`<h3>Headline — ${hl} connections</h3>`);
    B.push(headlineTable(cluster.byLoad[hl]?.pm2, cluster.byLoad[hl]?.pboss));
    for (const conns of cluster.loads) {
      B.push(`<h3>Load: ${conns} connections</h3>`);
      B.push(loadTable(cluster.byLoad[conns]?.pm2, cluster.byLoad[conns]?.pboss));
      B.push(runsNote(cluster.byLoad[conns]?.pm2, cluster.byLoad[conns]?.pboss));
    }
  }

  // ── startup / idle / crash / storm tables (plain cmpRow bundles) ──
  const table = (rows) =>
    `<table><thead><tr><th>Metric</th><th class="num">pm2</th><th class="num">pboss</th><th>Winner</th></tr></thead><tbody>` +
    rows.map(([label, cell]) =>
      `<tr><td>${esc(label)}</td><td class="num">${esc(cell.pm2)}</td><td class="num">${esc(cell.pboss)}</td>${winnerHtml(cell)}</tr>`).join("") +
    "</tbody></table>";
  const row = (label, pm2Val, pbossVal, unit = "", lowerIsBetter = true, dec = 1, minBase = 0) =>
    [label, cmpCell(pm2Val, pbossVal, unit, lowerIsBetter, dec, minBase)];

  B.push("<h2>Startup time</h2>");
  B.push("<p>Cold = daemon down, start command → first 200 from <code>/health</code> (daemon boot",
    "included; median over the load runs). Warm = daemon already up.</p>");
  const coldPm2 = fork.loads.map((c) => fork.byLoad[c]?.pm2?.coldStartupMedian).filter(Number.isFinite);
  const coldPboss = fork.loads.map((c) => fork.byLoad[c]?.pboss?.coldStartupMedian).filter(Number.isFinite);
  const coldClusterPm2 = cluster.loads.map((c) => cluster.byLoad[c]?.pm2?.coldStartupMedian).filter(Number.isFinite);
  const coldClusterPboss = cluster.loads.map((c) => cluster.byLoad[c]?.pboss?.coldStartupMedian).filter(Number.isFinite);
  B.push(table([
    row("Cold startup, fork (median of medians)", median(coldPm2), median(coldPboss), " ms"),
    row("Warm startup, fork (median)", median(data.warmStartup?.pm2 ?? []), median(data.warmStartup?.pboss ?? []), " ms"),
    row("Warm startup, fork (max)", maxOf(data.warmStartup?.pm2 ?? []), maxOf(data.warmStartup?.pboss ?? []), " ms"),
    ...(hasCluster ? [
      row("Cold startup, cluster (median of medians)", median(coldClusterPm2), median(coldClusterPboss), " ms"),
      row("Warm startup, cluster (median)", median(data.warmStartupCluster?.pm2 ?? []), median(data.warmStartupCluster?.pboss ?? []), " ms"),
      row("Warm startup, cluster (max)", maxOf(data.warmStartupCluster?.pm2 ?? []), maxOf(data.warmStartupCluster?.pboss ?? []), " ms"),
    ] : []),
  ]));

  B.push("<h2>Idle daemon overhead (no application running)</h2>");
  B.push(table([
    row("Median CPU %", data.idle?.pm2?.cpuMedian, data.idle?.pboss?.cpuMedian),
    row("Median memory", data.idle?.pm2?.rssMedianMb, data.idle?.pboss?.rssMedianMb, " MB"),
  ]));

  B.push("<h2>Crash recovery — fork</h2>");
  B.push("<p>SIGKILL the managed server; the number is how long the manager takes to bring",
    "<code>/health</code> back to 200.</p>");
  B.push(table([
    row("Recovery (mean)", mean(data.crash?.pm2?.recoveryMs ?? []), mean(data.crash?.pboss?.recoveryMs ?? []), " ms"),
    row("Recovery (median)", median(data.crash?.pm2?.recoveryMs ?? []), median(data.crash?.pboss?.recoveryMs ?? []), " ms"),
    row("Recovery (max)", maxOf(data.crash?.pm2?.recoveryMs ?? []), maxOf(data.crash?.pboss?.recoveryMs ?? []), " ms"),
    row("Failed recoveries", data.crash?.pm2?.failures, data.crash?.pboss?.failures, "", true, 0),
  ]));

  if (hasCluster || data.crashCluster?.pm2 || data.crashCluster?.pboss) {
    B.push(`<h2>Crash recovery — cluster</h2>`);
    B.push("<p>One worker is SIGKILLed; the survivors keep the shared port up. The numbers are",
      "the manager's worker <strong>replacement time</strong> and whether <code>/health</code> ever",
      "stopped answering (it should not, with workers left).</p>");
    const upRatio = (m) => {
      const d = data.crashCluster?.[m];
      if (!d || !d.healthTotal) return NaN;
      return (d.healthStayedUp / d.healthTotal) * 100;
    };
    B.push(table([
      row("Worker respawn (mean)", mean(data.crashCluster?.pm2?.respawnMs ?? []), mean(data.crashCluster?.pboss?.respawnMs ?? []), " ms"),
      row("Worker respawn (median)", median(data.crashCluster?.pm2?.respawnMs ?? []), median(data.crashCluster?.pboss?.respawnMs ?? []), " ms"),
      row("Worker respawn (max)", maxOf(data.crashCluster?.pm2?.respawnMs ?? []), maxOf(data.crashCluster?.pboss?.respawnMs ?? []), " ms"),
      row("Failed replacements", data.crashCluster?.pm2?.failures, data.crashCluster?.pboss?.failures, "", true, 0),
      row("Health stayed up", upRatio("pm2"), upRatio("pboss"), " % of kills", true, 1),
    ]));
  }

  const stormTable = (storm, extraLabel) => table([
    row(`Restarts attempted${extraLabel}`, storm?.pm2?.restarts, storm?.pboss?.restarts, "", false, 0),
    row("Restart time (median)", median(storm?.pm2?.restartMs ?? []), median(storm?.pboss?.restartMs ?? []), " ms"),
    row("Failed restarts", storm?.pm2?.failures, storm?.pboss?.failures, "", true, 0),
    row("Orphaned processes after", storm?.pm2?.orphans, storm?.pboss?.orphans, "", true, 0),
    row(`${extraLabel ? "Workers' RSS" : "App RSS"} before`, (storm?.pm2?.rssBeforeKb ?? NaN) / 1024, (storm?.pboss?.rssBeforeKb ?? NaN) / 1024, " MB"),
    row(`${extraLabel ? "Workers' RSS" : "App RSS"} after`, (storm?.pm2?.rssAfterKb ?? NaN) / 1024, (storm?.pboss?.rssAfterKb ?? NaN) / 1024, " MB"),
    row("Memory growth (after − before)",
      Number.isFinite(storm?.pm2?.rssAfterKb) && Number.isFinite(storm?.pm2?.rssBeforeKb)
        ? (storm.pm2.rssAfterKb - storm.pm2.rssBeforeKb) / 1024 : NaN,
      Number.isFinite(storm?.pboss?.rssAfterKb) && Number.isFinite(storm?.pboss?.rssBeforeKb)
        ? (storm.pboss.rssAfterKb - storm.pboss.rssBeforeKb) / 1024 : NaN,
      " MB", true, 1, 1),
  ]);

  B.push("<h2>Restart storm — fork</h2>");
  B.push(stormTable(data.storm, ""));
  if (hasCluster || data.stormCluster?.pm2 || data.stormCluster?.pboss) {
    B.push("<h2>Restart storm — cluster</h2>");
    B.push("<p>Every restart must bring back ALL workers.</p>");
    B.push(stormTable(data.stormCluster, " (cluster)"));
  }

  if (data.soak?.pm2 || data.soak?.pboss) {
    B.push("<h2>Soak — fork (sustained load)</h2>");
    B.push(table([
      row("Median CPU % of tree", data.soak?.pm2?.cpuMedian, data.soak?.pboss?.cpuMedian),
      row("Median tree memory", data.soak?.pm2?.rssMedianMb, data.soak?.pboss?.rssMedianMb, " MB"),
      row("Median p95 latency", data.soak?.pm2?.p95, data.soak?.pboss?.p95, " ms"),
      row("Median p99 latency", data.soak?.pm2?.p99, data.soak?.pboss?.p99, " ms"),
      row("Errors (total)", data.soak?.pm2?.errors, data.soak?.pboss?.errors),
    ]));
  }

  B.push("<h2>Reproduce</h2>");
  B.push(
    "<pre><code>cd benchmarks/bun\n" +
    "npm install                     # pm2 + autocannon (local, pinned)\n" +
    "bash scripts/benchmark.sh       # default profile — BENCH_PROFILE=smoke first\n" +
    "BENCH_PROFILE=full bash scripts/benchmark.sh    # + the 1000-conn stress level\n" +
    "BENCH_INSTANCES=4 bash scripts/benchmark.sh      # cluster workers (default: cores)\n" +
    '# PBOSS_CMD="bun run /path/to/pboss/src/main.ts" bash scripts/benchmark.sh</code></pre>',
  );
  B.push(
    "<footer>Raw data: every number above traces to a file under <code>results/raw/</code> —",
    "<code>run.jsonl</code> records, full autocannon JSON, <code>/proc</code> resource CSVs,",
    "recovery and storm event logs (fork and cluster each).",
    "<code>results/summary.csv</code> is the same data in one sheet.",
    "Don't read one run — the medians and the per-run notes show the repeats and the",
    "variability; a single run never decides a column.</footer>",
  );
  B.push("</body>");
  B.push("</html>");
  return B.join("\n");
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

/**
 * The layout benchmark.sh writes:
 *   raw/<manager>/c<conns>/…            fork load runs
 *   raw/<manager>/cluster-c<conns>/…    cluster load runs
 *   raw/<manager>/phases.jsonl           idle + warm-startup (mode-tagged)
 *   raw/<manager>/{recovery,storm}.jsonl fork crash/storm
 *   raw/<manager>/cluster-{recovery,storm}.jsonl   cluster ditto
 */
export function loadEverything(resultsDir) {
  const data = {
    meta: readJson(join(resultsDir, "meta.json")),
    modes: {},
    warmStartup: { pm2: [], pboss: [] },
    warmStartupCluster: { pm2: [], pboss: [] },
    idle: {},
    crash: {},
    crashCluster: {},
    storm: {},
    stormCluster: {},
    soak: {},
    soakCluster: {},
    clusterUnsupported: {},
  };

  for (const manager of ["pm2", "pboss"]) {
    const mdir = join(resultsDir, "raw", manager);
    if (!existsSync(mdir)) continue;

    // cluster-unsupported.json: a manager that cannot run cluster mode at
    // all in this suite (bun: pm2) — the report's "not supported" callout
    // cites this file, and NO cluster data for it is ever expected.
    const unsupported = readJson(join(mdir, "cluster-unsupported.json"));
    if (unsupported && unsupported.supported === false) {
      data.clusterUnsupported[manager] = unsupported;
    }

    // load runs: raw/<manager>/c<conns>/ and raw/<manager>/cluster-c<conns>/
    for (const entry of readdirSync(mdir)) {
      const mLoad = entry.match(/^(cluster-)?c(\d+)$/);
      if (!mLoad) continue;
      const mode = mLoad[1] ? "cluster" : "fork";
      const conns = Number(mLoad[2]);
      const ldir = join(mdir, entry);
      const runs = parseJsonl(readText(join(ldir, "run.jsonl"))).map((meta) => {
        const loadgen = readJson(join(ldir, `loadgen-${meta.repeat}.json`));
        const resources = parseResourceCsv(readText(join(ldir, `resources-${meta.repeat}.csv`)));
        return { meta, loadgen, resources };
      });
      if (!runs.length) continue;
      data.modes[mode] = data.modes[mode] ?? { loads: [], byLoad: {} };
      data.modes[mode].byLoad[conns] = data.modes[mode].byLoad[conns] ?? {};
      data.modes[mode].byLoad[conns][manager] = aggregateLoad(runs);
    }

    // phases.jsonl: idle + warm-startup (records carry their mode; the
    // harness added the mode tag later, so records without one are fork)
    for (const rec of parseJsonl(readText(join(mdir, "phases.jsonl")))) {
      if (rec.phase === "warm-startup" && Number.isFinite(rec.startupMs)) {
        const target = rec.mode === "cluster" ? data.warmStartupCluster : data.warmStartup;
        target[manager].push(rec.startupMs);
      }
    }
    if (existsSync(join(mdir, "idle.csv"))) {
      const agg = computeAggregates(parseResourceCsv(readText(join(mdir, "idle.csv"))));
      if (agg.nSamples > 0) data.idle[manager] = agg;
    }

    // recovery.jsonl (fork) + cluster-recovery.jsonl (cluster)
    const recs = parseJsonl(readText(join(mdir, "recovery.jsonl")));
    if (recs.length) {
      data.crash[manager] = {
        recoveryMs: recs.filter((r) => Number.isFinite(r.recoveryMs)).map((r) => r.recoveryMs),
        failures: recs.filter((r) => r.recoveryFailed === true).length,
      };
    }
    const clusterRecs = parseJsonl(readText(join(mdir, "cluster-recovery.jsonl")));
    if (clusterRecs.length) {
      data.crashCluster[manager] = {
        respawnMs: clusterRecs.filter((r) => Number.isFinite(r.respawnMs)).map((r) => r.respawnMs),
        failures: clusterRecs.filter((r) => r.recoveryFailed === true).length,
        healthStayedUp: clusterRecs.filter((r) => r.healthStayedUp === true).length,
        healthTotal: clusterRecs.filter((r) => Number.isFinite(r.respawnMs)).length,
      };
    }

    // storm.jsonl (fork) + cluster-storm.jsonl (cluster)
    const readStorm = (file) => {
      const stormRecs = parseJsonl(readText(join(mdir, file)));
      if (!stormRecs.length) return null;
      const summary = stormRecs.find((r) => r.summary === true) ?? {};
      return {
        restartMs: stormRecs.filter((r) => Number.isFinite(r.restartMs)).map((r) => r.restartMs),
        restarts: summary.restarts ?? stormRecs.filter((r) => Number.isFinite(r.restartMs)).length,
        failures: summary.failures ?? stormRecs.filter((r) => r.restartFailed === true).length,
        orphans: summary.orphans ?? NaN,
        rssBeforeKb: summary.rssBeforeKb ?? NaN,
        rssAfterKb: summary.rssAfterKb ?? NaN,
      };
    };
    const storm = readStorm("storm.jsonl");
    if (storm) data.storm[manager] = storm;
    const stormCluster = readStorm("cluster-storm.jsonl");
    if (stormCluster) data.stormCluster[manager] = stormCluster;

    // soak (optional, fork + cluster files)
    const readSoak = (prefix) => {
      const soakLoadgen = readJson(join(mdir, `${prefix}soak-loadgen.json`));
      const soakCsv = existsSync(join(mdir, `${prefix}soak.csv`))
        ? computeAggregates(parseResourceCsv(readText(join(mdir, `${prefix}soak.csv`))))
        : null;
      if (!soakLoadgen && !soakCsv?.nSamples) return null;
      return {
        cpuMedian: soakCsv?.cpuMedian ?? NaN,
        rssMedianMb: soakCsv?.rssMedianMb ?? NaN,
        p95: soakLoadgen?.latency?.p95 ?? NaN,
        p99: soakLoadgen?.latency?.p99 ?? NaN,
        errors: soakLoadgen?.errors?.errors ?? NaN,
      };
    };
    const soak = readSoak("");
    if (soak) data.soak[manager] = soak;
    const soakCluster = readSoak("cluster-");
    if (soakCluster) data.soakCluster[manager] = soakCluster;
  }

  for (const mode of ["fork", "cluster"]) {
    if (data.modes[mode]) {
      data.modes[mode].loads = Object.keys(data.modes[mode].byLoad)
        .map(Number)
        .sort((a, b) => a - b);
    }
  }

  return data;
}

// ── console summary (what a nohup log ends with) ───────────────────────────

export function consoleSummary(data) {
  const lines = [];
  for (const [mode, tag] of [["fork", ""], ["cluster", "[cluster] "]]) {
    const md = data.modes?.[mode];
    if (!md) continue;
    for (const conns of md.loads) {
      const pm2 = md.byLoad[conns]?.pm2;
      const pboss = md.byLoad[conns]?.pboss;
      // (pm2 is the BASELINE — winnerOf's first argument)
      const { diff, winner } = winnerOf(pm2?.rpsMedian, pboss?.rpsMedian, false);
      const cell = winner === null ? "—" : winner === "tie" ? "tie" : `${winner} (${pct(diff)})`;
      lines.push(
        `${tag}c=${conns}: pm2 ${n0(pm2?.rpsMedian)} rps (p50 ${n1(pm2?.p50Median)}ms) · ` +
        `pboss ${n0(pboss?.rpsMedian)} rps (p50 ${n1(pboss?.p50Median)}ms) · ${cell}`,
      );
    }
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
  writeFileSync(join(resultsDir, "REPORT.md"), buildReport(data));
  writeFileSync(join(resultsDir, "REPORT.html"), buildReportHtml(data));
  writeFileSync(join(resultsDir, "summary.csv"), buildSummaryCsv(data));
  writeFileSync(join(resultsDir, "summary-phases.csv"), buildPhasesCsv(data));
  console.log(consoleSummary(data));
  console.log(`\nreport: ${join(resultsDir, "REPORT.md")}`);
  console.log(`html:   ${join(resultsDir, "REPORT.html")}`);
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    exit(1);
  });
}
