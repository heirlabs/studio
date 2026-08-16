import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createApp } from "../../server/app.js";
import { loadOrCreateToken } from "../../server/lib/remote.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const FAKE_GROK = path.join(ROOT, "test/fixtures/fake-grok.mjs");

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

/** Wait until no run is active, so the concurrency cap does not reject us. */
async function waitForIdle(base, token, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (!body.activeRuns) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("runs did not drain");
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * `trustLoopback: false` is the tunnel-fronted deployment mode: every request,
 * including one from 127.0.0.1, must present the bearer token. It is also the
 * only way to exercise the remote code path without a second network address.
 */
describe("authenticated remote access", () => {
  let tmp;
  let ctx;
  let token;
  let wrapper;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-remote-"));
    const data = path.join(tmp, "data");
    for (const d of ["uploads", "outputs", "runs"]) {
      fs.mkdirSync(path.join(data, d), { recursive: true });
    }
    wrapper = path.join(tmp, "wrap.sh");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GROK}" "$@"\n`,
    );
    fs.chmodSync(wrapper, 0o755);

    token = loadOrCreateToken(data).token;

    const app = createApp({
      root: ROOT,
      data,
      catalogPath: path.join(ROOT, "workflows/catalog.json"),
      publicDir: path.join(ROOT, "public"),
      grokBin: wrapper,
      sessionsRoot: path.join(data, "sessions"),
      settingsHome: data,
      remoteEnabled: true,
      trustLoopback: false,
      log: silentLog(),
    });
    ctx = await listen(app);
    ctx.data = data;
  });

  after(async () => {
    await new Promise((r) => ctx.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const auth = (extra = {}) => ({
    headers: {
      Authorization: `Bearer ${token}`,
      // Stand-in for cloudflared so loopback+token is treated as remote.
      "cf-ray": "test-tunnel",
      ...extra,
    },
  });

  it("rejects a request with no token", async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Missing bearer token/);
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${ctx.base}/api/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  it("rejects a non-bearer scheme", async () => {
    const res = await fetch(`${ctx.base}/api/health`, {
      headers: { Authorization: `Basic ${token}` },
    });
    assert.equal(res.status, 401);
  });

  it("accepts the correct token", async () => {
    const res = await fetch(`${ctx.base}/api/health`, auth());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.localOnly, true);
  });

  it("fans session and run events to every /api/events subscriber", async () => {
    const ac = new AbortController();
    const res = await fetch(`${ctx.base}/api/events`, {
      ...auth(),
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);

    const seen = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const consume = (async () => {
      let buf = "";
      while (seen.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const block of buf.split("\n\n")) {
          if (block.startsWith("data: ")) {
            try {
              seen.push(JSON.parse(block.slice(6)));
            } catch {
              /* ignore */
            }
          }
        }
      }
    })();

    const created = await fetch(`${ctx.base}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cwd: ROOT, title: "hub-test" }),
    });
    assert.equal(created.status, 201);

    await Promise.race([
      consume,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hub timeout")), 3000)),
    ]).catch(() => {});
    ac.abort();

    assert.ok(seen.some((e) => e.type === "hello"));
    assert.ok(
      seen.some((e) => e.type === "session" && e.event === "created"),
      `expected session.created, got ${JSON.stringify(seen)}`,
    );
  });

  it("lists Mac directories for project picking", async () => {
    const res = await fetch(
      `${ctx.base}/api/fs?path=${encodeURIComponent(ROOT)}`,
      auth(),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, ROOT);
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.entries.every((e) => e.type === "dir"));
    assert.ok(
      body.entries.some((e) => e.name === "server"),
      "should see the server/ folder",
    );
    assert.equal((await fetch(`${ctx.base}/api/fs?path=${encodeURIComponent(ROOT)}`)).status, 401);
  });

  it("protects static assets too, not just the API", async () => {
    assert.equal((await fetch(`${ctx.base}/`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/app.js`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/`, auth())).status, 200);
  });

  it("never serves the pairing token to a remote client", async () => {
    const res = await fetch(`${ctx.base}/api/remote/pairing`, auth());
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /this Mac only/);
    // and rotation is equally off-limits
    const rot = await fetch(`${ctx.base}/api/remote/rotate`, {
      method: "POST",
      ...auth(),
    });
    assert.equal(rot.status, 403);
  });

  it("downgrades a remote bypassPermissions run to an approving mode", async () => {
    const res = await fetch(`${ctx.base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "hello from the phone",
        cwd: ROOT,
        permissionMode: "bypassPermissions",
        interactive: false,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.permissionDowngradedFrom, "bypassPermissions");
    assert.equal(body.meta.permissionMode, "default");
  });

  it("downgrades when the run merely inherits the local bypass default", async () => {
    fs.writeFileSync(
      path.join(ctx.data, "settings.local.json"),
      JSON.stringify({ permissionMode: "bypassPermissions" }),
    );
    const res = await fetch(`${ctx.base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "inherit the default",
        cwd: ROOT,
        interactive: false,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.meta.permissionMode, "default");
    fs.rmSync(path.join(ctx.data, "settings.local.json"), { force: true });
  });

  it("still allows bypass when the client explicitly opts in", async () => {
    const res = await fetch(`${ctx.base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "I really mean it",
        cwd: ROOT,
        permissionMode: "bypassPermissions",
        allowBypassPermissions: true,
        interactive: false,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.meta.permissionMode, "bypassPermissions");
    assert.equal(body.permissionDowngradedFrom, null);
  });

  it("streams run events to an authenticated remote client", async () => {
    // Earlier cases start runs without awaiting them; drain first so this one
    // is not rejected by the concurrency cap.
    await waitForIdle(ctx.base, token);
    const start = await fetch(`${ctx.base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "stream to my phone",
        cwd: ROOT,
        permissionMode: "bypassPermissions",
        allowBypassPermissions: true,
        interactive: false,
      }),
    });
    const startBody = await start.json();
    assert.equal(start.status, 201, JSON.stringify(startBody));
    const { id } = startBody;

    // Read the SSE stream the way the iOS client does: URLSession-style
    // byte streaming with an Authorization header (EventSource cannot set one).
    const res = await fetch(`${ctx.base}/api/runs/${id}/stream`, auth());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    let buf = "";
    const reader = res.body.getReader();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (value) buf += new TextDecoder().decode(value);
      if (done || buf.includes('"event":"finished"')) break;
    }
    reader.cancel().catch(() => {});
    assert.match(buf, /^data: /m);
    assert.match(buf, /PONG/);
    assert.match(buf, /"event":"finished"/);
  });

  it("rejects an unauthenticated stream subscription", async () => {
    const res = await fetch(`${ctx.base}/api/runs/whatever/stream`);
    assert.equal(res.status, 401);
  });

  it("reports git status for the grok-studio repo", async () => {
    const res = await fetch(
      `${ctx.base}/api/git/status?cwd=${encodeURIComponent(ROOT)}`,
      auth(),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.branch, "string");
    assert.ok(body.branch.length > 0);
    assert.equal(typeof body.dirty, "boolean");
    assert.equal(typeof body.ahead, "number");
    assert.equal(typeof body.behind, "number");
    assert.ok(Array.isArray(body.staged));
    assert.ok(Array.isArray(body.unstaged));
    assert.ok(Array.isArray(body.untracked));
    assert.equal(
      (await fetch(
        `${ctx.base}/api/git/status?cwd=${encodeURIComponent(ROOT)}`,
      )).status,
      401,
    );
  });

  it("returns a git diff for the grok-studio repo", async () => {
    const res = await fetch(
      `${ctx.base}/api/git/diff?cwd=${encodeURIComponent(ROOT)}`,
      auth(),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.text, "string");
  });

  it("lists files and reads a text file on this Mac", async () => {
    const listing = await fetch(
      `${ctx.base}/api/fs?path=${encodeURIComponent(ROOT)}&files=1`,
      auth(),
    );
    assert.equal(listing.status, 200);
    const listed = await listing.json();
    assert.ok(listed.entries.some((e) => e.type === "dir" && e.name === "server"));
    const pkg = listed.entries.find((e) => e.name === "package.json");
    assert.ok(pkg);
    assert.equal(pkg.type, "file");
    assert.ok(pkg.size > 0);

    const file = await fetch(
      `${ctx.base}/api/file?path=${encodeURIComponent(path.join(ROOT, "package.json"))}`,
      auth(),
    );
    assert.equal(file.status, 200);
    const body = await file.json();
    assert.match(body.text, /"name":\s*"heir-studio"/);
    assert.equal(body.truncated, false);
  });

  it("registers and removes an APNs device token", async () => {
    const deviceToken = "ab".repeat(32);
    const created = await fetch(`${ctx.base}/api/device/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: deviceToken }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.ok, true);
    assert.equal(body.device.token, deviceToken);

    const gone = await fetch(`${ctx.base}/api/device/push`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "cf-ray": "test-tunnel",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: deviceToken }),
    });
    assert.equal(gone.status, 200);
    assert.equal((await gone.json()).removed, true);
  });
});

