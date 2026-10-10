#!/usr/bin/env node
/**
 * pboss-vs-pm2 Node benchmark — /proc process-tree resource sampler.
 *
 * Measures the WHOLE process tree rooted at the given PIDs (the manager's
 * daemon + every descendant, which includes the managed Node server): CPU
 * (utime+stime deltas between samples, so each number is the tree's average
 * core-percentage over the interval — 150% = one and a half cores busy) and
 * resident memory (statm resident pages summed across the tree).
 *
 * Two ways in:
 *   1. the CLI below (what the benchmark scripts use):
 *        node collect-resources.mjs sample --roots <pid,pid> --interval 500 \
 *             --duration 30 --out samples.csv
 *        node collect-resources.mjs find --roots <pid> --match server.ts
 *   2. the exported pure functions (what tests/bench-harness.test.ts drives
 *      with fixture data — the reason parsing/tree math lives in small
 *      named units).
 *
 * Zero npm dependencies — /proc, fs and child_process only — so the test
 * suite imports this file without any `npm install` in benchmarks/node.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

// ── pure /proc parsing ────────────────────────────────────────────────────

/**
 * Parse /proc/<pid>/stat into { pid, ppid, utimeTicks, stimeTicks }.
 *
 * The comm field (2) may contain spaces and parens — every parser that
 * splits on spaces from the left breaks on them, so parsing starts after
 * the LAST ')'. Fields after comm (1-based over the whole file): state=3,
 * ppid=4, ..., utime=14, stime=15 — indexes 1 and 11/12 after the split.
 */
export function parseStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).split(" ");
  if (rest.length < 13 || !Number.isFinite(pid)) return null;
  return {
    pid,
    ppid: Number(rest[1]),
    utimeTicks: Number(rest[11]),
    stimeTicks: Number(rest[12]),
  };
}

/** Resident bytes of one pid from statm (page count × page size). */
export function rssBytes(statmText, pageSize) {
  const residentPages = Number(statmText.split(" ")[1]);
  if (!Number.isFinite(residentPages)) return 0;
  return residentPages * pageSize;
}

/** Snapshot every readable /proc/<pid>/stat into a Map<pid, stat>. */
export function snapshotStatTable() {
  const table = new Map();
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // raced with process exit — it contributed nothing
    }
    const parsed = parseStat(stat);
    if (parsed) table.set(parsed.pid, parsed);
  }
  return table;
}

/**
 * The set of pids at or below the roots: the roots themselves plus every
 * process whose ppid chain reaches one (grandchildren included — the
 * daemon spawns the server, but a manager is free to spawn wrappers).
 */
export function treeOf(roots, table) {
  const children = new Map(); // ppid -> [pid, ...]
  for (const stat of table.values()) {
    const list = children.get(stat.ppid) ?? [];
    list.push(stat.pid);
    children.set(stat.ppid, list);
  }
  const inTree = new Set();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.pop();
    if (inTree.has(pid) || !table.has(pid)) continue;
    inTree.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return inTree;
}

/**
 * CPU% for one sample interval: the tree's consumed ticks over the wall
 * clock, as a percentage of ONE core (150% = one and a half cores busy —
 * a 2-core machine tops out at 200%).
 */
export function cpuPercent(ticksDelta, seconds, clockTicksPerSec) {
  if (seconds <= 0 || clockTicksPerSec <= 0) return 0;
  return (ticksDelta / clockTicksPerSec / seconds) * 100;
}

export function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Aggregate a run's samples into the numbers summarize.mjs reports. Median
 * (not mean) keeps a single noisy sample — a compile, a page cache flush —
 * from skewing the comparison.
 */
export function computeAggregates(samples) {
  const n = samples.length;
  if (n === 0) {
    return { nSamples: 0, cpuAvg: 0, cpuMedian: 0, cpuPeak: 0, rssAvgMb: 0, rssMedianMb: 0, rssPeakMb: 0 };
  }
  const cpu = samples.map((s) => s.cpu).sort((a, b) => a - b);
  const rss = samples.map((s) => s.rssMb).sort((a, b) => a - b);
  return {
    nSamples: n,
    cpuAvg: cpu.reduce((a, b) => a + b, 0) / n,
    cpuMedian: median(cpu),
    cpuPeak: cpu[n - 1],
    rssAvgMb: rss.reduce((a, b) => a + b, 0) / n,
    rssMedianMb: median(rss),
    rssPeakMb: rss[n - 1],
  };
}

// ── sampling loop ─────────────────────────────────────────────────────────

