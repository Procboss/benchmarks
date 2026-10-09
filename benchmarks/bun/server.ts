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
 *   pm2   start server.ts --interpreter $BUN_BIN
 *   pboss start server.ts --interpreter $BUN_BIN --env PORT=<port>
 *
 * Port comes from PORT (read the way Bun reads env — Bun.env), 3000 default.
 */

const port = Number(Bun.env.PORT ?? 3000);

const server = Bun.serve({
  port,
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

console.log(`Listening on http://localhost:${server.port}`);
