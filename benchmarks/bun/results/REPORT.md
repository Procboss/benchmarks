# pboss vs pm2 — managing a Bun HTTP server

The same `server.ts`, the same Bun executable, the same machine, the same
load — the only difference is which process manager supervises it. This
measures the **overhead of managing** a Bun server, not Bun's raw HTTP
performance. Both supervision models are covered: **fork** (one managed
process) and **cluster** (N workers sharing one port).

_An HTML version of this summary lives beside it: `results/REPORT.html`._

| Environment |  |
| --- | --- |
| Date | 2026-10-10T05:20:33.265Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | bun 1.3.14 · node v24.21.0 · pm2 5.4.3 · pboss pboss v1.7.5 |
| Profile | standard — loads 10/100/500 conns, 60s each, 10s warmup, 5 repeat(s) per manager |
| Cluster | 2 workers · pboss (SO_REUSEPORT) · pm2: not supported |

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
- **Cluster mode** runs the same matrix for every manager that can
  actually cluster a Bun app: pboss (its native process-based cluster,
  `--instances N`, workers sharing one `SO_REUSEPORT` port). pm2
  **cannot** — its cluster mode is `node:cluster` inside the pm2 daemon and
  cannot wrap an app run with a non-Node interpreter — so it is reported
  as **not supported** in the cluster section, never measured with
  fork-mode numbers wearing a cluster label.

_Winner names the column that scored better; the percentage beside it is the relative difference (pboss − pm2) / pm2 × 100 — positive means pboss scored the higher number. For throughput higher is better; for every other metric in these tables lower is better, and the Winner column already accounts for the direction. A row that is exactly level reads “tie”._

