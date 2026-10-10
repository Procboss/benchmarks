# ProcBoss benchmarks

Reproducible benchmark suites comparing **pboss** with the field, on real
machines, with every raw number committed alongside the code that produced
it.

## Suites

| Suite | What it measures | Status |
|---|---|---|
| [`benchmarks/bun`](benchmarks/bun) | pboss vs **pm2** managing the same Bun HTTP server, in **fork mode** (both managers) and **cluster mode** — **pboss only**: pm2 cannot cluster a Bun app (`-i N --interpreter bun` silently downgrades to fork mode), so it is recorded as **not supported** there, never measured under a cluster label. pboss clusters with its native `--instances N` (N Bun workers on one `SO_REUSEPORT` port): throughput, latency percentiles, CPU/memory of the whole process tree, cold & warm startup, idle daemon overhead, SIGKILL crash recovery (fork: server respawn · cluster: worker respawn + availability), and a 50-restart storm | [results](benchmarks/bun/results/REPORT.md) · [HTML](benchmarks/bun/results/REPORT.html) |
| [`benchmarks/node`](benchmarks/node) | pboss vs **pm2** managing the same Node HTTP server — the suite where **BOTH managers cluster natively through `node:cluster`** (pm2 `-i N` is true cluster mode with the daemon as primary; pboss `--instances N` spawns its supervised node:cluster wrapper primary), so the full fork + cluster matrix runs for both: the same throughput, latency, CPU/memory, startup, crash-recovery and storm battery as the bun suite | [results](benchmarks/node/results/REPORT.md) · [HTML](benchmarks/node/results/REPORT.html) |

More runtimes and competitors will land as sibling folders
(`benchmarks/<runtime>`), each self-contained with its own scripts, tests,
and `results/`.

## Principles

- **Same application, same runtime, same machine, same load.** The only
  difference between the two columns of any table is which process manager
  supervises the workload. This measures the *overhead of managing*, not the
  raw performance of the runtime underneath. Cluster comparisons keep the
  worker count and the port-sharing mechanism identical too.
- **Cluster mode is only claimed where it genuinely exists.** pm2's cluster
  mode is `node:cluster` inside its daemon — for Node apps it is real and
  measured head-to-head; for Bun apps it cannot wrap a non-Node interpreter
  (the `-i N` flag silently downgrades to fork mode), so the bun suite
  records pm2 as **not supported** in cluster mode instead of publishing
  fork-mode numbers under a cluster label.
- **Never one run.** Repeats with medians and per-run lists, manager order
  alternating between runs.
- **Raw data ships with the repo.** Every number in a report traces to a
  file under that suite's `results/raw/` — autocannon JSON, `/proc` samples,
  event logs.
- **A named winner per row, not a naked sign.** Tables carry a Winner column
  (direction-aware) with the relative difference `(pboss − pm2) / pm2 × 100`
  beside it; level rows read “tie”.
- **Honest caveats.** Same-machine load generation, box-specific absolute
  numbers, and any dropped load levels are stated in the report, not hidden.

## Running a suite

```bash
cd benchmarks/bun        # or benchmarks/node
npm install            # the suite's tools (autocannon, pm2) — pinned locally
BENCH_PROFILE=smoke bash scripts/benchmark.sh   # verify the harness fast
bash scripts/benchmark.sh                       # the standard profile
```

Every profile runs the full matrix in both fork and cluster mode
(`BENCH_INSTANCES` workers, default one per core). Each suite's README
documents its profiles, environment variables, and how to point it at a pboss
repo checkout instead of an installed CLI.
