# pboss vs pm2 — managing a Bun HTTP server

The same `server.ts`, the same Bun executable, the same machine, the same
load — the only difference is which process manager supervises it. This
measures the **overhead of managing** a Bun server, not Bun's raw HTTP
performance. Both supervision models are covered: **fork** (one managed
process) and **cluster** (N workers sharing one port).

_An HTML version of this summary lives beside it: `results/REPORT.html`._

| Environment |  |
| --- | --- |
| Date | 2026-10-11T02:07:32.313Z |
| OS | Linux — kernel 5.10.134-013.15.kangaroo.al8.x86_64 |
| CPU | 2 × Intel(R) Xeon(R) Processor |
| Memory | 4041 MB |
| Versions | bun 1.3.14 · node v24.21.0 · pm2 5.4.3 · pboss pboss v1.8.0 |
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
| Average requests/sec | 73892.0 | 72138.8 | pm2 (-2.4%) |
| Average latency (mean) | 0.70 ms | 0.84 ms | pm2 (+20.0%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Average CPU usage (tree) | 67.0 % | 66.9 % | pboss (-0.1%) |
| Average memory (tree) | 119.5 MB | 117.9 MB | pboss (-1.3%) |
| Average cold startup | 389.2 ms | 338.2 ms | pboss (-13.1%) |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

## Fork mode — load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 77945.9 | 79963.7 | pboss (+2.6%) |
| Mean requests/sec | 77483.8 | 80862.3 | pboss (+4.4%) |
| RPS stdev (variability) | 1071.5 | 3180.8 | pm2 (+196.9%) |
| Average latency (mean) | 0.04 ms | 0.04 ms | tie |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 0.00 ms | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | 0.00 ms | 0.00 ms | — |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 69.1 | 69.4 | pm2 (+0.4%) |
| Median CPU % of tree | 70.0 | 70.0 | tie |
| Peak CPU % of tree | 73.6 | 75.2 | pm2 (+2.2%) |
| Avg tree memory | 119.8 MB | 117.7 MB | pboss (-1.7%) |
| Median tree memory | 119.8 MB | 117.7 MB | pboss (-1.7%) |
| Cold startup (median) | 384.0 ms | 337.0 ms | pboss (-12.2%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [77,516, 77,946, 77,988, 75,638, 78,331] · pboss [79,414, 85,889, 81,609, 77,436, 79,964]_

## Fork mode — load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 74125.6 | 72798.1 | pm2 (-1.8%) |
| Mean requests/sec | 73892.0 | 72138.8 | pm2 (-2.4%) |
| RPS stdev (variability) | 2935.3 | 1123.5 | pboss (-61.7%) |
| Average latency (mean) | 0.70 ms | 0.84 ms | pm2 (+20.0%) |
| Median p50 latency | 0.00 ms | 0.00 ms | — |
| Median p90 latency | 1.00 ms | 1.00 ms | tie |
| Median p95 latency | — | — | — |
| Median p99 latency | 25.00 ms | 25.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 67.0 | 66.9 | pboss (-0.1%) |
| Median CPU % of tree | 68.0 | 67.6 | pboss (-0.6%) |
| Peak CPU % of tree | 71.2 | 71.6 | pm2 (+0.6%) |
| Avg tree memory | 119.5 MB | 117.9 MB | pboss (-1.3%) |
| Median tree memory | 119.5 MB | 117.9 MB | pboss (-1.3%) |
| Cold startup (median) | 392.0 ms | 339.0 ms | pboss (-13.5%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [76,194, 72,122, 74,126, 69,926, 77,093] · pboss [72,798, 71,441, 70,496, 72,901, 73,058]_

## Fork mode — load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | 65352.0 | 64368.3 | pm2 (-1.5%) |
| Mean requests/sec | 65326.3 | 64242.0 | pm2 (-1.7%) |
| RPS stdev (variability) | 1741.1 | 777.7 | pboss (-55.3%) |
| Average latency (mean) | 7.16 ms | 7.26 ms | pm2 (+1.4%) |
| Median p50 latency | 5.00 ms | 5.00 ms | tie |
| Median p90 latency | 7.00 ms | 8.00 ms | pm2 (+14.3%) |
| Median p95 latency | — | — | — |
| Median p99 latency | 33.00 ms | 33.00 ms | tie |
| Errors (total) | 0 | 0 | — |
| Timeouts (total) | 0 | 0 | — |
| Non-2xx (total) | 0 | 0 | — |
| Avg CPU % of tree | 63.9 | 63.4 | pboss (-0.8%) |
| Median CPU % of tree | 64.0 | 63.6 | pboss (-0.6%) |
| Peak CPU % of tree | 71.6 | 70.4 | pboss (-1.7%) |
| Avg tree memory | 120.5 MB | 117.5 MB | pboss (-2.5%) |
| Median tree memory | 120.5 MB | 117.5 MB | pboss (-2.5%) |
| Cold startup (median) | 385.0 ms | 335.0 ms | pboss (-13.0%) |

_Runs: 5 pm2 / 5 pboss. RPS per run: pm2 [63,358, 66,995, 65,352, 63,816, 67,110] · pboss [64,934, 64,801, 62,977, 64,130, 64,368]_

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
| Average requests/sec | — | 73203.8 | — |
| Average latency (mean) | — | 0.78 ms | — |
| Median p50 latency | — | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 25.00 ms | — |
| Average CPU usage (tree) | — | 70.2 % | — |
| Average memory (tree) | — | 165.3 MB | — |
| Average cold startup | — | 458.6 ms | — |

_Autocannon percentiles are integer-ms: a sub-millisecond p50 shows as
0.00 — read the average-latency row for sub-ms precision, and p99 for
tail behavior._

### Cluster load: 10 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | — | 71479.2 | — |
| Mean requests/sec | — | 72225.7 | — |
| RPS stdev (variability) | — | 3256.4 | — |
| Average latency (mean) | — | 0.04 ms | — |
| Median p50 latency | — | 0.00 ms | — |
| Median p90 latency | — | 0.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 0.00 ms | — |
| Errors (total) | — | 0 | — |
| Timeouts (total) | — | 0 | — |
| Non-2xx (total) | — | 0 | — |
| Avg CPU % of tree | — | 73.1 | — |
| Median CPU % of tree | — | 74.0 | — |
| Peak CPU % of tree | — | 81.6 | — |
| Avg tree memory | — | 166.2 MB | — |
| Median tree memory | — | 166.3 MB | — |
| Cold startup (median) | — | 467.0 ms | — |

_Runs: 0 pm2 / 5 pboss. RPS per run: pm2 [] · pboss [71,479, 75,712, 70,028, 68,439, 75,471]_

### Cluster load: 100 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | — | 72748.0 | — |
| Mean requests/sec | — | 73203.8 | — |
| RPS stdev (variability) | — | 1685.8 | — |
| Average latency (mean) | — | 0.78 ms | — |
| Median p50 latency | — | 0.00 ms | — |
| Median p90 latency | — | 1.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 25.00 ms | — |
| Errors (total) | — | 0 | — |
| Timeouts (total) | — | 0 | — |
| Non-2xx (total) | — | 0 | — |
| Avg CPU % of tree | — | 70.2 | — |
| Median CPU % of tree | — | 70.8 | — |
| Peak CPU % of tree | — | 81.6 | — |
| Avg tree memory | — | 165.3 MB | — |
| Median tree memory | — | 165.3 MB | — |
| Cold startup (median) | — | 458.0 ms | — |

_Runs: 0 pm2 / 5 pboss. RPS per run: pm2 [] · pboss [75,185, 72,748, 74,526, 70,933, 72,627]_

### Cluster load: 500 connections

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median requests/sec | — | 66690.7 | — |
| Mean requests/sec | — | 66007.1 | — |
| RPS stdev (variability) | — | 3118.5 | — |
| Average latency (mean) | — | 6.95 ms | — |
| Median p50 latency | — | 5.00 ms | — |
| Median p90 latency | — | 8.00 ms | — |
| Median p95 latency | — | — | — |
| Median p99 latency | — | 33.00 ms | — |
| Errors (total) | — | 0 | — |
| Timeouts (total) | — | 0 | — |
| Non-2xx (total) | — | 0 | — |
| Avg CPU % of tree | — | 66.2 | — |
| Median CPU % of tree | — | 66.8 | — |
| Peak CPU % of tree | — | 74.4 | — |
| Avg tree memory | — | 166.0 MB | — |
| Median tree memory | — | 166.0 MB | — |
| Cold startup (median) | — | 458.0 ms | — |

_Runs: 0 pm2 / 5 pboss. RPS per run: pm2 [] · pboss [69,645, 62,169, 68,041, 66,691, 63,491]_

## Startup time

Cold = daemon down, start command → first 200 from `/health` (daemon boot
included; median over the load runs). Warm = daemon already up.

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Cold startup, fork (median of medians) | 385.0 ms | 337.0 ms | pboss (-12.5%) |
| Warm startup, fork (median) | 192.0 ms | 117.0 ms | pboss (-39.1%) |
| Warm startup, fork (max) | 206.0 ms | 127.0 ms | pboss (-38.3%) |
| Cold startup, cluster (median of medians) | — | 458.0 ms | — |
| Warm startup, cluster (median) | — | 158.0 ms | — |
| Warm startup, cluster (max) | — | 282.0 ms | — |


## Idle daemon overhead (no application running)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Median CPU % | 0.0 | 0.0 | — |
| Median memory | 66.3 MB | 63.7 MB | pboss (-4.0%) |


## Crash recovery — fork (SIGKILL the server → `/health` back to 200)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Recovery (mean) | 67.3 ms | 65.9 ms | pboss (-2.1%) |
| Recovery (median) | 66.5 ms | 66.0 ms | pboss (-0.8%) |
| Recovery (max) | 74.0 ms | 66.0 ms | pboss (-10.8%) |
| Failed recoveries | 0 | 0 | — |


## Crash recovery — cluster (SIGKILL one worker of 2)

One worker is SIGKILLed; the survivors keep the shared port up. The
numbers are the manager's worker **replacement time** and whether
`/health` ever stopped answering (it should not, with workers left).

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Worker respawn (mean) | — | 81.3 ms | — |
| Worker respawn (median) | — | 81.5 ms | — |
| Worker respawn (max) | — | 85.0 ms | — |
| Failed replacements | — | 0 | — |
| Health stayed up | — | 100.0 % of kills | — |


## Restart storm — fork

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | 50 | 50 | tie |
| Restart time (median) | 255.0 ms | 129.0 ms | pboss (-49.4%) |
| Failed restarts | 0 | 0 | — |
| Orphaned processes after | 0 | 0 | — |
| App RSS before | 35.3 MB | 35.3 MB | pboss (-0.1%) |
| App RSS after | 35.3 MB | 35.2 MB | pboss (-0.4%) |
| Memory growth (after − before) | 0.0 MB | -0.1 MB | — |


## Restart storm — cluster (restart must bring back ALL workers)

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Restarts attempted | — | 50 | — |
| Restart time (median) | — | 178.0 ms | — |
| Failed restarts | — | 0 | — |
| Orphaned processes after | — | 0 | — |
| Workers' RSS before | — | 73.8 MB | — |
| Workers' RSS after | — | 73.7 MB | — |
| Memory growth (after − before) | — | -0.1 MB | — |


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
