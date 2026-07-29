#!/usr/bin/env node
import { startServer, stopServer } from "./start.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger();
let handle = null;
let shuttingDown = false;

async function main() {
  handle = await startServer({ log });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { signal });
  stopServer(handle)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (err) => {
  const message = err && err.message ? err.message : String(err);
  log.error("unhandledRejection", { message });
});

main().catch((err) => {
  log.error("fatal", { message: err.message, stack: err.stack });
  process.exit(1);
});
