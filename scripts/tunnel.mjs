#!/usr/bin/env node
/**
 * Expose Heir Studio to your phone over a Cloudflare Tunnel.
 *
 * The tunnel terminates on this machine, so cloudflared's requests arrive from
 * 127.0.0.1. This script therefore forces `trustLoopback: false` — without it
 * the tunnel would hand the public internet an unauthenticated shell. That is
 * the whole reason this exists as a command instead of a doc snippet.
 *
 *   npm run tunnel
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { startServer } from "../server/start.js";
import { loadOrCreateToken } from "../server/lib/remote.js";
import { resolveTunnelPlan } from "../server/lib/tunnel.js";
import { createLogger } from "../server/lib/logger.js";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(here, "..", ".env.tunnel"));

const log = createLogger("heir-studio-tunnel");
const port = Number(process.env.HEIR_STUDIO_PORT || 3847);

function fail(message, hints = []) {
  console.error(`\n  ✗ ${message}`);
  for (const line of hints) console.error(`    ${line}`);
  console.error("");
  process.exit(1);
}

const certExists = fs.existsSync(
  path.join(os.homedir(), ".cloudflared", "cert.pem"),
);
const plan = resolveTunnelPlan({ env: process.env, certExists, port });
if (plan.error) fail(plan.error, plan.hints);

const handle = await startServer({
  host: "127.0.0.1",
  port,
  remoteEnabled: true,
  // Non-negotiable for this transport — see the header comment.
  trustLoopback: false,
  log,
}).catch((e) =>
  fail(`could not start on port ${port}: ${e.message}`, [
    "Another instance may be running, or set HEIR_STUDIO_PORT.",
  ]),
);

const { token } = loadOrCreateToken(handle.cfg.data);

const cloudflared = spawn("cloudflared", plan.args, {
  stdio: ["ignore", "pipe", "pipe"],
});

// Sleep-proof while this process is up (login item + `npm run tunnel`).
// caffeinate -dims -w is the whole mechanism — do not sudo pmset.
// Closing the lid still sleeps a MacBook; plug in and leave the lid open.
const caffeinate = spawn("caffeinate", ["-dims", "-w", String(process.pid)], {
  stdio: "ignore",
});
caffeinate.on("error", () => {});

cloudflared.on("error", (e) => {
  if (e.code === "ENOENT") fail("cloudflared is not installed.", ["brew install cloudflared"]);
  fail(`cloudflared failed: ${e.message}`);
});

let announced = false;
const onOutput = (chunk) => {
  const text = String(chunk);
  if (!announced && plan.mode === "quick") {
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      announced = true;
      announce(match[0]);
    }
  }
  // A named tunnel has no URL to discover — announce once it is connected.
  if (!announced && plan.url && /Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(text)) {
    announced = true;
    announce(plan.url);
  }
  if (/\bERR\b|error/i.test(text)) process.stderr.write(text);
};
cloudflared.stdout.on("data", onOutput);
cloudflared.stderr.on("data", onOutput);

// If cloudflared is quiet, still announce a known hostname after a moment.
if (plan.url) {
  setTimeout(() => {
    if (!announced) {
      announced = true;
      announce(plan.url);
    }
  }, 8000).unref();
}

function announce(url) {
  const deepLink = `heirstudio://pair?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
  const stable = plan.mode !== "quick";
  console.log(`
  Heir Studio is reachable from your phone.

    URL    ${url}
    Token  ${token}
    Tunnel ${plan.mode}${stable ? " (stable — pair once)" : " (throwaway — changes every restart)"}

  Pair by opening this link on the phone — send it to yourself in Messages or
  Notes and tap it. It pre-fills the fields; you still tap Connect.

    ${deepLink}

  ⚠ This URL is on the public internet. The token is the only thing between it
    and a shell on this Mac. Anyone who gets both is in.
      · Rotate immediately if leaked:  curl -X POST http://127.0.0.1:${handle.port}/api/remote/rotate
      ${stable ? "· A permanent hostname is always reachable. Consider putting Cloudflare\n        Access in front of it for a second factor." : "· Stop the tunnel (Ctrl-C) when you are done."}
`);
}

const shutdown = () => {
  console.log("\n  stopping tunnel…");
  try { caffeinate.kill("SIGTERM"); } catch { /* already gone */ }
  cloudflared.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

cloudflared.on("close", (code) => {
  if (!announced) fail(`cloudflared exited (code ${code}) before connecting.`);
  console.log(`\n  tunnel closed (code ${code})`);
  process.exit(code ?? 0);
});
