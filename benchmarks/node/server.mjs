/**
 * pboss-vs-pm2 Node benchmark — the ONE application both managers run.
 *
 * Deliberately minimal: the benchmark measures the OVERHEAD OF MANAGING a
 * Node HTTP server (process supervision, spawn route, daemon cost), not
 * Node's raw HTTP performance and not application logic. No framework, no
 * database, no middleware — one route returning a fixed body and one
 * /health route.
 *
 * Both process managers launch this exact file with the same Node binary:
 *
 *   pm2   start server.mjs --interpreter $NODE_BIN   (fork: 1 process)
 *   pboss start server.mjs --interpreter $NODE_BIN   (fork: 1 process)
 *
 * CLUSTER MODE — the same file, N workers instead of one, and for Node apps
 * BOTH managers cluster natively through node:cluster:
 *
 *   pm2   start server.mjs -i N        (the pm2 daemon IS the cluster
 *                                        primary; workers are forked with
 *                                        cluster.fork() and share the port
 *                                        through the primary's listener)
 *   pboss start server.mjs --instances N  (pboss spawns a node:cluster
 *                                        wrapper as the supervised primary,
 *                                        which forks the N workers the same
 *                                        way — pboss's node:cluster mode)
 *
 * In BOTH models this script runs as a WORKER of a node:cluster primary, so
 * the code is the same in every mode: create the server, listen on PORT. In
 * a cluster worker, listen() routes through the primary's shared handle; in
 * fork mode the process owns its listener. No mode branches, no manager
 * names, no env sniffing — the application cannot tell who supervises it.
 *
 * Port comes from PORT (read the way Node reads env — process.env), 3000
 * default.
 */

import http from "node:http";

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Hello from Node!");
});

server.listen(port, () => {
  console.log(`node server up pid=${process.pid} port=${port}`);
});
