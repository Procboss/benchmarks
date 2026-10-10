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
| Date | 2026-10-10T06:20:46.257Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | node v24.21.0 · pm2 5.4.3 · pboss pboss v1.7.5 |
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
| Average requests/sec | 55336.9 | 55222.9 | pm2 (-0.2%) |
| Average latency (mean) | 1.45 ms | 1.42 ms | pboss (-2.1%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Average CPU usage (tree) | 74.0 % | 74.1 % | pm2 (+0.1%) |
| Average memory (tree) | 178.1 MB | 167.7 MB | pboss (-5.9%) |
| Average cold startup | 516.6 ms | 405.6 ms | pboss (-21.5%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 60104.5 | 56782.4 | pm2 (-5.5%) |
| Mean requests/sec | 59658.7 | 56946.1 | pm2 (-4.5%) |
| RPS stdev (variability) | 2294.2 | 1467.7 | pboss (-36.0%) |
| Average latency (mean) | 0.05 ms | 0.05 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 72.5 | 72.7 | pm2 (+0.3%) |
| Median CPU % of tree | 74.0 | 74.0 | tie |
| Peak CPU % of tree | 78.8 | 78.4 | pboss (-0.5%) |
| Avg tree memory | 162.3 MB | 148.7 MB | pboss (-8.4%) |
| Median tree memory | 161.9 MB | 148.7 MB | pboss (-8.2%) |
| Cold startup (median) | 498.0 ms | 393.0 ms | pboss (-21.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [55,726, 61,064, 60,105, 61,489, 59,910] · pboss [55,066, 59,183, 56,975, 56,725, 56,782]_

## Fork mode — load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 55396.8 | 55683.7 | pboss (+0.5%) |
| Mean requests/sec | 55336.9 | 55222.9 | pm2 (-0.2%) |
| RPS stdev (variability) | 521.7 | 1781.8 | pm2 (+241.5%) |
| Average latency (mean) | 1.45 ms | 1.42 ms | pboss (-2.1%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 74.0 | 74.1 | pm2 (+0.1%) |
| Median CPU % of tree | 74.0 | 74.4 | pm2 (+0.5%) |
| Peak CPU % of tree | 79.2 | 80.4 | pm2 (+1.5%) |
| Avg tree memory | 178.1 MB | 167.7 MB | pboss (-5.9%) |
| Median tree memory | 183.4 MB | 172.4 MB | pboss (-6.0%) |
| Cold startup (median) | 517.0 ms | 397.0 ms | pboss (-23.2%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [54,658, 56,089, 55,427, 55,397, 55,114] · pboss [55,684, 52,148, 55,607, 56,785, 55,891]_

## Fork mode — load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 51481.1 | 52400.5 | pboss (+1.8%) |
| Mean requests/sec | 51356.4 | 52958.7 | pboss (+3.1%) |
| RPS stdev (variability) | 1600.1 | 1346.7 | pboss (-15.8%) |
| Average latency (mean) | 9.26 ms | 9.12 ms | pboss (-1.5%) |
| Median p50 latency | 7.00 ms | 7.00 ms | tie |
| Median p90 latency | 14.00 ms | 13.00 ms | pboss (-7.1%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 36.00 ms | 35.00 ms | pboss (-2.8%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 75.2 | 75.4 | pm2 (+0.3%) |
| Median CPU % of tree | 76.0 | 76.0 | tie |
| Peak CPU % of tree | 80.0 | 80.8 | pm2 (+1.0%) |
| Avg tree memory | 211.3 MB | 202.4 MB | pboss (-4.2%) |
| Median tree memory | 222.5 MB | 214.1 MB | pboss (-3.8%) |
| Cold startup (median) | 502.0 ms | 390.0 ms | pboss (-22.3%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [51,481, 51,462, 53,327, 48,858, 51,653] · pboss [53,491, 51,805, 55,070, 52,401, 52,026]_

## Cluster mode — 2 workers

Each manager supervises N workers of the same `server.mjs` sharing one
port through `node:cluster` — the native Node clustering on BOTH sides:
pboss's `--instances N` (a supervised wrapper primary forks the workers)
and pm2's `-i N` (the pm2 daemon is the primary). The worker count and the
sharing mechanism are identical; only the manager differs.

### Cluster headline — 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 54043.2 | 56407.9 | pboss (+4.4%) |
| Average latency (mean) | 1.32 ms | 1.25 ms | pboss (-5.3%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Average CPU usage (tree) | 75.8 % | 76.0 % | pm2 (+0.3%) |
| Average memory (tree) | 257.4 MB | 284.9 MB | pm2 (+10.7%) |
| Average cold startup | 601.4 ms | 412.2 ms | pboss (-31.5%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 54088.0 | 53762.1 | pm2 (-0.6%) |
| Mean requests/sec | 52954.8 | 53151.7 | pboss (+0.4%) |
| RPS stdev (variability) | 4077.5 | 1780.3 | pboss (-56.3%) |
| Average latency (mean) | 0.10 ms | 0.10 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 3.00 ms | 3.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 73.4 | 73.2 | pboss (-0.2%) |
| Median CPU % of tree | 73.8 | 74.0 | pm2 (+0.3%) |
| Peak CPU % of tree | 82.4 | 83.6 | pm2 (+1.5%) |
| Avg tree memory | 244.9 MB | 271.7 MB | pm2 (+10.9%) |
| Median tree memory | 244.8 MB | 272.8 MB | pm2 (+11.4%) |
| Cold startup (median) | 622.0 ms | 410.0 ms | pboss (-34.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [56,267, 54,088, 55,696, 52,595, 46,128] · pboss [52,267, 50,498, 54,306, 53,762, 54,926]_

### Cluster load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 53901.9 | 56336.0 | pboss (+4.5%) |
| Mean requests/sec | 54043.2 | 56407.9 | pboss (+4.4%) |
| RPS stdev (variability) | 997.6 | 1181.7 | pm2 (+18.5%) |
| Average latency (mean) | 1.32 ms | 1.25 ms | pboss (-5.3%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 4.00 ms | 3.00 ms | pboss (-25.0%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 26.00 ms | 26.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 75.8 | 76.0 | pm2 (+0.3%) |
| Median CPU % of tree | 76.4 | 76.0 | pboss (-0.5%) |
| Peak CPU % of tree | 84.4 | 86.4 | pm2 (+2.4%) |
| Avg tree memory | 257.4 MB | 284.9 MB | pm2 (+10.7%) |
| Median tree memory | 258.5 MB | 288.4 MB | pm2 (+11.5%) |
| Cold startup (median) | 608.0 ms | 413.0 ms | pboss (-32.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [52,962, 53,902, 55,385, 53,282, 54,686] · pboss [55,970, 56,336, 57,439, 57,595, 54,700]_

### Cluster load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 54024.5 | 52895.5 | pm2 (-2.1%) |
| Mean requests/sec | 54169.2 | 53100.8 | pm2 (-2.0%) |
| RPS stdev (variability) | 1345.0 | 2722.7 | pm2 (+102.4%) |
| Average latency (mean) | 8.78 ms | 8.98 ms | pm2 (+2.3%) |
| Median p50 latency | 6.00 ms | 6.00 ms | tie |
| Median p90 latency | 18.00 ms | 18.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 40.00 ms | 40.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 77.5 | 77.3 | pboss (-0.2%) |
| Median CPU % of tree | 78.0 | 78.0 | tie |
| Peak CPU % of tree | 86.0 | 85.6 | pboss (-0.5%) |
| Avg tree memory | 289.5 MB | 322.8 MB | pm2 (+11.5%) |
| Median tree memory | 297.6 MB | 330.1 MB | pm2 (+10.9%) |
| Cold startup (median) | 566.0 ms | 409.0 ms | pboss (-27.7%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [54,933, 53,418, 52,494, 54,025, 55,975] · pboss [52,895, 52,883, 53,254, 57,077, 49,395]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 502.0 ms | 393.0 ms | pboss (-21.7%) |
| Warm startup, fork (median) | 292.0 ms | 177.0 ms | pboss (-39.4%) |
| Warm startup, fork (max) | 343.0 ms | 191.0 ms | pboss (-44.3%) |
| Cold startup, cluster (median of medians) | 608.0 ms | 410.0 ms | pboss (-32.6%) |
| Warm startup, cluster (median) | 388.0 ms | 263.0 ms | pboss (-32.2%) |
| Warm startup, cluster (max) | 442.0 ms | 332.0 ms | pboss (-24.9%) |


## Idle daemon overhead (no application running)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 68.7 MB | 63.5 MB | pboss (-7.5%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 139.9 ms | 70.5 ms | pboss (-49.6%) |
| Recovery (median) | 129.5 ms | 70.0 ms | pboss (-45.9%) |
| Recovery (max) | 185.0 ms | 72.0 ms | pboss (-61.1%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | 169.3 ms | 7968.7 ms | pm2 (+4606.9%) |
| Worker respawn (median) | 191.5 ms | 7301.0 ms | pm2 (+3712.5%) |
| Worker respawn (max) | 205.0 ms | 15071.0 ms | pm2 (+7251.7%) |
| Failed replacements | 0 | 0 | — |
| Health stayed up | 100.0 % of kills | 100.0 % of kills | tie |


## Restart storm — fork

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 378.5 ms | 182.0 ms | pboss (-51.9%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 71.7 MB | 57.9 MB | pboss (-19.1%) |
| App RSS after | 72.2 MB | 56.5 MB | pboss (-21.7%) |
| Memory growth (after − before) | 0.5 MB | -1.4 MB | — |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 489.0 ms | 284.5 ms | pboss (-41.8%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| Workers' RSS before | 145.0 MB | 114.3 MB | pboss (-21.2%) |
| Workers' RSS after | 145.1 MB | 114.4 MB | pboss (-21.2%) |
| Memory growth (after − before) | 0.2 MB | 0.2 MB | — |


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
