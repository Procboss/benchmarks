/**
 * pboss-vs-pup Deno benchmark — the ONE application both managers run.
 *
 * Deliberately minimal: the benchmark measures the OVERHEAD OF MANAGING a
 * Deno HTTP server (process supervision, spawn route, daemon cost), not
 * Deno's raw HTTP performance and not application logic. No framework, no
 * database, no middleware — one route returning a fixed body and one
 * /health route.
 *
 * Both process managers launch this exact file with the same Deno binary:
 *
 *   pboss start server.ts --interpreter $DENO_BIN --permissions allow-net,allow-env
 *   pup    config      cmd: "$DENO_BIN run --allow-net --allow-env …/server.ts"
 *
 * CLUSTER MODE — the same file, N workers instead of one, and for Deno apps
 * BOTH managers cluster, but with different native models (each manager's
 * own honest mechanism; the harness measures the port the CLIENT sees):
 *
 *   pboss --instances N (its native process-based cluster: every worker
 *                       binds the SAME port through SO_REUSEPORT — the
 *                       kernel balances connections across them)
 *   pup  cluster { instances: N, commonPort: P, startPort: S }
 *                      (pup runs a load balancer on P inside the instance
 *                       and one backend per worker on S+i; each backend
 *                       reads its port from PUP_CLUSTER_PORT)
 *
 * The single listen line below serves all three shapes — fork (PORT),
 * pboss reuseport cluster (PORT on every worker) and pup load-balanced
 * cluster (PUP_CLUSTER_PORT, exactly what pup injects per backend). No
 * mode branches, no manager names, no env sniffing — the application
 * cannot tell who supervises it.
 *
 * Port comes from PUP_CLUSTER_PORT (pup cluster backends), then PORT,
 * 3000 default.
 */

const port = Number(Deno.env.get("PUP_CLUSTER_PORT") ?? Deno.env.get("PORT") ?? 3000);

Deno.serve(
  { port },
  (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Hello from Deno!");
  },
);
