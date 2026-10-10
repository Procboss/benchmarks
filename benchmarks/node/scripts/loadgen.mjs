#!/usr/bin/env node
/**
 * pboss-vs-pm2 Node benchmark — the load generator.
 *
 * A thin, scripted wrapper around autocannon (npm devDependency, resolved
 * from benchmarks/node/node_modules) so the benchmark scripts get:
 *   - a warmup run whose numbers are DISCARDED, followed by the measured
 *     run (methodology: never measure a cold server),
 *   - one JSON file with the exact fields summarize.mjs reads,
 *   - failures as a non-zero exit (an aborted run must never be mistaken
 *     for "zero requests served").
 *
 * Manual reproduction with the raw CLI (what this does underneath):
 *   npx autocannon -c 100 -d 60 -p 1 http://127.0.0.1:3000/
 */

import autocannon from "autocannon";
import { writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

async function main() {
  const args = argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  };

  const url = opt("--url", "http://127.0.0.1:3000");
  const connections = Number(opt("--connections", "100"));
  const duration = Number(opt("--duration", "10"));
  const pipelining = Number(opt("--pipelining", "1"));
  const warmup = Number(opt("--warmup", "0"));
  const out = opt("--out", "");

  const fire = async (seconds) => {
    return autocannon({
      url,
      connections,
      duration: seconds,
      pipelining,
      title: `c=${connections} d=${seconds}s p=${pipelining}`,
    });
  };

  if (warmup > 0) {
    process.stderr.write(`[loadgen] warmup: ${warmup}s at c=${connections} (discarded)\n`);
    await fire(warmup);
  }

  process.stderr.write(
    `[loadgen] measuring: ${duration}s at c=${connections} connections against ${url}\n`,
  );
  const result = await fire(duration);

  const trimmed = {
    url,
    connections,
    pipelining,
    duration,
    requests: {
      total: result.requests.total,
      average: result.requests.average,
      p50: result.requests.p50 ?? null,
      p99: result.requests.p99 ?? null,
    },
    latency: {
      average: result.latency.average,
      p50: result.latency.p50 ?? null,
      p90: result.latency.p90 ?? null,
      p95: result.latency.p95 ?? null,
      p99: result.latency.p99 ?? null,
    },
    throughputAverageBytes: result.throughput?.average ?? null,
    errors: {
      errors: result.errors?.errors ?? 0,
      timeouts: result.errors?.timeouts ?? 0,
      non2xx: result.errors?.non2xx ?? 0,
    },
    raw: result, // the full autocannon output — histogram and all
  };

  const json = JSON.stringify(trimmed, null, 2);
  if (out) {
    writeFileSync(out, json);
  } else {
    process.stdout.write(json);
  }
  exit(0);
}

// Executed, not imported.
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    exit(1);
  });
}
