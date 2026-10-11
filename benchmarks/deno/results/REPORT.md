# pboss vs pup — managing a Deno HTTP server

The same `server.ts`, the same Deno binary, the same machine, the same
load — the only difference is which process manager supervises it. This
measures the **overhead of managing** a Deno server, not Deno's raw HTTP
performance. Both supervision models are covered: **fork** (one managed
process) and **cluster** (N workers behind one port) — and for Deno apps
BOTH managers cluster natively, each with its own model: pboss's
`--instances N` (workers share one SO_REUSEPORT port) and pup's
`cluster{instances, commonPort, startPort}` (a built-in load balancer
fronting N backend processes).

_An HTML version of this summary lives beside it: `results/REPORT.html`._

| Environment |  |
| --- | --- |
| Date | 2026-10-11T05:55:43.802Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | deno 2.9.7 · pup 1.0.4 · pboss v1.8.0 |
| Profile | standard — loads 10/100/500 conns, 60s each, 10s warmup, 5 repeat(s) per manager |
| Cluster | 2 workers per manager — pboss (SO_REUSEPORT), pup (load balancer) |

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
  and for Deno apps BOTH managers cluster natively, each with its own
  model: pboss's `--instances N` runs N workers all binding the same
  port through SO_REUSEPORT (the kernel balances); pup's
  `cluster{instances, commonPort, startPort}` runs one backend per
  worker on private ports behind its built-in load balancer on the
  common port. The client-facing port and the worker count are the
  same on both sides; only the manager (and its cluster model) differs.

_Winner names the column that scored better; the percentage beside it is the relative difference (pboss − pup) / pup × 100 — positive means pboss scored the higher number. For throughput higher is better; for every other metric in these tables lower is better, and the Winner column already accounts for the direction. A row that is exactly level reads “tie”._

