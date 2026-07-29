import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assertBudgetAllows,
  recordRunUsage,
  getBudgetStatus,
  DEFAULT_COST_PER_TURN_USD,
} from "../../server/lib/budget.js";
import {
  sandboxToCliArgs,
  evaluateToolPolicy,
  normalizeSandbox,
} from "../../server/lib/sandbox.js";
import {
  parseAgentFrontmatter,
  listAgents,
  writeAgent,
  agentToCliArgs,
} from "../../server/lib/agents.js";
import {
  createCheckpoint,
  listCheckpoints,
  loadCheckpointForRestore,
} from "../../server/lib/checkpoints.js";
import {
  registerBackgroundJob,
  finishBackgroundJob,
  listBackgroundJobs,
  listNotifications,
  registerNotificationHook,
  clearNotificationHooks,
} from "../../server/lib/background.js";
import {
  createConnection,
  validateConnectionInput,
  buildSshArgs,
  shellSingleQuote,
  buildRemoteGrokCommand,
  listConnections,
  deleteConnection,
} from "../../server/lib/ssh.js";
import {
  normalizeProviderConfig,
  providerToEnv,
  describeProvider,
} from "../../server/lib/providers.js";
import { buildGrokArgs } from "../../server/lib/runs.js";
import { randomUUID } from "crypto";

describe("budget", () => {
  let data;
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-bud-"));
  });
  after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("allows when under cap and blocks when exceeded", () => {
    assertBudgetAllows(data, { maxBudgetUsd: 1 });
    recordRunUsage(data, {
      runId: randomUUID(),
      turns: 1,
      costUsd: 0.9,
      status: "completed",
    });
    assert.throws(
      () =>
        assertBudgetAllows(data, {
          maxBudgetUsd: 1,
          estimatedCostUsd: 0.2,
        }),
      /budget exceeded/i,
    );
  });

  it("tracks status", () => {
    const st = getBudgetStatus(data, { maxBudgetUsd: 1 });
    assert.ok(st.spentUsd >= 0.9);
    assert.ok(st.remainingUsd != null);
    assert.ok(st.remainingUsd < 0.2);
  });

  it("uses default cost per turn", () => {
    assert.ok(DEFAULT_COST_PER_TURN_USD > 0);
  });

  it("enforces session turn limits", () => {
    const sessionId = randomUUID();
    recordRunUsage(data, {
      runId: randomUUID(),
      sessionId,
      turns: 4,
      costUsd: 0.01,
      status: "completed",
    });
    assertBudgetAllows(data, {
      sessionId,
      sessionMaxTurns: 6,
      estimatedTurns: 1,
    });
    assert.throws(
      () =>
        assertBudgetAllows(data, {
          sessionId,
          sessionMaxTurns: 5,
          estimatedTurns: 2,
        }),
      /turn limit/i,
    );
  });
});

describe("sandbox", () => {
  it("normalizes none to null", () => {
    assert.equal(normalizeSandbox("none"), null);
    assert.equal(normalizeSandbox(""), null);
  });

  it("emits --sandbox and deny rules for read-only", () => {
    const { args, profile } = sandboxToCliArgs({ sandbox: "read-only" });
    assert.equal(profile, "read-only");
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("--deny"));
  });

  it("blocks edit tools in plan mode", () => {
    const r = evaluateToolPolicy("Write", { permissionMode: "plan" });
    assert.equal(r.allowed, false);
    const ok = evaluateToolPolicy("Read", { permissionMode: "plan" });
    assert.equal(ok.allowed, true);
  });
});

describe("agents", () => {
  let home;
  let data;
  let project;
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ag-home-"));
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ag-data-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ag-proj-"));
  });
  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("parses frontmatter", () => {
    const { meta, body } = parseAgentFrontmatter(`---
name: explorer
description: >
  Fast read-only
permission_mode: plan
---
You explore code.
`);
    assert.equal(meta.name, "explorer");
    assert.equal(meta.permission_mode, "plan");
    assert.match(meta.description, /Fast read-only/);
    assert.match(body, /explore code/);
  });

  it("writes and lists studio agents", () => {
    writeAgent(
      {
        name: "my-reviewer",
        description: "Reviews diffs",
        body: "Review carefully.",
        permissionMode: "plan",
      },
      { scope: "studio", dataDir: data, home, projectCwd: project },
    );
    const agents = listAgents({ dataDir: data, home, projectCwd: project, includeBundled: false });
    assert.ok(agents.some((a) => a.id === "my-reviewer"));
    const args = agentToCliArgs("my-reviewer", {
      dataDir: data,
      home,
      projectCwd: project,
      includeBundled: false,
    });
    assert.equal(args[0], "--agent");
    assert.ok(fs.existsSync(args[1]));
  });
});

describe("checkpoints", () => {
  let data;
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cp-"));
  });
  after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("creates and lists checkpoints", () => {
    const session = {
      id: sessionId,
      title: "Test",
      cwd: data,
      messages: [
        { id: "1", role: "user", text: "hello", at: Date.now() },
      ],
      workflowId: "code-agent",
      grokSessionId: null,
    };
    const cp = createCheckpoint(data, sessionId, {
      label: "t1",
      session,
      reason: "manual",
      includeGit: false,
    });
    assert.ok(cp.id);
    const list = listCheckpoints(data, sessionId);
    assert.equal(list.length, 1);
    const full = loadCheckpointForRestore(data, sessionId, cp.id);
    assert.equal(full.messages.length, 1);
    assert.equal(full.messages[0].text, "hello");
  });
});

