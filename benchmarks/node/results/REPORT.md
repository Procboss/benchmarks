# pboss vs pm2 — managing a Node HTTP server

The same `server.mjs`, the same Node binary, the same machine, the same
load — the only difference is which process manager supervises it. This
measures the **overhead of managing** a Node server, not Node's raw HTTP
performance. Both supervision models are covered: **fork** (one managed
process) and **cluster** (N workers sharing one port) — and for Node apps
BOTH managers cluster natively through `node:cluster`, so this is the
apples-to-apples cluster comparison the bun edition of this repo cannot
make (pm2 cannot cluster a Bun app).

_An HTML version of this summary lives beside it: `results/REPORT.html`._

| Environment |  |
| --- | --- |
| Date | 2026-10-11T00:50:20.848Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | node v24.21.0 · pm2 5.4.3 · pboss pboss v1.8.0 |
| Profile | standard — loads 10/100/500 conns, 60s each, 10s warmup, 5 repeat(s) per manager |
| Cluster | 2 workers per manager (node:cluster) |

## Methodology

- Every measured run starts from a verified-clean state: app deleted, daemon
  killed, port free, no orphaned processes — each run is a **cold start** of
  the whole manager stack (that cold-start time is itself measured).
- A discarded warmup run precedes every measured run.
- Manager order alternates between runs (load index + repeat parity) so
  time-of-run bias cannot favor one column.
- CPU and memory cover the **whole process tree** (daemon + managed Node
  server), sampled from `/proc` every 0.5s during the measured run.
- Crash-recovery and restart-storm runs are separate phases and never
  overlap the HTTP measurements.
- **Same-machine caveat:** the load generator shares the CPUs with the
  servers (a dedicated load machine is better); absolute numbers are
  specific to this box — compare the two columns, don't quote them as
  platform throughput.
- **Cluster mode** runs the same matrix with N workers per manager —
  and for Node apps BOTH managers cluster natively through `node:cluster`,
  so the worker count and the sharing mechanism are identical on both
  sides: pboss's `--instances N` spawns a supervised wrapper primary that
  forks the workers; pm2's `-i N` makes the pm2 daemon itself the primary.
  The only variable stays the manager.

_Winner names the column that scored better; the percentage beside it is the relative difference (pboss − pm2) / pm2 × 100 — positive means pboss scored the higher number. For throughput higher is better; for every other metric in these tables lower is better, and the Winner column already accounts for the direction. A row that is exactly level reads “tie”._