## Fork mode — headline, 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 70233.8 | 72411.3 | pboss (+3.1%) |
| Average latency (mean) | 1.08 ms | 0.90 ms | pboss (-16.7%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Average CPU usage (tree) | 66.9 % | 67.3 % | pm2 (+0.6%) |
| Average memory (tree) | 119.3 MB | 116.8 MB | pboss (-2.1%) |
| Average cold startup | 384.4 ms | 332.6 ms | pboss (-13.5%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 75604.5 | 74185.3 | pm2 (-1.9%) |
| Mean requests/sec | 76586.9 | 74942.0 | pm2 (-2.1%) |
| RPS stdev (variability) | 2759.9 | 2344.4 | pboss (-15.1%) |
| Average latency (mean) | 0.04 ms | 0.04 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 68.6 | 69.3 | pm2 (+0.9%) |
| Median CPU % of tree | 70.0 | 70.0 | tie |
| Peak CPU % of tree | 75.2 | 76.0 | pm2 (+1.1%) |
| Avg tree memory | 119.6 MB | 117.3 MB | pboss (-2.0%) |
| Median tree memory | 119.6 MB | 117.3 MB | pboss (-1.9%) |
| Cold startup (median) | 365.0 ms | 331.0 ms | pboss (-9.3%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [80,769, 77,605, 73,458, 75,605, 75,498] · pboss [76,465, 74,185, 72,259, 73,657, 78,143]_

## Fork mode — load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 68789.3 | 71714.4 | pboss (+4.3%) |
| Mean requests/sec | 70233.8 | 72411.3 | pboss (+3.1%) |
| RPS stdev (variability) | 3275.4 | 2101.5 | pboss (-35.8%) |
| Average latency (mean) | 1.08 ms | 0.90 ms | pboss (-16.7%) |
| Median p50 latency | 1.00 ms | 1.00 ms | tie |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 66.9 | 67.3 | pm2 (+0.6%) |
| Median CPU % of tree | 68.0 | 68.0 | tie |
| Peak CPU % of tree | 74.0 | 72.4 | pboss (-2.2%) |
| Avg tree memory | 119.3 MB | 116.8 MB | pboss (-2.1%) |
| Median tree memory | 119.3 MB | 116.9 MB | pboss (-2.1%) |
| Cold startup (median) | 380.0 ms | 331.0 ms | pboss (-12.9%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [68,207, 68,514, 68,789, 69,645, 76,014] · pboss [71,103, 75,572, 71,714, 70,283, 73,384]_

## Fork mode — load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 65634.7 | 63283.5 | pm2 (-3.6%) |
| Mean requests/sec | 65440.0 | 64514.2 | pm2 (-1.4%) |
| RPS stdev (variability) | 1810.0 | 3079.9 | pm2 (+70.2%) |
| Average latency (mean) | 7.18 ms | 7.47 ms | pm2 (+4.0%) |
| Median p50 latency | 5.00 ms | 6.00 ms | pm2 (+20.0%) |
| Median p90 latency | 8.00 ms | 8.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 33.00 ms | 33.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 64.1 | 64.0 | pboss (-0.2%) |
| Median CPU % of tree | 64.4 | 64.4 | tie |
| Peak CPU % of tree | 76.0 | 70.8 | pboss (-6.8%) |
| Avg tree memory | 119.5 MB | 117.2 MB | pboss (-1.9%) |
| Median tree memory | 119.5 MB | 117.2 MB | pboss (-1.9%) |
| Cold startup (median) | 375.0 ms | 335.0 ms | pboss (-10.7%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [67,463, 66,615, 64,702, 65,635, 62,785] · pboss [62,392, 62,539, 64,550, 69,807, 63,283]_

## Cluster mode — 2 workers

pboss supervises N Bun workers of the same `server.ts`, all binding the
same port through `SO_REUSEPORT` (the kernel balances connections across
them) — its native process-based cluster, `--instances N`.

> **pm2: cluster mode — not supported (Bun apps).** PM2's cluster mode is
> implemented with `node:cluster` inside its Node daemon: `cluster.fork()`
> always runs the daemon's own runtime and ignores `--interpreter`, and pm2
> only selects cluster mode when the interpreter path contains "node" — so
> `pm2 start -i N --interpreter bun` silently runs the instances in **fork
> mode** (`exec_mode: fork_mode`, N plain processes, no port sharing), and
> forcing `exec_mode: "cluster_mode"` runs the workers under **Node**, not
> Bun. Rather than publish fork-mode numbers under a cluster label, this
> benchmark records pm2 as not supported and measures only pboss in this
> mode. (The `node` suite in this repo runs both managers' cluster modes.)

### Cluster headline — 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | — | 69856.5 | — |
| Average latency (mean) | — | 0.95 ms | — |
| Median p50 latency | — | 1.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 25.00 ms | — |
| Average CPU usage (tree) | — | 70.0 % | — |
| Average memory (tree) | — | 164.7 MB | — |
| Average cold startup | — | 460.0 ms | — |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | — | 68210.4 | — |
| Mean requests/sec | — | 68867.2 | — |
| RPS stdev (variability) | — | 2738.8 | — |
| Average latency (mean) | — | 0.05 ms | — |
| Median p50 latency | — | 0.00 ms | — |
| Median p90 latency | — | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 0.00 ms | — |
| Errors (total) | — | 0 | — |
| Timeouts (total) | — | 0 | — |
| Non-2xx (total) | — | 0 | — |
| Avg CPU % of tree | — | 73.2 | — |
| Median CPU % of tree | — | 74.0 | — |
| Peak CPU % of tree | — | 83.2 | — |
| Avg tree memory | — | 165.4 MB | — |
| Median tree memory | — | 165.5 MB | — |
| Cold startup (median) | — | 462.0 ms | — |

_Runs: 0 pm2 / 5 pboss. RPS per run: pm2 [] · pboss [72,873, 65,541, 67,748, 68,210, 69,964]_

### Cluster load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | — | 70108.0 | — |
| Mean requests/sec | — | 69856.5 | — |
| RPS stdev (variability) | — | 4438.2 | — |
| Average latency (mean) | — | 0.95 ms | — |
| Median p50 latency | — | 1.00 ms | — |
| Median p90 latency | — | 1.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 25.00 ms | — |
| Errors (total) | — | 0 | — |
| Timeouts (total) | — | 0 | — |
| Non-2xx (total) | — | 0 | — |
| Avg CPU % of tree | — | 70.0 | — |
| Median CPU % of tree | — | 70.4 | — |
| Peak CPU % of tree | — | 77.6 | — |
| Avg tree memory | — | 164.7 MB | — |
| Median tree memory | — | 164.7 MB | — |
| Cold startup (median) | — | 459.0 ms | — |

_Runs: 0 pm2 / 5 pboss. RPS per run: pm2 [] · pboss [70,108, 65,862, 66,146, 70,325, 76,841]_

### Cluster load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | — | 62368.5 | — |
| Mean requests/sec | — | 62988.0 | — |
| RPS stdev (variability) | — | 2637.1 | — |
| Average latency (mean) | — | 7.58 ms | — |
| Median p50 latency | — | 6.00 ms | — |
| Median p90 latency | — | 9.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 34.00 ms | — |
| Errors (total) | — | 0 | — |
| Timeouts (total) | — | 0 | — |
| Non-2xx (total) | — | 0 | — |
| Avg CPU % of tree | — | 66.0 | — |
| Median CPU % of tree | — | 66.4 | — |
| Peak CPU % of tree | — | 77.6 | — |
| Avg tree memory | — | 164.8 MB | — |
| Median tree memory | — | 164.8 MB | — |
| Cold startup (median) | — | 456.0 ms | — |

_Runs: 0 pm2 / 5 pboss. RPS per run: pm2 [] · pboss [63,335, 67,314, 60,527, 61,395, 62,369]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 375.0 ms | 331.0 ms | pboss (-11.7%) |
| Warm startup, fork (median) | 166.0 ms | 114.0 ms | pboss (-31.3%) |
| Warm startup, fork (max) | 200.0 ms | 177.0 ms | pboss (-11.5%) |
| Cold startup, cluster (median of medians) | — | 459.0 ms | — |
| Warm startup, cluster (median) | — | 172.0 ms | — |
| Warm startup, cluster (max) | — | 296.0 ms | — |


## Idle daemon overhead (no application running)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 68.9 MB | 64.5 MB | pboss (-6.3%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 68.9 ms | 66.9 ms | pboss (-2.9%) |
| Recovery (median) | 68.0 ms | 67.0 ms | pboss (-1.5%) |
| Recovery (max) | 74.0 ms | 68.0 ms | pboss (-8.1%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | — | 82.5 ms | — |
| Worker respawn (median) | — | 82.5 ms | — |
| Worker respawn (max) | — | 86.0 ms | — |
| Failed replacements | — | 0 | — |
| Health stayed up | — | 100.0 % of kills | — |


## Restart storm — fork

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 257.5 ms | 122.0 ms | pboss (-52.6%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 35.3 MB | 35.2 MB | pboss (-0.4%) |
| App RSS after | 35.2 MB | 35.1 MB | pboss (-0.2%) |
| Memory growth (after − before) | -0.1 MB | -0.1 MB | — |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | — | 50 | — |
| Restart time (median) | — | 178.5 ms | — |
| Failed restarts | — | 0 | — |
| Orphaned processes after | — | 0 | — |
| Workers' RSS before | — | 73.8 MB | — |
| Workers' RSS after | — | 73.6 MB | — |
| Memory growth (after − before) | — | -0.2 MB | — |


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
