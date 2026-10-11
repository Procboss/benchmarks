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
| Date | 2026-10-11T12:56:46.197Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | deno 2.9.7 · pup 1.0.4 · pboss v1.8.1 |
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
| Average requests/sec | 68491.0 | 67953.3 | pup (-0.8%) |
| Average latency (mean) | 1.02 ms | 1.10 ms | pup (+7.8%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 24.00 ms | 24.00 ms | tie |
| Average CPU usage (tree) | 60.4 % | 60.1 % | pboss (-0.4%) |
| Average memory (tree) | 133.7 MB | 112.3 MB | pboss (-16.0%) |
| Average cold startup | 1156.2 ms | 328.2 ms | pboss (-71.6%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 76513.9 | 77480.5 | pboss (+1.3%) |
| Mean requests/sec | 75469.2 | 75881.4 | pboss (+0.5%) |
| RPS stdev (variability) | 1935.2 | 2716.9 | pup (+40.4%) |
| Average latency (mean) | 0.04 ms | 0.04 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 63.0 | 62.8 | pboss (-0.3%) |
| Median CPU % of tree | 64.0 | 64.0 | tie |
| Peak CPU % of tree | 71.6 | 67.2 | pboss (-6.1%) |
| Avg tree memory | 133.1 MB | 109.8 MB | pboss (-17.5%) |
| Median tree memory | 131.4 MB | 109.2 MB | pboss (-16.9%) |
| Cold startup (median) | 1070.0 ms | 314.0 ms | pboss (-70.7%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [76,721, 72,425, 76,514, 74,666, 77,021] · pboss [77,797, 71,616, 74,703, 77,481, 77,810]_

## Fork mode — load: 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 68897.1 | 67604.0 | pup (-1.9%) |
| Mean requests/sec | 68491.0 | 67953.3 | pup (-0.8%) |
| RPS stdev (variability) | 3561.7 | 1245.5 | pboss (-65.0%) |
| Average latency (mean) | 1.02 ms | 1.10 ms | pup (+7.8%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 24.00 ms | 24.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 60.4 | 60.1 | pboss (-0.4%) |
| Median CPU % of tree | 61.2 | 60.8 | pboss (-0.7%) |
| Peak CPU % of tree | 66.0 | 69.6 | pup (+5.5%) |
| Avg tree memory | 133.7 MB | 112.3 MB | pboss (-16.0%) |
| Median tree memory | 132.2 MB | 111.8 MB | pboss (-15.4%) |
| Cold startup (median) | 1161.0 ms | 318.0 ms | pboss (-72.6%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [72,242, 68,897, 64,320, 65,407, 71,589] · pboss [66,615, 68,926, 67,068, 67,604, 69,554]_

## Fork mode — load: 500 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 61610.7 | 62423.7 | pboss (+1.3%) |
| Mean requests/sec | 62883.4 | 62565.7 | pup (-0.5%) |
| RPS stdev (variability) | 2971.7 | 1353.3 | pboss (-54.5%) |
| Average latency (mean) | 7.63 ms | 7.53 ms | pboss (-1.3%) |
| Median p50 latency | 6.00 ms | 5.00 ms | pboss (-16.7%) |
| Median p90 latency | 9.00 ms | 8.00 ms | pboss (-11.1%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 33.00 ms | 33.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 58.1 | 57.8 | pboss (-0.6%) |
| Median CPU % of tree | 58.4 | 58.0 | pboss (-0.7%) |
| Peak CPU % of tree | 67.2 | 63.6 | pboss (-5.4%) |
| Avg tree memory | 140.7 MB | 120.5 MB | pboss (-14.4%) |
| Median tree memory | 138.9 MB | 120.0 MB | pboss (-13.6%) |
| Cold startup (median) | 1142.0 ms | 316.0 ms | pboss (-72.3%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [63,787, 60,118, 67,639, 61,611, 61,262] · pboss [60,512, 62,424, 63,569, 62,335, 63,990]_

## Cluster mode — 2 workers

Each manager supervises N workers of the same `server.ts` behind one
port — each with its own native Deno clustering: pboss's `--instances N`
(N workers, all binding the SAME port through SO_REUSEPORT) and pup's
`cluster{instances, commonPort, startPort}` (N backends on private
ports, fronted by pup's built-in load balancer on the common port).

### Cluster headline — 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 12444.4 | 69087.9 | pboss (+455.2%) |
| Average latency (mean) | 7.51 ms | 0.96 ms | pboss (-87.2%) |
| Median p50 latency | 6.00 ms | 1.00 ms | pboss (-83.3%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 32.00 ms | 25.00 ms | pboss (-21.9%) |
| Average CPU usage (tree) | 121.8 % | 62.2 % | pboss (-49.0%) |
| Average memory (tree) | 269.4 MB | 158.2 MB | pboss (-41.3%) |
| Average cold startup | 1191.6 ms | 513.0 ms | pboss (-56.9%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 14232.5 | 68663.9 | pboss (+382.4%) |
| Mean requests/sec | 14300.0 | 68529.9 | pboss (+379.2%) |
| RPS stdev (variability) | 207.6 | 2288.3 | pup (+1002.3%) |
| Average latency (mean) | 0.38 ms | 0.04 ms | pboss (-89.3%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 6.00 ms | 0.00 ms | pboss (-100.0%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 114.9 | 68.4 | pboss (-40.5%) |
| Median CPU % of tree | 116.0 | 69.0 | pboss (-40.5%) |
| Peak CPU % of tree | 123.7 | 76.3 | pboss (-38.3%) |
| Avg tree memory | 259.5 MB | 156.7 MB | pboss (-39.6%) |
| Median tree memory | 258.6 MB | 156.2 MB | pboss (-39.6%) |
| Cold startup (median) | 1093.0 ms | 512.0 ms | pboss (-53.2%) |

_Runs: 6 pm2 / 6 pboss. RPS per run: pm2 [14,319, 14,128, 14,128, 14,446, 14,633, 14,145] · pboss [65,019, 67,418, 67,418, 70,679, 69,910, 70,735]_

### Cluster load: 100 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 12512.3 | 69066.4 | pboss (+452.0%) |
| Mean requests/sec | 12444.4 | 69087.9 | pboss (+455.2%) |
| RPS stdev (variability) | 336.6 | 1117.5 | pup (+232.0%) |
| Average latency (mean) | 7.51 ms | 0.96 ms | pboss (-87.2%) |
| Median p50 latency | 6.00 ms | 1.00 ms | pboss (-83.3%) |
| Median p90 latency | 12.00 ms | 1.00 ms | pboss (-91.7%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 32.00 ms | 25.00 ms | pboss (-21.9%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 121.8 | 62.2 | pboss (-49.0%) |
| Median CPU % of tree | 123.6 | 63.0 | pboss (-49.0%) |
| Peak CPU % of tree | 130.0 | 69.6 | pboss (-46.5%) |
| Avg tree memory | 269.4 MB | 158.2 MB | pboss (-41.3%) |
| Median tree memory | 269.2 MB | 157.9 MB | pboss (-41.3%) |
| Cold startup (median) | 1184.0 ms | 513.0 ms | pboss (-56.7%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [12,512, 12,861, 12,105, 12,645, 12,098] · pboss [70,775, 69,431, 68,157, 69,066, 68,010]_

### Cluster load: 500 connections

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 12849.4 | 62577.3 | pboss (+387.0%) |
| Mean requests/sec | 12723.0 | 62606.8 | pboss (+392.1%) |
| RPS stdev (variability) | 311.4 | 1707.3 | pup (+448.3%) |
| Average latency (mean) | 38.18 ms | 7.45 ms | pboss (-80.5%) |
| Median p50 latency | 7.00 ms | 5.00 ms | pboss (-28.6%) |
| Median p90 latency | 29.00 ms | 9.00 ms | pboss (-69.0%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 957.00 ms | 33.00 ms | pboss (-96.6%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 122.7 | 58.4 | pboss (-52.4%) |
| Median CPU % of tree | 124.0 | 58.4 | pboss (-52.9%) |
| Peak CPU % of tree | 131.6 | 68.4 | pboss (-48.0%) |
| Avg tree memory | 364.5 MB | 166.5 MB | pboss (-54.3%) |
| Median tree memory | 363.3 MB | 166.3 MB | pboss (-54.2%) |
| Cold startup (median) | 1164.0 ms | 514.0 ms | pboss (-55.8%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [12,337, 12,878, 12,465, 13,086, 12,849] · pboss [62,386, 64,917, 62,577, 60,136, 63,017]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 1142.0 ms | 316.0 ms | pboss (-72.3%) |
| Warm startup, fork (median) | 285.0 ms | 159.0 ms | pboss (-44.2%) |
| Warm startup, fork (max) | 317.0 ms | 163.0 ms | pboss (-48.6%) |
| Cold startup, cluster (median of medians) | 1164.0 ms | 513.0 ms | pboss (-55.9%) |
| Warm startup, cluster (median) | 277.0 ms | 141.0 ms | pboss (-49.1%) |
| Warm startup, cluster (max) | 1332.0 ms | 333.0 ms | pboss (-75.0%) |


## Idle daemon overhead (no application running)

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 88.3 MB | 63.3 MB | pboss (-28.4%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 10957.5 ms | 67.2 ms | pboss (-99.4%) |
| Recovery (median) | 10972.5 ms | 67.0 ms | pboss (-99.4%) |
| Recovery (max) | 11014.0 ms | 69.0 ms | pboss (-99.4%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | 10921.0 ms | 87.3 ms | pboss (-99.2%) |
| Worker respawn (median) | 10947.5 ms | 84.5 ms | pboss (-99.2%) |
| Worker respawn (max) | 11009.0 ms | 104.0 ms | pboss (-99.1%) |
| Failed replacements | 0 | 0 | — |
| Health stayed up | 70.0 % of kills | 100.0 % of kills | pboss (+42.9%) |


## Restart storm — fork

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 1015.0 ms | 106.0 ms | pboss (-89.6%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 34.0 MB | 32.1 MB | pboss (-5.6%) |
| App RSS after | 34.5 MB | 34.2 MB | pboss (-1.0%) |
| Memory growth (after − before) | 0.5 MB | 2.1 MB | — |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 1325.0 ms | 150.0 ms | pboss (-88.7%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| Workers' RSS before | 64.4 MB | 66.2 MB | pup (+2.9%) |
| Workers' RSS after | 63.2 MB | 69.3 MB | pup (+9.8%) |
| Memory growth (after − before) | -1.2 MB | 3.1 MB | pup (+364.0%) |


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
