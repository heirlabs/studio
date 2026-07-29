import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  needsInteractiveApprovals,
  permissionModeToAcpMeta,
  acpUpdateToStudioEvents,
  jsonRpcRequest,
  jsonRpcResponse,
} from "../../server/lib/acp-client.js";
import {
  createRunBudgetTracker,
  costFromEndEvent,
} from "../../server/lib/budget-runtime.js";
import { processRunEventForBudget } from "../../server/lib/runs.js";
import {
  isGitRepo,
  createWorktree,
  listWorktrees,
  removeWorktree,
  sanitizeWorktreeName,
  resolveRunCwd,
} from "../../server/lib/worktrees.js";
import { recordRunUsage } from "../../server/lib/budget.js";
import { randomUUID } from "crypto";

describe("acp helpers", () => {
  it("detects interactive modes", () => {
    assert.equal(needsInteractiveApprovals("default"), true);
    assert.equal(needsInteractiveApprovals("acceptEdits"), true);
    assert.equal(needsInteractiveApprovals("bypassPermissions"), false);
    assert.equal(needsInteractiveApprovals("plan"), false);
    assert.equal(needsInteractiveApprovals("auto"), false);
  });

  it("maps permission mode to ACP meta", () => {
    assert.deepEqual(permissionModeToAcpMeta("bypassPermissions"), {
      yoloMode: true,
    });
    assert.deepEqual(permissionModeToAcpMeta("auto"), { autoMode: true });
    assert.deepEqual(permissionModeToAcpMeta("default"), {});
  });

  it("maps ACP updates to studio events", () => {
    const text = acpUpdateToStudioEvents({
      sessionUpdate: "agent_message_chunk",
      content: { text: "hi" },
    });
    assert.equal(text[0].type, "text");
    assert.equal(text[0].data, "hi");

    const tool = acpUpdateToStudioEvents({
      sessionUpdate: "tool_call",
      title: "read_file",
      rawInput: { path: "a.js" },
    });
    assert.equal(tool[0].type, "tool_call");
    assert.equal(tool[0].name, "read_file");
  });

  it("builds json-rpc envelopes", () => {
    assert.equal(jsonRpcRequest(1, "initialize", {}).method, "initialize");
    assert.deepEqual(jsonRpcResponse(1, { ok: true }).result, { ok: true });
  });
});

describe("mid-run budget", () => {
  let data;
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-br-"));
  });
  after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("kills when projected cost exceeds cap after turns", () => {
    // Pre-spend almost entire budget
    recordRunUsage(data, {
      runId: randomUUID(),
      turns: 1,
      costUsd: 0.08,
      status: "completed",
    });
    const tracker = createRunBudgetTracker({
      dataDir: data,
      maxBudgetUsd: 0.1,
      costPerTurn: 0.05,
    });
    // first turn: 0.08 + 0.05 = 0.13 > 0.1 → kill
    const r = tracker.onTurn();
    assert.equal(r.allow, false);
    assert.match(r.reason, /budget exceeded/i);
  });

  it("allows under cap", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gs-br2-"));
    const tracker = createRunBudgetTracker({
      dataDir: d,
      maxBudgetUsd: 10,
      costPerTurn: 0.05,
    });
    assert.equal(tracker.onTurn().allow, true);
    assert.equal(tracker.onTurn().allow, true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("extracts cost from end event", () => {
    assert.equal(costFromEndEvent({ total_cost_usd: 0.12 }), 0.12);
    assert.equal(costFromEndEvent({ type: "text" }), null);
  });

  it("processRunEventForBudget counts tool_calls", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gs-br3-"));
    const tracker = createRunBudgetTracker({
      dataDir: d,
      maxBudgetUsd: 100,
    });
    const r = processRunEventForBudget(tracker, { type: "tool_call", name: "x" });
    assert.equal(r.kill, false);
    assert.equal(tracker.turnCount, 1);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("worktrees", () => {
  let repo;
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gs-wt-repo-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# t\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  });
  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("sanitizes names", () => {
    assert.equal(sanitizeWorktreeName("My Session!"), "my-session");
  });

  it("creates lists and removes isolated worktrees", () => {
    assert.equal(isGitRepo(repo), true);
    const wt = createWorktree(repo, { name: "feat-a" });
    assert.ok(fs.existsSync(wt.path));
    assert.ok(wt.branch.startsWith("studio/"));
    assert.equal(isGitRepo(wt.path), true);
    const list = listWorktrees(repo);
    assert.ok(list.some((w) => w.name === "feat-a"));
    removeWorktree(repo, "feat-a");
    assert.equal(fs.existsSync(wt.path), false);
  });

  it("resolveRunCwd with worktree returns isolated path", () => {
    const { cwd, worktree } = resolveRunCwd({
      projectCwd: repo,
      worktree: true,
      worktreeName: "iso-1",
    });
    assert.ok(cwd.includes("worktrees"));
    assert.equal(worktree.name, "iso-1");
    removeWorktree(repo, "iso-1");
  });

  it("rejects non-git projects", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gs-nongit-"));
    assert.throws(() => createWorktree(d, { name: "x" }), /not a git/i);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