## Fork mode — headline, 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 72533.9 | 71706.7 | pup (-1.1%) |
| Average latency (mean) | 0.80 ms | 0.94 ms | pup (+17.5%) |
| Median p50 latency | 0.00 ms | 1.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 24.00 ms | 25.00 ms | pup (+4.2%) |
| Average CPU usage (tree) | 61.2 % | 61.3 % | pup (+0.2%) |
| Average memory (tree) | 134.2 MB | 116.6 MB | pboss (-13.1%) |
| Average cold startup | 1091.2 ms | 342.4 ms | pboss (-68.6%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 79092.3 | 78641.9 | pup (-0.6%) |
| Mean requests/sec | 78376.0 | 79563.7 | pboss (+1.5%) |
| RPS stdev (variability) | 1959.1 | 3022.9 | pup (+54.3%) |
| Average latency (mean) | 0.04 ms | 0.04 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 63.6 | 63.6 | pup (+0.1%) |
| Median CPU % of tree | 64.4 | 64.0 | pboss (-0.6%) |
| Peak CPU % of tree | 68.8 | 70.8 | pup (+2.9%) |
| Avg tree memory | 131.5 MB | 114.8 MB | pboss (-12.7%) |
| Median tree memory | 129.9 MB | 114.9 MB | pboss (-11.6%) |
| Cold startup (median) | 1047.0 ms | 338.0 ms | pboss (-67.7%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [75,643, 80,559, 79,431, 79,092, 77,154] · pboss [78,642, 77,316, 84,877, 78,740, 78,243]_

## Fork mode — load: 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 72988.0 | 71067.5 | pup (-2.6%) |
| Mean requests/sec | 72533.9 | 71706.7 | pup (-1.1%) |
| RPS stdev (variability) | 2830.4 | 2913.0 | pup (+2.9%) |
| Average latency (mean) | 0.80 ms | 0.94 ms | pup (+17.5%) |
| Median p50 latency | 0.00 ms | 1.00 ms | — |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 24.00 ms | 25.00 ms | pup (+4.2%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 61.2 | 61.3 | pup (+0.2%) |
| Median CPU % of tree | 62.0 | 62.0 | tie |
| Peak CPU % of tree | 67.6 | 68.4 | pup (+1.2%) |
| Avg tree memory | 134.2 MB | 116.6 MB | pboss (-13.1%) |
| Median tree memory | 132.6 MB | 116.6 MB | pboss (-12.0%) |
| Cold startup (median) | 1063.0 ms | 339.0 ms | pboss (-68.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [72,988, 71,726, 76,133, 73,457, 68,365] · pboss [68,958, 75,662, 69,168, 73,678, 71,067]_

## Fork mode — load: 500 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 66961.1 | 66752.5 | pup (-0.3%) |
| Mean requests/sec | 67071.0 | 66219.3 | pup (-1.3%) |
| RPS stdev (variability) | 2209.6 | 1657.4 | pboss (-25.0%) |
| Average latency (mean) | 6.98 ms | 7.01 ms | pup (+0.4%) |
| Median p50 latency | 5.00 ms | 5.00 ms | tie |
| Median p90 latency | 7.00 ms | 7.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 33.00 ms | 33.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 58.8 | 59.2 | pup (+0.5%) |
| Median CPU % of tree | 59.2 | 59.6 | pup (+0.7%) |
| Peak CPU % of tree | 64.8 | 65.2 | pup (+0.6%) |
| Avg tree memory | 142.4 MB | 123.4 MB | pboss (-13.3%) |
| Median tree memory | 140.8 MB | 123.4 MB | pboss (-12.3%) |
| Cold startup (median) | 1072.0 ms | 342.0 ms | pboss (-68.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [64,827, 67,995, 70,297, 66,961, 65,275] · pboss [64,444, 66,926, 66,753, 64,628, 68,346]_

## Cluster mode — 2 workers

Each manager supervises N workers of the same `server.ts` behind one
port — each with its own native Deno clustering: pboss's `--instances N`
(N workers, all binding the SAME port through SO_REUSEPORT) and pup's
`cluster{instances, commonPort, startPort}` (N backends on private
ports, fronted by pup's built-in load balancer on the common port).

### Cluster headline — 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 13034.7 | 73434.5 | pboss (+463.4%) |
| Average latency (mean) | 7.25 ms | 0.70 ms | pboss (-90.3%) |
| Median p50 latency | 5.00 ms | 0.00 ms | pboss (-100.0%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 32.00 ms | 25.00 ms | pboss (-21.9%) |
| Average CPU usage (tree) | 123.1 % | 63.2 % | pboss (-48.7%) |
| Average memory (tree) | 267.4 MB | 163.5 MB | pboss (-38.9%) |
| Average cold startup | 1111.8 ms | 540.2 ms | pboss (-51.4%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 15024.3 | 73170.9 | pboss (+387.0%) |
| Mean requests/sec | 15022.0 | 73833.6 | pboss (+391.5%) |
| RPS stdev (variability) | 337.6 | 1864.2 | pup (+452.2%) |
| Average latency (mean) | 0.35 ms | 0.04 ms | pboss (-88.6%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 6.00 ms | 0.00 ms | pboss (-100.0%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 115.8 | 69.6 | pboss (-39.9%) |
| Median CPU % of tree | 117.6 | 70.0 | pboss (-40.5%) |
| Peak CPU % of tree | 126.8 | 78.4 | pboss (-38.2%) |
| Avg tree memory | 258.1 MB | 162.4 MB | pboss (-37.1%) |
| Median tree memory | 256.4 MB | 162.4 MB | pboss (-36.7%) |
| Cold startup (median) | 1075.0 ms | 536.0 ms | pboss (-50.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [14,491, 15,024, 15,410, 15,008, 15,177] · pboss [73,171, 75,503, 72,137, 76,123, 72,235]_

### Cluster load: 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 12935.1 | 74170.7 | pboss (+473.4%) |
| Mean requests/sec | 13034.7 | 73434.5 | pboss (+463.4%) |
| RPS stdev (variability) | 406.1 | 2130.9 | pup (+424.7%) |
| Average latency (mean) | 7.25 ms | 0.70 ms | pboss (-90.3%) |
| Median p50 latency | 5.00 ms | 0.00 ms | pboss (-100.0%) |
| Median p90 latency | 11.00 ms | 1.00 ms | pboss (-90.9%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 32.00 ms | 25.00 ms | pboss (-21.9%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 123.1 | 63.2 | pboss (-48.7%) |
| Median CPU % of tree | 124.4 | 64.0 | pboss (-48.6%) |
| Peak CPU % of tree | 130.0 | 70.8 | pboss (-45.5%) |
| Avg tree memory | 267.4 MB | 163.5 MB | pboss (-38.9%) |
| Median tree memory | 267.0 MB | 163.5 MB | pboss (-38.8%) |
| Cold startup (median) | 1131.0 ms | 538.0 ms | pboss (-52.4%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [13,659, 12,829, 12,587, 12,935, 13,163] · pboss [75,229, 72,438, 75,140, 74,171, 70,194]_

### Cluster load: 500 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 13596.5 | 64990.4 | pboss (+378.0%) |
| Mean requests/sec | 13734.5 | 64882.6 | pboss (+372.4%) |
| RPS stdev (variability) | 350.9 | 873.8 | pup (+149.1%) |
| Average latency (mean) | 36.33 ms | 7.20 ms | pboss (-80.2%) |
| Median p50 latency | 6.00 ms | 5.00 ms | pboss (-16.7%) |
| Median p90 latency | 29.00 ms | 8.00 ms | pboss (-72.4%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 902.00 ms | 33.00 ms | pboss (-96.3%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 123.7 | 59.8 | pboss (-51.6%) |
| Median CPU % of tree | 124.8 | 60.0 | pboss (-51.9%) |
| Peak CPU % of tree | 132.0 | 67.6 | pboss (-48.8%) |
| Avg tree memory | 366.3 MB | 170.5 MB | pboss (-53.4%) |
| Median tree memory | 364.4 MB | 170.6 MB | pboss (-53.2%) |
| Cold startup (median) | 1095.0 ms | 539.0 ms | pboss (-50.8%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [13,597, 14,142, 13,368, 14,073, 13,493] · pboss [65,642, 65,645, 64,595, 64,990, 63,540]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 1063.0 ms | 339.0 ms | pboss (-68.1%) |
| Warm startup, fork (median) | 273.0 ms | 136.0 ms | pboss (-50.2%) |
| Warm startup, fork (max) | 275.0 ms | 187.0 ms | pboss (-32.0%) |
| Cold startup, cluster (median of medians) | 1095.0 ms | 538.0 ms | pboss (-50.9%) |
| Warm startup, cluster (median) | 249.0 ms | 191.0 ms | pboss (-23.3%) |
| Warm startup, cluster (max) | 1321.0 ms | 363.0 ms | pboss (-72.5%) |


## Idle daemon overhead (no application running)

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 88.8 MB | 63.7 MB | pboss (-28.3%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 10959.1 ms | 67.1 ms | pboss (-99.4%) |
| Recovery (median) | 10977.5 ms | 67.0 ms | pboss (-99.4%) |
| Recovery (max) | 11001.0 ms | 68.0 ms | pboss (-99.4%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | 10833.8 ms | 83.6 ms | pboss (-99.2%) |
| Worker respawn (median) | 10930.0 ms | 81.0 ms | pboss (-99.3%) |
| Worker respawn (max) | 10977.0 ms | 96.0 ms | pboss (-99.1%) |
| Failed replacements | 1 | 0 | pboss (-100.0%) |
| Health stayed up | 77.8 % of kills | 100.0 % of kills | pup (+28.6%) |


## Restart storm — fork

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 1011.5 ms | 167.0 ms | pboss (-83.5%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 34.6 MB | 31.5 MB | pboss (-9.0%) |
| App RSS after | 31.7 MB | 32.2 MB | pup (+1.6%) |
| Memory growth (after − before) | -2.9 MB | 0.7 MB | pboss (-122.9%) |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 1312.0 ms | 189.5 ms | pboss (-85.6%) |
| Failed restarts | 1 | 0 | pboss (-100.0%) |
| Orphaned processes after | 0 | 0 | — |
| Workers' RSS before | 66.0 MB | 65.4 MB | pboss (-0.9%) |
| Workers' RSS after | 64.6 MB | 66.3 MB | pup (+2.6%) |
| Memory growth (after − before) | -1.4 MB | 0.8 MB | pboss (-157.5%) |


## Reproduce

```bash
cd benchmarks/deno
npm install                     # autocannon (local, pinned)
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
