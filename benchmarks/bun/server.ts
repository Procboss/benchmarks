/**
 * pboss-vs-pm2 Bun benchmark — the ONE application both managers run.
 *
 * Deliberately minimal: the benchmark measures the OVERHEAD OF MANAGING a
 * Bun HTTP server (process supervision, spawn route, daemon cost), not
 * Bun's raw HTTP performance and not application logic. No framework, no
 * database, no middleware — one route returning a fixed body and one
 * /health route.
 *
 * Both process managers launch this exact file with the same Bun executable:
 *
 *   pm2   start server.ts --interpreter $BUN_BIN               (fork: 1 proc)
 *   pboss start server.ts --interpreter $BUN_BIN --env PORT=<p> (fork: 1 proc)
 *
 * CLUSTER MODE — the same file, N worker processes instead of one, pboss
 * only (pm2 cannot cluster a Bun app — the suite records it as not
 * supported and never measures it in this mode). The harness starts it
 * with BENCH_CLUSTER=1 and N instances (pboss --instances N). Every
 * worker is an independent Bun process binding the SAME port through
 * SO_REUSEPORT — reusePort is exactly what makes multi-process Bun
 * serving possible, and it is OFF in fork mode so the single-process
 * behavior (and numbers) is unchanged.
 *
 * Port comes from PORT (read the way Bun reads env — Bun.env), 3000 default.
 */

const port = Number(Bun.env.PORT ?? 3000);

// Cluster mode is declared by the harness (BENCH_CLUSTER=1), never read
// from a manager's own markers — one flag, one behavior, whoever the
// manager is (pboss sets PBOSS_CLUSTER on its workers too; the app
// doesn't care — the same file serves fork mode unchanged with it off).
const cluster = Bun.env.BENCH_CLUSTER === "1";

const server = Bun.serve({
  port,
  // The one cluster-mode difference: N processes share the port (Linux
  // SO_REUSEPORT; the kernel load-balances new connections across them).
  reusePort: cluster,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    return new Response("Hello from Bun!", {
      headers: { "content-type": "text/plain" },
    });
  },
});

const workerId = Bun.env.PBOSS_WORKER_ID ?? Bun.env.NODE_APP_INSTANCE ?? "0";
console.log(
  `Listening on http://localhost:${server.port}${cluster ? ` (cluster worker ${workerId})` : ""}`,
);
