# ProcBoss benchmarks

Reproducible benchmark suites comparing **pboss** with the field, on real
machines, with every raw number committed alongside the code that produced
it.

## Suites

| Suite | What it measures | Status |
|---|---|---|
| [`benchmarks/bun`](benchmarks/bun) | pboss vs **pm2** managing the same Bun HTTP server, in **fork AND cluster mode** (N workers, one `SO_REUSEPORT` port): throughput, latency percentiles, CPU/memory of the whole process tree, cold & warm startup, idle daemon overhead, SIGKILL crash recovery (fork: server respawn · cluster: worker respawn + availability), and a 50-restart storm | [results](benchmarks/bun/results/REPORT.md) · [HTML](benchmarks/bun/results/REPORT.html) |

More runtimes and competitors will land as sibling folders
(`benchmarks/<runtime>`), each self-contained with its own scripts, tests,
and `results/`.

## Principles

- **Same application, same runtime, same machine, same load.** The only
  difference between the two columns of any table is which process manager
  supervises the workload. This measures the *overhead of managing*, not the
  raw performance of the runtime underneath. Cluster comparisons keep the
  worker count and the port-sharing mechanism identical too.
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
cd benchmarks/bun
npm install            # the suite's tools (autocannon, pm2) — pinned locally
BENCH_PROFILE=smoke bash scripts/benchmark.sh   # verify the harness fast
bash scripts/benchmark.sh                       # the standard profile
```

Every profile runs the full matrix in both fork and cluster mode
(`BENCH_INSTANCES` workers, default one per core). Each suite's README
documents its profiles, environment variables, and how to point it at a pboss
repo checkout instead of an installed CLI.
