# pboss vs pm2 — managing a Bun HTTP server

The same `server.ts`, the same Bun executable, the same machine, the same
load — the only difference is which process manager supervises it. This
measures the **overhead of managing** a Bun server, not Bun's raw HTTP
performance. Both supervision models are covered: **fork** (one managed
process) and **cluster** (N workers sharing one port).

_An HTML version of this summary lives beside it: `results/REPORT.html`._

| Environment |  |
| --- | --- |
| Date | 2026-10-10T00:19:24.659Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | bun 1.3.14 · node v24.21.0 · pm2 5.4.3 · pboss pboss v1.7.5 |
| Profile | standard — loads 10/100/500 conns, 60s each, 10s warmup, 5 repeat(s) per manager |
| Cluster | 2 workers per manager (SO_REUSEPORT) |

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
- **Cluster mode** runs the same matrix with N workers per manager: pboss
  uses its native process-based cluster (`--instances N`); pm2 cannot wrap
  a Bun app in `node:cluster`, so `-i N` runs the N instances as fork-mode
  processes — the same independent-Bun-processes-on-one-`SO_REUSEPORT`-port
  model on both sides, and the only variable stays the manager.

_Winner names the column that scored better; the percentage beside it is the relative difference (pboss − pm2) / pm2 × 100 — positive means pboss scored the higher number. For throughput higher is better; for every other metric in these tables lower is better, and the Winner column already accounts for the direction. A row that is exactly level reads “tie”._

