import http from "http";
import { createApp } from "./app.js";
import { createLogger } from "./lib/logger.js";

/**
 * Start the local HTTP server. Returns { app, server, cfg, log, url, port }.
 * port 0 → OS assigns an ephemeral port (preferred for the desktop app).
 */
export function startServer(overrides = {}) {
  const log = overrides.log || createLogger();
  const expressApp = createApp({ ...overrides, log });
  const cfg = expressApp.locals.cfg;
  const server = http.createServer(expressApp);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.port;
      const url = `http://${cfg.host}:${port}`;
      log.info(`listening ${url}`);
      log.info(`grok ${cfg.grokBin}`);
      log.info(`workspace ${cfg.root}`);
      resolve({
        app: expressApp,
        server,
        cfg: { ...cfg, port },
        log,
        url,
        port,
        runs: expressApp.locals.runs,
      });
    });
  });
}

export async function stopServer(handle) {
  if (!handle?.server) return;
  const { server, runs, log } = handle;
  for (const [id, state] of runs.active) {
    if (state.proc && !state.proc.killed) {
      log?.info("shutdown.kill_run", { id });
      state.proc.kill("SIGTERM");
    }
  }
  await new Promise((resolve) => server.close(() => resolve()));
}