describe("background + notifications", () => {
  let data;
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-bg-"));
    clearNotificationHooks();
  });
  after(() => {
    clearNotificationHooks();
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("registers finish and emits hooks", () => {
    const runId = randomUUID();
    const seen = [];
    registerNotificationHook((e) => seen.push(e));
    registerBackgroundJob(data, {
      runId,
      sessionId: randomUUID(),
      title: "job",
      promptPreview: "do work",
    });
    finishBackgroundJob(data, runId, {
      status: "completed",
      summary: "done",
    });
    const jobs = listBackgroundJobs(data);
    assert.equal(jobs[0].status, "completed");
    const notes = listNotifications(data);
    assert.ok(notes.some((n) => n.type === "background.completed"));
    assert.ok(seen.some((e) => e.type === "background.started"));
    assert.ok(seen.some((e) => e.type === "background.completed"));
  });
});

describe("ssh", () => {
  let data;
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ssh-"));
  });
  after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("validates and stores connections", () => {
    assert.throws(() => validateConnectionInput({ host: "" }), /host/);
    assert.throws(
      () => validateConnectionInput({ host: "evil;rm" }),
      /invalid/,
    );
    const conn = createConnection(data, {
      host: "example.com",
      user: "deploy",
      port: 22,
      remoteCwd: "/var/app",
      remoteGrokBin: "/usr/bin/grok",
    });
    assert.ok(conn.id);
    assert.equal(listConnections(data).length, 1);
    const args = buildSshArgs(conn);
    assert.ok(args.includes("deploy@example.com"));
    assert.ok(args.includes("BatchMode=yes"));
    const cmd = buildRemoteGrokCommand(conn, ["--version"]);
    assert.match(cmd, /cd '/);
    assert.match(cmd, /--version/);
    assert.equal(shellSingleQuote("a'b"), `'a'\\''b'`);
    deleteConnection(data, conn.id);
    assert.equal(listConnections(data).length, 0);
  });
});

describe("providers", () => {
  it("normalizes URLs and builds env", () => {
    assert.throws(
      () => normalizeProviderConfig({ gatewayUrl: "not-a-url" }),
      /http/,
    );
    const { env, provider } = providerToEnv({
      gatewayUrl: "https://gw.example.com/",
    });
    assert.equal(provider.gatewayUrl, "https://gw.example.com");
    assert.equal(env.XAI_API_BASE_URL, "https://gw.example.com");
    assert.equal(describeProvider(provider).active, true);
  });
});

describe("buildGrokArgs", () => {
  it("includes permission, model, turns, sandbox, reasoning", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.txt",
      workDir: "/tmp/proj",
      model: "grok-4.5",
      permissionMode: "plan",
      reasoningEffort: "high",
      maxTurns: 12,
      sandbox: "workspace-write",
      allowRules: ["Bash(git *)"],
      denyRules: [],
    });
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes("plan"));
    assert.ok(args.includes("-m"));
    assert.ok(args.includes("grok-4.5"));
    assert.ok(args.includes("--max-turns"));
    assert.ok(args.includes("12"));
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("--reasoning-effort"));
    assert.ok(args.includes("--allow"));
    assert.ok(!args.includes("--always-approve"));
  });

  it("bypass adds always-approve", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.txt",
      workDir: "/tmp/proj",
      permissionMode: "bypassPermissions",
    });
    assert.ok(args.includes("--always-approve"));
  });

  it("rejects invalid maxTurns", () => {
    assert.throws(
      () =>
        buildGrokArgs({
          promptFile: "/tmp/p.txt",
          workDir: "/tmp/proj",
          maxTurns: 0,
        }),
      /maxTurns/,
    );
  });

  it("requires promptFile and workDir", () => {
    assert.throws(() => buildGrokArgs({ workDir: "/tmp" }), /promptFile/);
    assert.throws(
      () => buildGrokArgs({ promptFile: "/tmp/p.txt" }),
      /workDir/,
    );
  });

  it("includes agent, no-subagents, tools, rules, verbatim", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.txt",
      workDir: "/tmp/proj",
      agent: "studio-agent-that-does-not-exist-xyz",
      noSubagents: true,
      disableWebSearch: true,
      tools: ["read_file", "grep"],
      disallowedTools: ["run_terminal_command"],
      rules: "Be careful",
      verbatim: true,
      resumeGrokSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    assert.ok(args.includes("--agent"));
    const agentIdx = args.indexOf("--agent");
    assert.equal(args[agentIdx + 1], "studio-agent-that-does-not-exist-xyz");
    assert.ok(args.includes("--no-subagents"));
    assert.ok(args.includes("--disable-web-search"));
    assert.ok(args.includes("--tools"));
    assert.ok(args.includes("read_file,grep"));
    assert.ok(args.includes("--disallowed-tools"));
    assert.ok(args.includes("--rules"));
    assert.ok(args.includes("--verbatim"));
    assert.ok(args.includes("--resume"));
    assert.ok(!args.includes("--no-auto-update"));
  });

  it("maps yolo true to bypass", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.txt",
      workDir: "/tmp/proj",
      yolo: true,
    });
    assert.ok(args.includes("bypassPermissions"));
    assert.ok(args.includes("--always-approve"));
  });
});