/**
 * Sample the trees rooted at `roots` every `intervalMs` until `durationSec`
 * elapses. CPU needs PREVIOUS tick counts, so a pid's first sighting
 * contributes memory but no CPU (a tree whose members are all long-lived —
 * daemon + steady server — loses at most one interval of accuracy).
 */
export async function sampleLoop(roots, { intervalMs, durationSec }) {
  const pageSize = Number(execSync("getconf PAGESIZE").toString().trim()) || 4096;
  const clockTicksPerSec = Number(execSync("getconf CLK_TCK").toString().trim()) || 100;
  const samples = [];
  let prevTicks = new Map(); // pid -> utime+stime
  const start = Date.now();
  const deadline = start + durationSec * 1000;

  for (const stat of treeOf(roots, snapshotStatTable())) {
    prevTicks.set(stat.pid, stat.utimeTicks + stat.stimeTicks);
  }

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const table = snapshotStatTable();
    const inTree = treeOf(roots, table);
    let ticksDelta = 0;
    let rssBytesTotal = 0;
    const nextTicks = new Map();
    for (const pid of inTree) {
      const stat = table.get(pid);
      const ticks = stat.utimeTicks + stat.stimeTicks;
      if (prevTicks.has(pid)) ticksDelta += Math.max(0, ticks - prevTicks.get(pid));
      nextTicks.set(pid, ticks);
      try {
        rssBytesTotal += rssBytes(readFileSync(`/proc/${pid}/statm`, "utf8"), pageSize);
      } catch {
        /* exited between stat and statm — its memory left with it */
      }
    }
    prevTicks = nextTicks;
    const elapsed = (Date.now() - start) / 1000;
    samples.push({
      timestampMs: Date.now(),
      elapsedS: Math.round(elapsed * 1000) / 1000,
      cpu: Math.round(cpuPercent(ticksDelta, intervalMs / 1000, clockTicksPerSec) * 100) / 100,
      rssMb: Math.round((rssBytesTotal / (1024 * 1024)) * 100) / 100,
      pids: [...inTree].sort((a, b) => a - b).join(" "),
    });
  }
  return samples;
}

/** The sample rows as CSV (header included) — what lands in results/raw. */
export function samplesToCsv(samples) {
  const header = "timestamp_ms,elapsed_s,cpu_percent,rss_mb,pids";
  const rows = samples.map(
    (s) => `${s.timestampMs},${s.elapsedS},${s.cpu},${s.rssMb},"${s.pids}"`,
  );
  return [header, ...rows].join("\n") + "\n";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── CLI (guarded so the test suite can import the pure functions) ─────────

async function main() {
  const [cmd, ...args] = argv.slice(2);

  if (cmd === "find") {
    // find --roots <pid[,pid...]> --match <substring> [--all]
    //   → prints the pid of the FIRST live process in the trees whose
    //     cmdline contains the substring (the managed Node server), or
    //     exits 1. Excludes the roots themselves: those are the daemons.
    //   --all prints EVERY match, one pid per line (cluster mode: the
    //     manager supervises N server processes, and the harness needs
    //     all of them — to kill a worker, to count workers, to sample).
    const roots = flag(args, "--roots", "").split(",").map(Number).filter(Boolean);
    const match = flag(args, "--match", "");
    const all = args.includes("--all");
    const table = snapshotStatTable();
    let printed = false;
    for (const pid of treeOf(roots, table)) {
      if (roots.includes(pid)) continue;
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch {
        continue;
      }
      if (cmdline.includes(match)) {
        console.log(pid);
        printed = true;
        if (!all) return;
      }
    }
    if (!printed) exit(1);
  }

  if (cmd === "sample") {
    // sample --roots <pid[,pid...]> --interval <ms> --duration <sec> --out <csv>
    const roots = flag(args, "--roots", "").split(",").map(Number).filter(Boolean);
    const intervalMs = Number(flag(args, "--interval", "500"));
    const durationSec = Number(flag(args, "--duration", "10"));
    const out = flag(args, "--out", "");
    const samples = await sampleLoop(roots, { intervalMs, durationSec });
    const csv = samplesToCsv(samples);
    if (out) {
      writeFileSync(out, csv);
    } else {
      process.stdout.write(csv);
    }
    return;
  }

  console.error(
    "usage:\n" +
      "  collect-resources.mjs sample --roots <pid[,pid...]> --interval <ms> --duration <sec> [--out <csv>]\n" +
      "  collect-resources.mjs find --roots <pid[,pid...]> --match <substring>",
  );
  exit(2);
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

// Runs when EXECUTED (node/bun), never when imported (tests) — works under
// both runtimes: node's argv[1] is the file, and import.meta.url matches it.
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    exit(1);
  });
}
