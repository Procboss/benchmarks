# pboss vs pm2 — managing a Bun HTTP server (fork mode)

The same `server.ts`, the same Bun executable, the same machine, the same
load — the only difference is which process manager supervises it. This
measures the **overhead of managing** a Bun server, not Bun's raw HTTP
performance.

| Environment |  |
| --- | --- |
| Date | 2026-10-09T05:19:25.136Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | bun 1.3.14 · node v24.21.0 · pm2 5.4.3 · pboss pboss v1.7.5 |
| Profile | standard — loads 10/100/500 conns, 60s each, 10s warmup, 5 repeat(s) per manager |

## Methodology

- Every measured run starts from a verified-clean state: app deleted, daemon
  killed, port free, no orphaned processes — each run is a **cold start** of
  the whole manager stack (that cold-start time is itself measured).
- A discarded warmup run precedes every measured run.
- Manager order alternates between runs (load index + repeat parity) so
  time-of-run bias cannot favor one column.
- CPU and memory cover the **whole process tree** (daemon + managed Bun
  server), sampled from `/proc` every 0.5s during the measured run.
- Crash-recovery and restart-storm runs are separate phases and never
  overlap the HTTP measurements.
- **Same-machine caveat:** the load generator shares the CPUs with the
  servers (a dedicated load machine is better); absolute numbers are
  specific to this box — compare the two columns, don't quote them as
  platform throughput.

## Headline — 100 connections

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Average requests/sec | 72541.7 | 72658.2 | +0.2% ▸ pboss |
| Average latency (mean) | 0.84 ms | 0.77 ms | -8.3% ▸ pboss |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | +0.0% |
| Average CPU usage (tree) | 66.8 % | 67.2 % | +0.6% ▸ pm2 |
| Average memory (tree) | 127.6 MB | 117.2 MB | -8.2% ▸ pboss |
| Average cold startup | 366.4 ms | 334.8 ms | -8.6% ▸ pboss |
| Average crash recovery | 74.9 ms | 65.5 ms | -12.6% ▸ pboss |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

_Throughput relative difference = (pboss − pm2) / pm2 × 100. For every other
metric lower is better, and the arrow names the column that won._

## Load: 10 connections

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Median requests/sec | 77363.2 | 77762.9 | +0.5% ▸ pboss |
| Mean requests/sec | 77101.6 | 76907.6 | -0.3% ▸ pm2 |
| RPS stdev (variability) | 2376.0 | 3067.8 | +29.1% ▸ pm2 |
| Average latency (mean) | 0.04 ms | 0.04 ms | +0.0% |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 68.9 | 69.3 | +0.6% ▸ pm2 |
| Median CPU % of tree | 70.0 | 70.0 | +0.0% |
| Peak CPU % of tree | 75.2 | 77.6 | +3.2% ▸ pm2 |
| Avg tree memory | 125.0 MB | 117.0 MB | -6.4% ▸ pboss |
| Median tree memory | 125.0 MB | 117.0 MB | -6.4% ▸ pboss |
| Cold startup (median) | 376.0 ms | 338.0 ms | -10.1% ▸ pboss |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [74,246, 75,713, 77,363, 77,592, 80,593] · pboss [79,267, 77,763, 78,339, 71,543, 77,626]_

## Load: 100 connections

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Median requests/sec | 72505.6 | 72939.7 | +0.6% ▸ pboss |
| Mean requests/sec | 72541.7 | 72658.2 | +0.2% ▸ pboss |
| RPS stdev (variability) | 2205.8 | 2254.5 | +2.2% ▸ pm2 |
| Average latency (mean) | 0.84 ms | 0.77 ms | -8.3% ▸ pboss |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 1.00 ms | 1.00 ms | +0.0% |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | +0.0% |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 66.8 | 67.2 | +0.6% ▸ pm2 |
| Median CPU % of tree | 68.0 | 68.0 | +0.0% |
| Peak CPU % of tree | 70.8 | 72.4 | +2.3% ▸ pm2 |
| Avg tree memory | 127.6 MB | 117.2 MB | -8.2% ▸ pboss |
| Median tree memory | 127.6 MB | 117.2 MB | -8.2% ▸ pboss |
| Cold startup (median) | 366.0 ms | 337.0 ms | -7.9% ▸ pboss |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [71,423, 75,470, 73,663, 72,506, 69,647] · pboss [73,627, 72,940, 70,905, 70,071, 75,748]_