describe("remote access disabled (default posture)", () => {
  let tmp;
  let ctx;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-noremote-"));
    const data = path.join(tmp, "data");
    for (const d of ["uploads", "outputs", "runs"]) {
      fs.mkdirSync(path.join(data, d), { recursive: true });
    }
    const app = createApp({
      root: ROOT,
      data,
      catalogPath: path.join(ROOT, "workflows/catalog.json"),
      publicDir: path.join(ROOT, "public"),
      grokBin: "/bin/echo",
      sessionsRoot: path.join(data, "sessions"),
      settingsHome: data,
      trustLoopback: false, // stand in for a non-loopback client
      log: silentLog(),
    });
    ctx = await listen(app);
  });

  after(async () => {
    await new Promise((r) => ctx.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses remote clients outright when not enabled", async () => {
    const res = await fetch(`${ctx.base}/api/health`, {
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /not enabled/i);
  });

  it("writes no token file when remote access is off", async () => {
    assert.equal(
      fs.existsSync(path.join(tmp, "data", "remote-access.json")),
      false,
    );
  });
});

describe("pairing on this Mac", () => {
  let tmp;
  let ctx;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-pair-"));
    const data = path.join(tmp, "data");
    for (const d of ["uploads", "outputs", "runs"]) {
      fs.mkdirSync(path.join(data, d), { recursive: true });
    }
    const app = createApp({
      root: ROOT,
      data,
      catalogPath: path.join(ROOT, "workflows/catalog.json"),
      publicDir: path.join(ROOT, "public"),
      grokBin: "/bin/echo",
      sessionsRoot: path.join(data, "sessions"),
      settingsHome: data,
      remoteEnabled: true,
      log: silentLog(),
    });
    ctx = await listen(app);
    ctx.data = data;
  });

  after(async () => {
    await new Promise((r) => ctx.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("hands the local UI a token to render as a QR code", async () => {
    const res = await fetch(`${ctx.base}/api/remote/pairing`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.ok(body.token && body.token.length >= 42);
    assert.ok(Array.isArray(body.allowedCidrs));
    assert.ok(body.allowedCidrs.includes("100.64.0.0/10"));
  });

  it("explains what is missing when the phone could not connect yet", async () => {
    const { hints, url, tailnetIp } = await (
      await fetch(`${ctx.base}/api/remote/pairing`)
    ).json();
    assert.ok(Array.isArray(hints));
    if (!tailnetIp) {
      assert.equal(url, null);
      assert.ok(
        hints.some((h) => /Tailscale/i.test(h)),
        `expected a Tailscale hint, got ${JSON.stringify(hints)}`,
      );
    }
  });

  it("rotating replaces the token and says a restart is required", async () => {
    const before = (await (await fetch(`${ctx.base}/api/remote/pairing`)).json())
      .token;
    const res = await fetch(`${ctx.base}/api/remote/rotate`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rotated, true);
    assert.equal(body.restartRequired, true);
    assert.notEqual(body.token, before);
  });
});

describe("brute-force throttling on the tunnelled path", () => {
  let tmp, ctx, token;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-thr-"));
    const data = path.join(tmp, "data");
    for (const d of ["uploads", "outputs", "runs"]) {
      fs.mkdirSync(path.join(data, d), { recursive: true });
    }
    token = loadOrCreateToken(data).token;
    const app = createApp({
      root: ROOT,
      data,
      catalogPath: path.join(ROOT, "workflows/catalog.json"),
      publicDir: path.join(ROOT, "public"),
      grokBin: "/bin/echo",
      sessionsRoot: path.join(data, "sessions"),
      settingsHome: data,
      remoteEnabled: true,
      trustLoopback: false,
      log: silentLog(),
    });
    ctx = await listen(app);
  });

  after(async () => {
    await new Promise((r) => ctx.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("locks out after repeated bad tokens and says when to retry", async () => {
    let sawLockout = false;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${ctx.base}/api/health`, {
        headers: { Authorization: `Bearer wrong-${i}` },
      });
      if (res.status === 429) {
        sawLockout = true;
        assert.ok(Number(res.headers.get("retry-after")) > 0);
        break;
      }
      assert.equal(res.status, 401);
    }
    assert.ok(sawLockout, "expected a 429 lockout after repeated failures");
  });

  it("the lockout applies to a valid token too, until it expires", async () => {
    const res = await fetch(`${ctx.base}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 429, "a locked-out window must not be bypassable");
  });
});

describe("approval conflict is evaluated for the mode a remote run really gets", () => {
  async function health({ remote, cliToml, localMode }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-eff-"));
    const data = path.join(home, "data");
    for (const d of ["uploads", "outputs", "runs"]) {
      fs.mkdirSync(path.join(data, d), { recursive: true });
    }
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(home, ".grok", "config.toml"), cliToml);
    fs.writeFileSync(
      path.join(data, "settings.local.json"),
      JSON.stringify({ permissionMode: localMode }),
    );
    const token = loadOrCreateToken(data).token;
    const app = createApp({
      root: ROOT,
      data,
      catalogPath: path.join(ROOT, "workflows/catalog.json"),
      publicDir: path.join(ROOT, "public"),
      grokBin: "/bin/echo",
      sessionsRoot: path.join(data, "sessions"),
      settingsHome: home,
      remoteEnabled: true,
      trustLoopback: !remote,
      log: silentLog(),
    });
    const local = await listen(app);
    const res = await fetch(`${local.base}/api/health`, {
      headers: remote
        ? { Authorization: `Bearer ${token}`, "cf-ray": "test-tunnel" }
        : {},
    });
    const body = await res.json();
    await new Promise((r) => local.server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
    return body;
  }

  it("warns a remote client even when the Mac's own default is bypass", async () => {
    // Local UI sees no conflict (bypass matches the CLI), but a remote run is
    // downgraded to `default` — which the CLI config will silently override.
    const body = await health({
      remote: true,
      cliToml: 'permission_mode = "always-approve"\n',
      localMode: "bypassPermissions",
    });
    assert.equal(body.approvalConflict.conflict, true);
    assert.match(body.approvalConflict.message, /will not prompt/);
  });

  it("the local UI is not warned for that same configuration", async () => {
    const body = await health({
      remote: false,
      cliToml: 'permission_mode = "always-approve"\n',
      localMode: "bypassPermissions",
    });
    assert.equal(body.approvalConflict.conflict, false);
  });

  it("no warning when the CLI config does not force approval", async () => {
    const body = await health({
      remote: true,
      cliToml: 'permission_mode = "default"\n',
      localMode: "bypassPermissions",
    });
    assert.equal(body.approvalConflict.conflict, false);
  });
});