## Fork mode — headline, 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 73509.0 | 71387.1 | pm2 (-2.9%) |
| Average latency (mean) | 0.75 ms | 0.73 ms | pboss (-2.7%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Average CPU usage (tree) | 67.2 % | 67.0 % | pboss (-0.2%) |
| Average memory (tree) | 118.9 MB | 117.2 MB | pboss (-1.4%) |
| Average cold startup | 367.6 ms | 335.4 ms | pboss (-8.8%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 75152.0 | 74461.1 | pm2 (-0.9%) |
| Mean requests/sec | 75556.3 | 73923.9 | pm2 (-2.2%) |
| RPS stdev (variability) | 2606.4 | 1313.4 | pboss (-49.6%) |
| Average latency (mean) | 0.04 ms | 0.04 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 68.7 | 68.6 | pboss (-0.2%) |
| Median CPU % of tree | 69.6 | 70.0 | pm2 (+0.6%) |
| Peak CPU % of tree | 74.8 | 76.4 | pm2 (+2.1%) |
| Avg tree memory | 119.1 MB | 116.9 MB | pboss (-1.9%) |
| Median tree memory | 119.1 MB | 116.9 MB | pboss (-1.9%) |
| Cold startup (median) | 372.0 ms | 330.0 ms | pboss (-11.3%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [73,810, 76,685, 79,396, 75,152, 72,738] · pboss [74,978, 75,085, 72,974, 72,121, 74,461]_

## Fork mode — load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 73422.9 | 73384.3 | pm2 (-0.1%) |
| Mean requests/sec | 73509.0 | 71387.1 | pm2 (-2.9%) |
| RPS stdev (variability) | 934.6 | 3528.5 | pm2 (+277.5%) |
| Average latency (mean) | 0.75 ms | 0.73 ms | pboss (-2.7%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 67.2 | 67.0 | pboss (-0.2%) |
| Median CPU % of tree | 68.0 | 67.2 | pboss (-1.2%) |
| Peak CPU % of tree | 71.2 | 72.8 | pm2 (+2.2%) |
| Avg tree memory | 118.9 MB | 117.2 MB | pboss (-1.4%) |
| Median tree memory | 118.9 MB | 117.2 MB | pboss (-1.5%) |
| Cold startup (median) | 371.0 ms | 334.0 ms | pboss (-10.0%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [74,182, 72,642, 72,591, 74,708, 73,423] · pboss [69,578, 73,804, 74,166, 66,004, 73,384]_

## Fork mode — load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 64767.2 | 68741.3 | pboss (+6.1%) |
| Mean requests/sec | 65674.6 | 68479.3 | pboss (+4.3%) |
| RPS stdev (variability) | 3025.6 | 1622.3 | pboss (-46.4%) |
| Average latency (mean) | 7.31 ms | 6.88 ms | pboss (-5.9%) |
| Median p50 latency | 5.00 ms | 5.00 ms | tie |
| Median p90 latency | 8.00 ms | 7.00 ms | pboss (-12.5%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 33.00 ms | 32.00 ms | pboss (-3.0%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 64.1 | 64.9 | pm2 (+1.2%) |
| Median CPU % of tree | 64.8 | 65.4 | pm2 (+0.9%) |
| Peak CPU % of tree | 70.4 | 71.2 | pm2 (+1.1%) |
| Avg tree memory | 119.5 MB | 116.1 MB | pboss (-2.9%) |
| Median tree memory | 119.5 MB | 116.1 MB | pboss (-2.9%) |
| Cold startup (median) | 367.0 ms | 334.0 ms | pboss (-9.0%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [69,742, 62,955, 63,030, 64,767, 67,879] · pboss [70,261, 68,741, 67,333, 66,362, 69,699]_

## Cluster mode — 2 workers

Each manager supervises the SAME N Bun workers of the same `server.ts`,
all binding the same port through `SO_REUSEPORT` (the kernel balances
connections across them). pboss clusters with `--instances N`; pm2's
`-i N` cannot wrap a Bun app in `node:cluster` and instead runs the N
instances as fork-mode processes — the worker count and the sharing
mechanism are identical either way.

### Cluster headline — 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 74886.0 | 73433.5 | pm2 (-1.9%) |
| Average latency (mean) | 0.64 ms | 0.74 ms | pm2 (+15.6%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Average CPU usage (tree) | 70.5 % | 70.3 % | pboss (-0.3%) |
| Average memory (tree) | 165.0 MB | 165.3 MB | pm2 (+0.2%) |
| Average cold startup | 394.4 ms | 464.2 ms | pm2 (+17.7%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 72169.3 | 72314.1 | pboss (+0.2%) |
| Mean requests/sec | 72483.5 | 70422.8 | pm2 (-2.8%) |
| RPS stdev (variability) | 2115.0 | 4664.8 | pm2 (+120.6%) |
| Average latency (mean) | 0.04 ms | 0.04 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 73.0 | 73.1 | pm2 (+0.1%) |
| Median CPU % of tree | 74.0 | 74.0 | tie |
| Peak CPU % of tree | 81.6 | 82.8 | pm2 (+1.5%) |
| Avg tree memory | 164.3 MB | 165.0 MB | pm2 (+0.4%) |
| Median tree memory | 164.4 MB | 165.1 MB | pm2 (+0.4%) |
| Cold startup (median) | 385.0 ms | 460.0 ms | pm2 (+19.5%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [70,737, 74,985, 72,169, 74,312, 70,215] · pboss [73,935, 70,681, 62,346, 72,838, 72,314]_

### Cluster load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 75733.3 | 73640.3 | pm2 (-2.8%) |
| Mean requests/sec | 74886.0 | 73433.5 | pm2 (-1.9%) |
| RPS stdev (variability) | 2270.0 | 2419.6 | pm2 (+6.6%) |
| Average latency (mean) | 0.64 ms | 0.74 ms | pm2 (+15.6%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 70.5 | 70.3 | pboss (-0.3%) |
| Median CPU % of tree | 71.2 | 70.8 | pboss (-0.6%) |
| Peak CPU % of tree | 78.4 | 76.8 | pboss (-2.0%) |
| Avg tree memory | 165.0 MB | 165.3 MB | pm2 (+0.2%) |
| Median tree memory | 165.0 MB | 165.4 MB | pm2 (+0.2%) |
| Cold startup (median) | 393.0 ms | 464.0 ms | pm2 (+18.1%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [74,397, 75,733, 76,486, 71,152, 76,662] · pboss [73,640, 75,812, 70,397, 71,611, 75,707]_

### Cluster load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 68056.0 | 65982.7 | pm2 (-3.0%) |
| Mean requests/sec | 66760.4 | 65807.3 | pm2 (-1.4%) |
| RPS stdev (variability) | 3705.7 | 2974.0 | pboss (-19.7%) |
| Average latency (mean) | 6.96 ms | 7.22 ms | pm2 (+3.7%) |
| Median p50 latency | 5.00 ms | 5.00 ms | tie |
| Median p90 latency | 7.00 ms | 8.00 ms | pm2 (+14.3%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 32.00 ms | 33.00 ms | pm2 (+3.1%) |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 66.1 | 66.4 | pm2 (+0.5%) |
| Median CPU % of tree | 66.8 | 66.8 | tie |
| Peak CPU % of tree | 72.4 | 74.0 | pm2 (+2.2%) |
| Avg tree memory | 163.8 MB | 164.3 MB | pm2 (+0.3%) |
| Median tree memory | 163.8 MB | 164.3 MB | pm2 (+0.3%) |
| Cold startup (median) | 399.0 ms | 457.0 ms | pm2 (+14.5%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [61,026, 68,056, 70,195, 69,270, 65,255] · pboss [62,235, 65,983, 69,471, 63,538, 67,810]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 371.0 ms | 334.0 ms | pboss (-10.0%) |
| Warm startup, fork (median) | 214.0 ms | 122.0 ms | pboss (-43.0%) |
| Warm startup, fork (max) | 267.0 ms | 132.0 ms | pboss (-50.6%) |
| Cold startup, cluster (median of medians) | 393.0 ms | 460.0 ms | pm2 (+17.0%) |
| Warm startup, cluster (median) | 190.0 ms | 156.0 ms | pboss (-17.9%) |
| Warm startup, cluster (max) | 223.0 ms | 275.0 ms | pm2 (+23.3%) |


## Idle daemon overhead (no application running)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 66.9 MB | 63.7 MB | pboss (-4.8%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 67.8 ms | 65.5 ms | pboss (-3.4%) |
| Recovery (median) | 67.5 ms | 65.0 ms | pboss (-3.7%) |
| Recovery (max) | 72.0 ms | 67.0 ms | pboss (-6.9%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | 79.8 ms | 76.4 ms | pboss (-4.3%) |
| Worker respawn (median) | 79.0 ms | 77.0 ms | pboss (-2.5%) |
| Worker respawn (max) | 88.0 ms | 79.0 ms | pboss (-10.2%) |
| Failed replacements | 0 | 0 | — |
| Health stayed up | 100.0 % of kills | 100.0 % of kills | tie |


## Restart storm — fork

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 249.5 ms | 117.0 ms | pboss (-53.1%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 35.3 MB | 35.2 MB | pboss (-0.2%) |
| App RSS after | 35.1 MB | 35.0 MB | pboss (-0.2%) |
| Memory growth (after − before) | -0.2 MB | -0.2 MB | — |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 393.5 ms | 180.0 ms | pboss (-54.3%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| Workers' RSS before | 70.5 MB | 73.9 MB | pm2 (+4.9%) |
| Workers' RSS after | 70.2 MB | 74.3 MB | pm2 (+5.8%) |
| Memory growth (after − before) | -0.3 MB | 0.4 MB | — |


## Reproduce

```bash
cd benchmarks/bun
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