## Load: 500 connections

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Median requests/sec | 66517.6 | 65993.6 | -0.8% ▸ pm2 |
| Mean requests/sec | 67037.9 | 66221.7 | -1.2% ▸ pm2 |
| RPS stdev (variability) | 1246.3 | 1620.9 | +30.1% ▸ pm2 |
| Average latency (mean) | 7.04 ms | 7.10 ms | +0.9% ▸ pm2 |
| Median p50 latency | 5.00 ms | 5.00 ms | +0.0% |
| Median p90 latency | 7.00 ms | 7.00 ms | +0.0% |
| Median p95 latency | — | — | — |
| Median p99 latency | 33.00 ms | 33.00 ms | +0.0% |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 64.5 | 64.5 | +0.0% ▸ pm2 |
| Median CPU % of tree | 64.8 | 64.8 | +0.0% |
| Peak CPU % of tree | 73.6 | 70.4 | -4.3% ▸ pboss |
| Avg tree memory | 128.7 MB | 116.5 MB | -9.5% ▸ pboss |
| Median tree memory | 128.7 MB | 116.5 MB | -9.5% ▸ pboss |
| Cold startup (median) | 363.0 ms | 334.0 ms | -8.0% ▸ pboss |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [68,722, 65,877, 66,099, 66,518, 67,974] · pboss [63,785, 65,979, 68,019, 65,994, 67,332]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Cold startup (median of medians) | 366.0 ms | 337.0 ms | -7.9% ▸ pboss |
| Warm startup (median) | 171.0 ms | 116.0 ms | -32.2% ▸ pboss |
| Warm startup (max) | 220.0 ms | 125.0 ms | -43.2% ▸ pboss |


## Idle daemon overhead (no application running)

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 69.0 MB | 63.9 MB | -7.4% ▸ pboss |


## Crash recovery (SIGKILL the server → `/health` back to 200)

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Recovery (mean) | 74.9 ms | 65.5 ms | -12.6% ▸ pboss |
| Recovery (median) | 73.5 ms | 65.5 ms | -10.9% ▸ pboss |
| Recovery (max) | 92.0 ms | 66.0 ms | -28.3% ▸ pboss |
| Failed recoveries | 0 | 0 | — |


## Restart storm

| Metric | pm2 | pboss | Difference |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | +0.0% |
| Restart time (median) | 259.5 ms | 120.0 ms | -53.8% ▸ pboss |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 35.2 MB | 35.2 MB | -0.0% ▸ pboss |
| App RSS after | 35.2 MB | 35.1 MB | -0.2% ▸ pboss |
| Memory growth (after − before) | -0.0 MB | -0.1 MB | — |


## Reproduce

```bash
cd benchmarks/bun
npm install                     # pm2 + autocannon (local, pinned)
bash scripts/benchmark.sh       # default profile — BENCH_PROFILE=smoke first
BENCH_PROFILE=full bash scripts/benchmark.sh    # + the 1000-conn stress level
# from a pboss repo checkout instead of an installed CLI:
# PBOSS_CMD="bun run /path/to/pboss/src/main.ts" bash scripts/benchmark.sh
```

Raw data: every number above traces to a file under `results/raw/` —
`run.jsonl` records, full autocannon JSON, `/proc` resource CSVs, recovery
and storm event logs. `results/summary.csv` is the same data in one sheet.

_Don't read one run. The medians and the per-run lists above show the
repeats and the variability; a single run never decides a column._