## Fork mode — headline, 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 57512.1 | 57518.6 | pboss (+0.0%) |
| Average latency (mean) | 1.44 ms | 1.40 ms | pboss (-2.8%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Average CPU usage (tree) | 73.9 % | 74.0 % | pm2 (+0.1%) |
| Average memory (tree) | 179.1 MB | 168.3 MB | pboss (-6.0%) |
| Average cold startup | 524.6 ms | 396.6 ms | pboss (-24.4%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 60592.0 | 59661.9 | pm2 (-1.5%) |
| Mean requests/sec | 60456.5 | 59021.6 | pm2 (-2.4%) |
| RPS stdev (variability) | 941.8 | 1090.9 | pm2 (+15.8%) |
| Average latency (mean) | 0.05 ms | 0.05 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 72.6 | 72.6 | pm2 (+0.0%) |
| Median CPU % of tree | 74.0 | 74.0 | tie |
| Peak CPU % of tree | 78.0 | 78.0 | tie |
| Avg tree memory | 163.0 MB | 149.6 MB | pboss (-8.2%) |
| Median tree memory | 161.8 MB | 149.4 MB | pboss (-7.6%) |
| Cold startup (median) | 516.0 ms | 396.0 ms | pboss (-23.3%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [58,956, 60,791, 60,592, 60,407, 61,535] · pboss [59,905, 57,384, 59,743, 58,414, 59,662]_

## Fork mode — load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 56278.4 | 57516.8 | pboss (+2.2%) |
| Mean requests/sec | 57512.1 | 57518.6 | pboss (+0.0%) |
| RPS stdev (variability) | 2695.7 | 1180.5 | pboss (-56.2%) |
| Average latency (mean) | 1.44 ms | 1.40 ms | pboss (-2.8%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 73.9 | 74.0 | pm2 (+0.1%) |
| Median CPU % of tree | 74.0 | 74.0 | tie |
| Peak CPU % of tree | 79.6 | 78.8 | pboss (-1.0%) |
| Avg tree memory | 179.1 MB | 168.3 MB | pboss (-6.0%) |
| Median tree memory | 184.3 MB | 174.2 MB | pboss (-5.5%) |
| Cold startup (median) | 520.0 ms | 395.0 ms | pboss (-24.0%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [56,125, 56,706, 62,316, 56,278, 56,135] · pboss [56,302, 57,517, 56,392, 58,885, 58,498]_

## Fork mode — load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 54690.7 | 54057.6 | pm2 (-1.2%) |
| Mean requests/sec | 54452.4 | 54439.4 | pm2 (-0.0%) |
| RPS stdev (variability) | 1201.6 | 2224.0 | pm2 (+85.1%) |
| Average latency (mean) | 8.58 ms | 8.74 ms | pm2 (+1.9%) |
| Median p50 latency | 6.00 ms | 6.00 ms | tie |
| Median p90 latency | 13.00 ms | 12.00 ms | pboss (-7.7%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 35.00 ms | 35.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 74.8 | 75.2 | pm2 (+0.5%) |
| Median CPU % of tree | 76.0 | 76.0 | tie |
| Peak CPU % of tree | 79.2 | 81.6 | pm2 (+3.0%) |
| Avg tree memory | 210.6 MB | 206.0 MB | pboss (-2.1%) |
| Median tree memory | 221.3 MB | 215.4 MB | pboss (-2.7%) |
| Cold startup (median) | 536.0 ms | 396.0 ms | pboss (-26.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [52,455, 54,490, 54,960, 54,691, 55,666] · pboss [53,192, 52,224, 54,661, 58,062, 54,058]_

## Cluster mode — 2 workers

Each manager supervises N workers of the same `server.mjs` sharing one
port through `node:cluster` — the native Node clustering on BOTH sides:
pboss's `--instances N` (a supervised wrapper primary forks the workers)
and pm2's `-i N` (the pm2 daemon is the primary). The worker count and the
sharing mechanism are identical; only the manager differs.

### Cluster headline — 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 55954.0 | 58539.0 | pboss (+4.6%) |
| Average latency (mean) | 1.25 ms | 1.18 ms | pboss (-5.6%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Average CPU usage (tree) | 76.0 % | 75.3 % | pboss (-0.9%) |
| Average memory (tree) | 257.1 MB | 286.5 MB | pm2 (+11.4%) |
| Average cold startup | 623.8 ms | 427.4 ms | pboss (-31.5%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 52670.9 | 55643.7 | pboss (+5.6%) |
| Mean requests/sec | 53142.5 | 55732.0 | pboss (+4.9%) |
| RPS stdev (variability) | 1275.4 | 2421.1 | pm2 (+89.8%) |
| Average latency (mean) | 0.10 ms | 0.10 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 3.00 ms | 2.00 ms | pboss (-33.3%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 72.9 | 73.2 | pm2 (+0.5%) |
| Median CPU % of tree | 74.0 | 74.0 | tie |
| Peak CPU % of tree | 82.4 | 83.2 | pm2 (+1.0%) |
| Avg tree memory | 243.0 MB | 270.6 MB | pm2 (+11.4%) |
| Median tree memory | 243.0 MB | 271.4 MB | pm2 (+11.7%) |
| Cold startup (median) | 604.0 ms | 414.0 ms | pboss (-31.5%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [53,710, 52,671, 55,019, 51,659, 52,653] · pboss [53,991, 53,134, 59,335, 56,556, 55,644]_

### Cluster load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 55957.9 | 58556.3 | pboss (+4.6%) |
| Mean requests/sec | 55954.0 | 58539.0 | pboss (+4.6%) |
| RPS stdev (variability) | 1354.6 | 660.1 | pboss (-51.3%) |
| Average latency (mean) | 1.25 ms | 1.18 ms | pboss (-5.6%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 4.00 ms | 3.00 ms | pboss (-25.0%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 76.0 | 75.3 | pboss (-0.9%) |
| Median CPU % of tree | 76.4 | 76.0 | pboss (-0.5%) |
| Peak CPU % of tree | 83.6 | 82.0 | pboss (-1.9%) |
| Avg tree memory | 257.1 MB | 286.5 MB | pm2 (+11.4%) |
| Median tree memory | 258.2 MB | 290.0 MB | pm2 (+12.3%) |
| Cold startup (median) | 641.0 ms | 419.0 ms | pboss (-34.6%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [55,958, 55,561, 56,740, 53,955, 57,557] · pboss [59,351, 57,586, 58,556, 58,311, 58,891]_

### Cluster load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 54963.7 | 55802.1 | pboss (+1.5%) |
| Mean requests/sec | 55095.5 | 56012.7 | pboss (+1.7%) |
| RPS stdev (variability) | 1684.1 | 1359.3 | pboss (-19.3%) |
| Average latency (mean) | 8.62 ms | 8.48 ms | pboss (-1.6%) |
| Median p50 latency | 6.00 ms | 6.00 ms | tie |
| Median p90 latency | 17.00 ms | 16.00 ms | pboss (-5.9%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 39.00 ms | 39.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 77.4 | 77.1 | pboss (-0.4%) |
| Median CPU % of tree | 78.0 | 78.0 | tie |
| Peak CPU % of tree | 84.4 | 84.4 | tie |
| Avg tree memory | 291.3 MB | 325.8 MB | pm2 (+11.8%) |
| Median tree memory | 299.2 MB | 334.8 MB | pm2 (+11.9%) |
| Cold startup (median) | 637.0 ms | 465.0 ms | pboss (-27.0%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [53,380, 56,385, 57,187, 54,964, 53,563] · pboss [56,555, 54,868, 54,774, 58,064, 55,802]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 520.0 ms | 396.0 ms | pboss (-23.8%) |
| Warm startup, fork (median) | 270.0 ms | 174.0 ms | pboss (-35.6%) |
| Warm startup, fork (max) | 321.0 ms | 181.0 ms | pboss (-43.6%) |
| Cold startup, cluster (median of medians) | 637.0 ms | 419.0 ms | pboss (-34.2%) |
| Warm startup, cluster (median) | 422.0 ms | 242.0 ms | pboss (-42.7%) |
| Warm startup, cluster (max) | 468.0 ms | 258.0 ms | pboss (-44.9%) |


## Idle daemon overhead (no application running)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 68.7 MB | 65.2 MB | pboss (-5.1%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 134.9 ms | 68.4 ms | pboss (-49.3%) |
| Recovery (median) | 127.5 ms | 68.0 ms | pboss (-46.7%) |
| Recovery (max) | 194.0 ms | 70.0 ms | pboss (-63.9%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | 151.1 ms | 93.2 ms | pboss (-38.3%) |
| Worker respawn (median) | 155.5 ms | 97.5 ms | pboss (-37.3%) |
| Worker respawn (max) | 199.0 ms | 103.0 ms | pboss (-48.2%) |
| Failed replacements | 0 | 0 | — |
| Health stayed up | 100.0 % of kills | 100.0 % of kills | tie |


## Restart storm — fork

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 376.0 ms | 181.0 ms | pboss (-51.9%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 69.9 MB | 58.5 MB | pboss (-16.4%) |
| App RSS after | 70.9 MB | 58.2 MB | pboss (-17.9%) |
| Memory growth (after − before) | 0.9 MB | -0.3 MB | — |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 498.0 ms | 300.0 ms | pboss (-39.8%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| Workers' RSS before | 141.3 MB | 114.3 MB | pboss (-19.1%) |
| Workers' RSS after | 142.9 MB | 114.2 MB | pboss (-20.1%) |
| Memory growth (after − before) | 1.6 MB | -0.1 MB | pboss (-106.0%) |


## Reproduce

```bash
cd benchmarks/node
npm install                     # pm2 + autocannon (local, pinned)
bash scripts/benchmark.sh       # default profile — BENCH_PROFILE=smoke first
BENCH_PROFILE=full bash scripts/benchmark.sh    # + the 1000-conn stress level
BENCH_INSTANCES=4 bash scripts/benchmark.sh      # cluster workers (default: cores)
# from a pboss repo checkout instead of an installed CLI:
# PBOSS_CMD="bun run /path/to/pboss/src/main.ts" bash scripts/benchmark.sh
```

Raw data: every number above traces to a file under `results/raw/` —
`run.jsonl` records, full autocannon JSON, `/proc` resource CSVs, recovery
and storm event logs (fork and cluster each). `results/summary.csv` is the
same data in one sheet; `results/REPORT.html` is this report as a page.

_Don't read one run. The medians and the per-run lists above show the
repeats and the variability; a single run never decides a column._
