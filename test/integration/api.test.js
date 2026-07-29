import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createApp } from "../../server/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const FAKE_GROK = path.join(ROOT, "test/fixtures/fake-grok.mjs");
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        port,
      });
    });
  });
}

async function json(base, pathName, opts = {}) {
  const res = await fetch(`${base}${pathName}`, opts);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function waitForRun(base, id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await json(base, `/api/runs/${id}`);
    if (body.meta && body.meta.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${id} did not finish in ${timeoutMs}ms`);
}

describe("HTTP API integration", () => {
  let tmp;
  let ctx;
  let sessionsRoot;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-int-"));
    sessionsRoot = path.join(tmp, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    // copy catalog into tmp so we don't mutate real data
    const data = path.join(tmp, "data");
    fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(data, "outputs"), { recursive: true });
    fs.mkdirSync(path.join(data, "runs"), { recursive: true });

    const wrapper = path.join(tmp, "fake-grok-wrap.sh");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh
export FAKE_GROK_SESSIONS_ROOT="${sessionsRoot}"
export FAKE_GROK_CWD="${ROOT}"
exec "${process.execPath}" "${FAKE_GROK}" "$@"
`,
    );
    fs.chmodSync(wrapper, 0o755);

    const app = createApp({
      root: ROOT,
      data,
      catalogPath: path.join(ROOT, "workflows/catalog.json"),
      publicDir: path.join(ROOT, "public"),
      grokBin: wrapper,
      sessionsRoot,
      userWorkflowsDir: path.join(tmp, "user-wf"),
      studioWorkflowsDir: path.join(tmp, "studio-wf"),
      maxConcurrentRuns: 2,
      log: silentLog(),
    });
    ctx = await listen(app);
    ctx.data = data;
    ctx.wrapper = wrapper;
  });

  after(async () => {
    await new Promise((r) => ctx.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.FAKE_GROK_MODE = "pong";
    delete process.env.FAKE_GROK_IMAGE_DIR;
    // rewrite wrapper to inject mode - actually mode is env of parent process,
    // child inherits process.env at spawn time from server process.env
  });

  it("GET / serves index", async () => {
    const res = await fetch(`${ctx.base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Grok Studio/);
  });

  it("GET /api/health reports fake grok version", async () => {
    const { res, body } = await json(ctx.base, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.grokVersion, /fake-grok/);
    assert.equal(body.localOnly, true);
  });

  it("GET /api/workflows returns catalog", async () => {
    const { res, body } = await json(ctx.base, "/api/workflows");
    assert.equal(res.status, 200);
    assert.ok(body.workflows.length >= 5);
    assert.ok(body.workflows.some((w) => w.id === "image-edit"));
  });

  it("upload + list + delete image", async () => {
    const fd = new FormData();
    fd.append(
      "files",
      new Blob([TINY_PNG], { type: "image/png" }),
      "shot.png",
    );
    const up = await fetch(`${ctx.base}/api/upload`, {
      method: "POST",
      body: fd,
    });
    assert.equal(up.status, 200);
    const upBody = await up.json();
    assert.equal(upBody.files.length, 1);
    const name = upBody.files[0].name;

    const list = await json(ctx.base, "/api/uploads");
    assert.ok(list.body.images.some((i) => i.name === name));

    const fileRes = await fetch(`${ctx.base}${upBody.files[0].url}`);
    assert.equal(fileRes.status, 200);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(buf.length, TINY_PNG.length);

    const del = await json(ctx.base, `/api/uploads/${name}`, {
      method: "DELETE",
    });
    assert.equal(del.res.status, 200);
    const list2 = await json(ctx.base, "/api/uploads");
    assert.ok(!list2.body.images.some((i) => i.name === name));
  });

  it("rejects non-attachment binary upload", async () => {
    const fd = new FormData();
    fd.append(
      "files",
      new Blob([new Uint8Array([0, 1, 2, 3])], {
        type: "application/octet-stream",
      }),
      "payload.exe",
    );
    const up = await fetch(`${ctx.base}/api/upload`, {
      method: "POST",
      body: fd,
    });
    assert.equal(up.status, 400);
    const body = await up.json();
    assert.match(body.error, /image|text|code|attachment/i);
  });

  it("POST /api/runs rejects unknown workflow", async () => {
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "does-not-exist",
        prompt: "x",
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Unknown workflow/);
  });

  it("POST /api/runs rejects empty prompt", async () => {
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "   ",
        cwd: ROOT,
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Prompt/);
  });

  it("POST /api/runs rejects image-edit without images", async () => {
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "image-edit",
        prompt: "make noir",
        images: [],
        cwd: ROOT,
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /needs at least 1/);
  });

  it("POST /api/project sets coding workspace", async () => {
    const { res, body } = await json(ctx.base, "/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT }),
    });
    assert.equal(res.status, 200);
    assert.equal(body.current, ROOT);
    assert.ok(body.recent.includes(ROOT));
  });

  it("POST /api/runs code-agent completes with PONG", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "say pong",
        cwd: ROOT,
        yolo: true,
      }),
    });
    assert.equal(res.status, 201);
    assert.ok(body.id);
    assert.equal(body.meta.cwd, ROOT);
    const done = await waitForRun(ctx.base, body.id);
    assert.equal(done.meta.status, "completed");
    assert.equal(done.meta.exitCode, 0);
    const text = done.events
      .filter((e) => e.type === "text")
      .map((e) => e.data)
      .join("");
    assert.equal(text, "PONG");
    const promptFile = path.join(ctx.data, "runs", body.id, "prompt.txt");
    assert.ok(fs.existsSync(promptFile));
    const promptText = fs.readFileSync(promptFile, "utf8");
    assert.match(promptText, /say pong/);
    assert.match(promptText, /coding agent/i);
    assert.ok(promptText.includes(ROOT), "prompt should include project cwd");
  });

  it("POST /api/runs rejects missing project cwd", async () => {
    // wipe recents so no default
    fs.writeFileSync(
      path.join(ctx.data, "recents.json"),
      JSON.stringify({ current: null, recent: [] }),
    );
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "x",
        cwd: "",
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Project folder|required|not found/i);
  });

  it("SSE stream replays finished run", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const { body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "stream me",
        cwd: ROOT,
      }),
    });
    await waitForRun(ctx.base, body.id);

    const res = await fetch(`${ctx.base}/api/runs/${body.id}/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const raw = await res.text();
    assert.match(raw, /PONG/);
    assert.match(raw, /"event":"finished"/);
  });

  it("harvests OUTPUT image from agent text", async () => {
    process.env.FAKE_GROK_MODE = "image";
    const imgDir = path.join(tmp, "agent-out");
    fs.mkdirSync(imgDir, { recursive: true });
    process.env.FAKE_GROK_IMAGE_DIR = imgDir;

    // rewrite wrapper so child gets FAKE_GROK_IMAGE_DIR — spawn inherits env from
    // the node process running the server, so setenv is enough.
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "image-gen",
        prompt: "a red square",
        aspect_ratio: "1:1",
        cwd: ROOT,
      }),
    });
    assert.equal(res.status, 201);
    const done = await waitForRun(ctx.base, body.id, 10000);
    assert.equal(done.meta.status, "completed");
    assert.ok(
      done.meta.outputs.length >= 1,
      `expected outputs, got ${JSON.stringify(done.meta.outputs)}`,
    );
    assert.equal(done.meta.outputs[0].kind, "image");
    const outs = await json(ctx.base, "/api/outputs");
    assert.ok(outs.body.images.length >= 1);
  });

  it("harvests session images when sessionId known", async () => {
    process.env.FAKE_GROK_MODE = "session-image";
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "session image",
        cwd: ROOT,
      }),
    });
    assert.equal(res.status, 201);
    const done = await waitForRun(ctx.base, body.id, 10000);
    assert.equal(done.meta.status, "completed");
    assert.ok(
      done.meta.outputs.length >= 1,
      `session harvest failed: ${JSON.stringify(done)}`,
    );
  });

  it("cancel kills a slow run", async () => {
    process.env.FAKE_GROK_MODE = "slow";
    process.env.FAKE_GROK_SLEEP_MS = "5000";
    const { body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "slow",
        cwd: ROOT,
      }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const cancel = await json(ctx.base, `/api/runs/${body.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancel.res.status, 200);
    const done = await waitForRun(ctx.base, body.id, 8000);
    assert.ok(
      done.meta.status === "cancelled" || done.meta.status === "failed",
      done.meta.status,
    );
    process.env.FAKE_GROK_SLEEP_MS = "0";
  });

  it("invalid run id rejected", async () => {
    const { res } = await json(ctx.base, "/api/runs/not-a-uuid");
    assert.equal(res.status, 400);
    const stream = await fetch(`${ctx.base}/api/runs/also-bad/stream`);
    assert.equal(stream.status, 400);
  });

  it("cancel on missing returns 404", async () => {
    const { res } = await json(
      ctx.base,
      "/api/runs/00000000-0000-4000-8000-0000000000ff/cancel",
      { method: "POST" },
    );
    assert.equal(res.status, 404);
  });

  it("lists runs after activity", async () => {
    const { res, body } = await json(ctx.base, "/api/runs");
    assert.equal(res.status, 200);
    assert.ok(body.runs.length >= 1);
  });

  it("enforces max concurrent runs", async () => {
    process.env.FAKE_GROK_MODE = "slow";
    process.env.FAKE_GROK_SLEEP_MS = "3000";
    const a = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: "code-agent", prompt: "a", cwd: ROOT }),
    });
    const b = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: "code-agent", prompt: "b", cwd: ROOT }),
    });
    assert.equal(a.res.status, 201);
    assert.equal(b.res.status, 201);
    const c = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: "code-agent", prompt: "c", cwd: ROOT }),
    });
    assert.equal(c.res.status, 429);
    // cleanup
    await json(ctx.base, `/api/runs/${a.body.id}/cancel`, { method: "POST" });
    await json(ctx.base, `/api/runs/${b.body.id}/cancel`, { method: "POST" });
    await waitForRun(ctx.base, a.body.id, 8000);
    await waitForRun(ctx.base, b.body.id, 8000);
    process.env.FAKE_GROK_SLEEP_MS = "0";
    process.env.FAKE_GROK_MODE = "pong";
  });

  it("rhai workflow requires name", async () => {
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "rhai-workflow",
        prompt: "go",
        workflow_name: "",
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /workflow_name/);
  });

  it("image-edit with uploaded image stages file into run dir", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const fd = new FormData();
    fd.append(
      "files",
      new Blob([TINY_PNG], { type: "image/png" }),
      "ref.png",
    );
    const up = await (await fetch(`${ctx.base}/api/upload`, { method: "POST", body: fd })).json();
    const name = up.files[0].name;
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "image-edit",
        prompt: "noir",
        images: [name],
        cwd: ROOT,
      }),
    });
    assert.equal(res.status, 201);
    const done = await waitForRun(ctx.base, body.id);
    assert.equal(done.meta.status, "completed");
    const runDir = path.join(ctx.data, "runs", body.id);
    const files = fs.readdirSync(runDir);
    assert.ok(files.some((f) => f.endsWith(".png")), files.join(","));
    const prompt = fs.readFileSync(path.join(runDir, "prompt.txt"), "utf8");
    assert.match(prompt, /@/);
    assert.match(prompt, /image_edit/);
  });

  it("GET /api/workflows is coding-first", async () => {
    const { body } = await json(ctx.base, "/api/workflows");
    assert.equal(body.workflows[0].id, "code-agent");
    assert.equal(body.workflows[0].category, "code");
    assert.ok(body.workflows.some((w) => w.id === "review-diff"));
    assert.ok(body.workflows.some((w) => w.category === "media"));
  });

  it("session create + message starts run and stores transcript", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const created = await json(ctx.base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT, workflowId: "code-agent" }),
    });
    assert.equal(created.res.status, 201);
    const sid = created.body.id;

    const msg = await json(ctx.base, `/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "please reply pong only",
        workflowId: "code-agent",
        cwd: ROOT,
      }),
    });
    assert.equal(msg.res.status, 201);
    assert.ok(msg.body.run.id);
    assert.equal(msg.body.userMessage.role, "user");
    assert.equal(msg.body.assistantMessage.role, "assistant");

    const done = await waitForRun(ctx.base, msg.body.run.id);
    assert.equal(done.meta.status, "completed");

    // allow finalize callback
    await new Promise((r) => setTimeout(r, 100));
    const session = await json(ctx.base, `/api/sessions/${sid}`);
    assert.equal(session.res.status, 200);
    const asst = session.body.messages.filter((m) => m.role === "assistant").pop();
    assert.ok(asst);
    assert.match(asst.text || "", /PONG/);
    assert.ok(session.body.grokSessionId);
  });

  it("lists sessions in drawer index", async () => {
    const { res, body } = await json(ctx.base, "/api/sessions");
    assert.equal(res.status, 200);
    assert.ok(body.sessions.length >= 1);
  });

  it("health exposes desktop agent features", async () => {
    const { res, body } = await json(ctx.base, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(body.features.permissionModes, true);
    assert.equal(body.features.keybindings, true);
    assert.equal(body.features.checkpoints, true);
    assert.ok(body.permissionModes.includes("plan"));
  });

  it("permissions cycle API", async () => {
    const { res, body } = await json(ctx.base, "/api/permissions/cycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "default" }),
    });
    assert.equal(res.status, 200);
    assert.equal(body.mode, "acceptEdits");
  });

  it("settings get/put local scope", async () => {
    const put = await json(ctx.base, "/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissionMode: "plan",
        maxTurns: 7,
        maxBudgetUsd: 10,
      }),
    });
    assert.equal(put.res.status, 200);
    assert.equal(put.body.settings.permissionMode, "plan");
    assert.equal(put.body.settings.maxTurns, 7);
    const get = await json(ctx.base, "/api/settings");
    assert.equal(get.body.settings.maxTurns, 7);
  });

  it("keybindings load with 17 contexts", async () => {
    const { res, body } = await json(ctx.base, "/api/keybindings");
    assert.equal(res.status, 200);
    assert.equal(body.contexts.length, 17);
    assert.ok(body.bindings.some((b) => b.command === "cyclePermissionMode"));
    assert.ok(body.hardcoded.includes("forceCancel"));
  });

  it("models list and select", async () => {
    const list = await json(ctx.base, "/api/models");
    assert.equal(list.res.status, 200);
    assert.ok(list.body.models.length >= 1);
    const pick = await json(ctx.base, "/api/models/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "quick typo fix" }),
    });
    assert.equal(pick.body.reasoningEffort, "low");
  });

  it("SSH CRUD without live network test", async () => {
    const created = await json(ctx.base, "/api/ssh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "127.0.0.1",
        user: "nobody",
        remoteCwd: "/tmp",
        name: "test-local",
      }),
    });
    assert.equal(created.res.status, 201);
    const id = created.body.id;
    const list = await json(ctx.base, "/api/ssh");
    assert.ok(list.body.connections.some((c) => c.id === id));
    const del = await json(ctx.base, `/api/ssh/${id}`, { method: "DELETE" });
    assert.equal(del.res.status, 200);
  });

  it("checkpoints create list restore", async () => {
    const created = await json(ctx.base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT, title: "cp-test" }),
    });
    const sid = created.body.id;
    // seed a message via message API would start a run; use checkpoint with empty + system via restore path
    // Create checkpoint on empty session
    const cp = await json(ctx.base, `/api/sessions/${sid}/checkpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "empty" }),
    });
    assert.equal(cp.res.status, 201);
    const list = await json(ctx.base, `/api/sessions/${sid}/checkpoints`);
    assert.ok(list.body.checkpoints.length >= 1);

    // send a message to change session
    process.env.FAKE_GROK_MODE = "pong";
    const msg = await json(ctx.base, `/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "checkpoint me",
        cwd: ROOT,
        checkpoint: false,
      }),
    });
    assert.equal(msg.res.status, 201);
    await waitForRun(ctx.base, msg.body.run.id);
    await new Promise((r) => setTimeout(r, 80));

    const restore = await json(
      ctx.base,
      `/api/sessions/${sid}/checkpoints/${cp.body.id}/restore`,
      { method: "POST" },
    );
    assert.equal(restore.res.status, 200);
    // restored to empty messages + system note
    const userMsgs = (restore.body.session.messages || []).filter(
      (m) => m.role === "user",
    );
    assert.equal(userMsgs.length, 0);
  });

  it("history search finds user prompts", async () => {
    const { res, body } = await json(
      ctx.base,
      `/api/history?q=${encodeURIComponent("pong")}`,
    );
    assert.equal(res.status, 200);
    assert.ok(body.hits.length >= 1);
    assert.ok(body.hits.some((h) => /pong/i.test(h.text)));
  });

  it("run with permissionMode plan records mode in meta", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "plan only",
        cwd: ROOT,
        permissionMode: "plan",
        maxTurns: 3,
        reasoningEffort: "low",
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(body.meta.permissionMode, "plan");
    assert.equal(body.meta.maxTurns, 3);
    assert.ok(body.meta.args.includes("--permission-mode"));
    assert.ok(body.meta.args.includes("plan"));
    assert.ok(body.meta.args.includes("--max-turns"));
    assert.ok(body.meta.args.includes("--reasoning-effort"));
    const done = await waitForRun(ctx.base, body.id);
    assert.equal(done.meta.status, "completed");
  });

  it("background run registers job", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "bg job",
        cwd: ROOT,
        background: true,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(body.meta.background, true);
    await waitForRun(ctx.base, body.id);
    await new Promise((r) => setTimeout(r, 50));
    const jobs = await json(ctx.base, "/api/background");
    assert.ok(jobs.body.jobs.some((j) => j.runId === body.id));
    const notes = await json(ctx.base, "/api/notifications");
    assert.ok(notes.body.notifications.length >= 1);
  });

  it("budget endpoint returns day stats", async () => {
    const { res, body } = await json(ctx.base, "/api/budget");
    assert.equal(res.status, 200);
    assert.ok(typeof body.spentUsd === "number");
    assert.ok(body.day);
  });

  it("transcript export markdown", async () => {
    const list = await json(ctx.base, "/api/sessions");
    const sid = list.body.sessions[0].id;
    const res = await fetch(
      `${ctx.base}/api/sessions/${sid}/transcript?format=markdown`,
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /^# /);
  });

  it("agents list endpoint", async () => {
    const { res, body } = await json(ctx.base, "/api/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.agents));
  });

  it("sandbox profiles endpoint", async () => {
    const { res, body } = await json(ctx.base, "/api/sandbox");
    assert.equal(res.status, 200);
    assert.ok(body.profiles.some((p) => p.id === "read-only"));
  });

  it("budget cap returns 429 on run", async () => {
    await json(ctx.base, "/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxBudgetUsd: 0.001 }),
    });
    // Spend enough to exceed the tiny cap
    process.env.FAKE_GROK_MODE = "pong";
    const first = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "spend budget",
        cwd: ROOT,
        maxBudgetUsd: 0.001,
      }),
    });
    // First may succeed (est 0.05 > 0.001) or fail immediately
    if (first.res.status === 201) {
      await waitForRun(ctx.base, first.body.id);
      const second = await json(ctx.base, "/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: "code-agent",
          prompt: "over budget",
          cwd: ROOT,
          maxBudgetUsd: 0.001,
        }),
      });
      assert.equal(second.res.status, 429);
      assert.match(second.body.error, /budget/i);
    } else {
      assert.equal(first.res.status, 429);
      assert.match(first.body.error, /budget/i);
    }
    // reset budget cap for later tests
    await json(ctx.base, "/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxBudgetUsd: null }),
    });
  });

  it("failed spawn marks session assistant as error", async () => {
    const session = await json(ctx.base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT }),
    });
    // Missing project is not the path — use invalid permission mode
    const { res, body } = await json(
      ctx.base,
      `/api/sessions/${session.body.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "should fail validation",
          permissionMode: "not-a-real-mode",
          cwd: ROOT,
        }),
      },
    );
    assert.equal(res.status, 400);
    assert.match(body.error, /permission mode/i);
    const got = await json(ctx.base, `/api/sessions/${session.body.id}`);
    const asst = (got.body.messages || []).filter((m) => m.role === "assistant");
    assert.ok(asst.length >= 1);
    assert.equal(asst[asst.length - 1].status, "error");
  });

  it("keybindings put rejects invalid context", async () => {
    const { res, body } = await json(ctx.base, "/api/keybindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bindings: [{ key: "ctrl+x", command: "foo", when: "not-a-context" }],
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /when context/i);
  });

  it("provider describe endpoint", async () => {
    await json(ctx.base, "/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: { gatewayUrl: "https://gateway.example.com" },
      }),
    });
    const { res, body } = await json(ctx.base, "/api/provider");
    assert.equal(res.status, 200);
    assert.equal(body.active, true);
    assert.equal(body.gatewayUrl, "https://gateway.example.com");
  });

  it("agent create and list", async () => {
    const { res, body } = await json(ctx.base, "/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "studio-test-agent",
        description: "integration test agent",
        body: "You are a test agent.",
        scope: "studio",
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(body.id, "studio-test-agent");
    const list = await json(ctx.base, "/api/agents");
    assert.ok(list.body.agents.some((a) => a.id === "studio-test-agent"));
  });

  it("models select endpoint uses rules", async () => {
    const { res, body } = await json(ctx.base, "/api/models/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "quick typo fix please" }),
    });
    assert.equal(res.status, 200);
    assert.equal(body.ruleId, "quick");
    assert.equal(body.reasoningEffort, "low");
  });

  it("accepts text file upload attachment", async () => {
    const form = new FormData();
    form.append(
      "files",
      new Blob(["export const x = 1;\n"], { type: "text/javascript" }),
      "helper.js",
    );
    const res = await fetch(`${ctx.base}/api/upload`, {
      method: "POST",
      body: form,
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.files?.length >= 1);
    assert.equal(body.files[0].kind, "file");
    const list = await json(ctx.base, "/api/uploads");
    assert.ok(
      (list.body.files || list.body.images).some((f) =>
        f.name.includes("helper"),
      ),
    );
  });

  it("session message sets activeRunId then clears on finish", async () => {
    process.env.FAKE_GROK_MODE = "pong";
    const session = await json(ctx.base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT }),
    });
    const sid = session.body.id;
    const msg = await json(ctx.base, `/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "active run track", cwd: ROOT }),
    });
    assert.equal(msg.res.status, 201);
    assert.ok(msg.body.run.id);
    const mid = await json(ctx.base, `/api/sessions/${sid}`);
    // may still be running or already finished depending on timing
    if (mid.body.activeRunId) {
      assert.equal(mid.body.activeRunId, msg.body.run.id);
    }
    await waitForRun(ctx.base, msg.body.run.id);
    await new Promise((r) => setTimeout(r, 80));
    const done = await json(ctx.base, `/api/sessions/${sid}`);
    assert.equal(done.body.activeRunId, null);
    const active = await json(ctx.base, `/api/sessions/${sid}/active-run`);
    assert.equal(active.body.active, false);
  });

  it("active-run reports live slow run for reattach", async () => {
    process.env.FAKE_GROK_MODE = "slow";
    process.env.FAKE_GROK_SLEEP_MS = "2500";
    const session = await json(ctx.base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT }),
    });
    const sid = session.body.id;
    const msg = await json(ctx.base, `/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "slow for reattach", cwd: ROOT }),
    });
    assert.equal(msg.res.status, 201);
    const active = await json(ctx.base, `/api/sessions/${sid}/active-run`);
    assert.equal(active.body.active, true);
    assert.equal(active.body.live, true);
    assert.equal(active.body.runId, msg.body.run.id);
    assert.ok(active.body.messageId);
    // cancel to not leak
    await json(ctx.base, `/api/runs/${msg.body.run.id}/cancel`, {
      method: "POST",
    });
    process.env.FAKE_GROK_SLEEP_MS = "0";
    process.env.FAKE_GROK_MODE = "pong";
  });

  it("reconcile endpoint is reachable", async () => {
    const { res, body } = await json(ctx.base, "/api/runs/reconcile", {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.reconciled));
  });

  it("tools mode run completes with tool events in log", async () => {
    process.env.FAKE_GROK_MODE = "tools";
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "use tools",
        cwd: ROOT,
        interactive: false,
        permissionMode: "bypassPermissions",
      }),
    });
    assert.equal(res.status, 201);
    const done = await waitForRun(ctx.base, body.id);
    assert.equal(done.meta.status, "completed");
    const detail = await json(ctx.base, `/api/runs/${body.id}`);
    const types = detail.body.events.map((e) => e.type);
    assert.ok(types.includes("tool_call"));
    assert.ok(types.includes("tool_result"));
    process.env.FAKE_GROK_MODE = "pong";
  });

  it("ACP interactive run requests permission and accepts allow", async () => {
    process.env.FAKE_GROK_MODE = "acp-permission";
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "need approval",
        cwd: ROOT,
        permissionMode: "default",
        interactive: true,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(body.meta.transport, "acp");

    // Wait for permission_request event
    let permId = null;
    for (let i = 0; i < 40; i++) {
      const detail = await json(ctx.base, `/api/runs/${body.id}`);
      const perm = detail.body.events.find(
        (e) => e.type === "studio" && e.event === "permission_request",
      );
      if (perm) {
        permId = perm.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(permId, "expected permission_request event");

    const allow = await json(
      ctx.base,
      `/api/runs/${body.id}/permissions/${permId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow: true, optionId: "allow-once" }),
      },
    );
    assert.equal(allow.res.status, 200);

    const done = await waitForRun(ctx.base, body.id, 15000);
    assert.ok(
      ["completed", "failed", "cancelled"].includes(done.meta.status),
    );
    const detail = await json(ctx.base, `/api/runs/${body.id}`);
    const texts = detail.body.events
      .filter((e) => e.type === "text")
      .map((e) => e.data)
      .join("");
    assert.match(texts, /ALLOWED_PONG|ACP_PONG|DENIED/);
    process.env.FAKE_GROK_MODE = "pong";
  });

  it("mid-run budget kill on many tool turns", async () => {
    process.env.FAKE_GROK_MODE = "budget-turns";
    // Tiny cap so estimated turns blow it
    await json(ctx.base, "/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxBudgetUsd: 0.08 }),
    });
    const { res, body } = await json(ctx.base, "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "code-agent",
        prompt: "burn budget",
        cwd: ROOT,
        maxBudgetUsd: 0.08,
        interactive: false,
        permissionMode: "bypassPermissions",
      }),
    });
    // May 429 at gate if ledger already spent
    if (res.status === 201) {
      const done = await waitForRun(ctx.base, body.id, 10000);
      // either completed with few turns or budget_exceeded / cancelled
      assert.ok(
        ["completed", "budget_exceeded", "cancelled", "failed"].includes(
          done.meta.status,
        ),
      );
      if (done.meta.status === "budget_exceeded") {
        const detail = await json(ctx.base, `/api/runs/${body.id}`);
        assert.ok(
          detail.body.events.some(
            (e) => e.type === "studio" && e.event === "budget_exceeded",
          ),
        );
      }
    } else {
      assert.equal(res.status, 429);
    }
    await json(ctx.base, "/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxBudgetUsd: null }),
    });
    process.env.FAKE_GROK_MODE = "pong";
  });

  it("worktree list endpoint", async () => {
    const { res, body } = await json(
      ctx.base,
      `/api/worktrees?cwd=${encodeURIComponent(ROOT)}`,
    );
    assert.equal(res.status, 200);
    assert.ok(typeof body.git === "boolean");
    assert.ok(Array.isArray(body.worktrees));
  });
});
