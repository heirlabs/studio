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
  decidePermission,
  isAutoApprovableToolCall,
  pickAllowOption,
} from "../../server/lib/acp-client.js";
import {
  buildRemoteGrokCommand,
  buildSshArgs,
  shellSingleQuote,
} from "../../server/lib/ssh.js";
import { loadLedger, saveLedger } from "../../server/lib/budget.js";
import {
  createRunBudgetTracker,
  costFromEndEvent,
} from "../../server/lib/budget-runtime.js";
import {
  processRunEventForBudget,
  normalizeStreamEvent,
} from "../../server/lib/runs.js";
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
    assert.equal(tool[0].title, "read_file");
    assert.deepEqual(tool[0].input, { path: "a.js" });
  });

  it("ACP tool cards are named through the shared normalizer", () => {
    // The run manager feeds every ACP event through normalizeStreamEvent, so
    // assert the composed pipeline — that is what the UI actually receives.
    const names = new Map();
    const pipe = (u) =>
      acpUpdateToStudioEvents(u).map((e) => normalizeStreamEvent(e, names));

    const [call] = pipe({
      sessionUpdate: "tool_call",
      toolCallId: "call-9547adc6",
      title: "read_file",
      kind: "read",
      rawInput: { path: "a.js" },
    });
    assert.equal(call.name, "read_file");

    // Real ACP updates carry prose titles, or none at all — neither may end up
    // as the card name (it used to show "Read `/abs/path`" or the raw UUID).
    const [prose] = pipe({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-9547adc6",
      title: "Read `/private/var/tmp/a.js`",
      status: "completed",
      rawOutput: "contents",
    });
    assert.equal(prose.name, "read_file");
    assert.equal(prose.detail, "Read `/private/var/tmp/a.js`");
    assert.equal(prose.result, "contents");

    const [bare] = pipe({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-9547adc6",
      status: "in_progress",
    });
    assert.equal(bare.name, "read_file");
    assert.doesNotMatch(bare.name, /^call-/);
  });

  it("builds json-rpc envelopes", () => {
    assert.equal(jsonRpcRequest(1, "initialize", {}).method, "initialize");
    assert.deepEqual(jsonRpcResponse(1, { ok: true }).result, { ok: true });
  });
});

describe("permission decisions", () => {
  const options = [
    { optionId: "rej", kind: "reject_once", name: "Reject" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "once", kind: "allow_once", name: "Allow once" },
  ];

  it("prefers allow_once, then allow_always, then a named allow", () => {
    assert.equal(pickAllowOption(options).optionId, "once");
    assert.equal(
      pickAllowOption([options[0], options[1]]).optionId,
      "always",
    );
    assert.equal(
      pickAllowOption([{ optionId: "y", name: "Yes, approve" }]).optionId,
      "y",
    );
    assert.equal(pickAllowOption([{ optionId: "n", name: "Nope" }]), null);
    assert.equal(pickAllowOption([]), null);
  });

  it("classifies tool calls by kind, falling back to title", () => {
    assert.equal(isAutoApprovableToolCall({ kind: "edit" }), true);
    assert.equal(isAutoApprovableToolCall({ kind: "read" }), true);
    assert.equal(isAutoApprovableToolCall({ kind: "execute" }), false);
    assert.equal(isAutoApprovableToolCall({ kind: "fetch" }), false);
    // no kind → title
    assert.equal(isAutoApprovableToolCall({ title: "write_file" }), true);
    assert.equal(
      isAutoApprovableToolCall({ title: "run_terminal_command" }),
      false,
    );
    assert.equal(isAutoApprovableToolCall({}), false);
    assert.equal(isAutoApprovableToolCall(null), false);
  });

  it("acceptEdits auto-allows edits but still asks for shell", () => {
    const edit = decidePermission({
      permissionMode: "acceptEdits",
      toolCall: { kind: "edit", title: "edit_file" },
      options,
    });
    assert.equal(edit.action, "allow");
    assert.equal(edit.optionId, "once");
    assert.match(edit.reason, /acceptEdits/);

    assert.equal(
      decidePermission({
        permissionMode: "acceptEdits",
        toolCall: { kind: "execute", title: "run_terminal_command" },
        options,
      }).action,
      "ask",
    );
  });

  it("default mode always asks, even for edits", () => {
    assert.equal(
      decidePermission({
        permissionMode: "default",
        toolCall: { kind: "edit", title: "edit_file" },
        options,
      }).action,
      "ask",
    );
  });

  it("read-only sandbox denies writes regardless of mode", () => {
    const v = decidePermission({
      permissionMode: "acceptEdits",
      sandbox: "read-only",
      toolCall: { kind: "edit", title: "edit_file" },
      options,
    });
    assert.equal(v.action, "deny");
    assert.match(v.reason, /read-only sandbox/i);
    // reads are still fine under read-only
    assert.equal(
      decidePermission({
        permissionMode: "acceptEdits",
        sandbox: "read-only",
        toolCall: { kind: "read", title: "read_file" },
        options,
      }).action,
      "allow",
    );
  });

  it("falls through to ask when acceptEdits has no allow option offered", () => {
    assert.equal(
      decidePermission({
        permissionMode: "acceptEdits",
        toolCall: { kind: "edit" },
        options: [{ optionId: "rej", kind: "reject_once" }],
      }).action,
      "ask",
    );
  });
});

describe("ssh remote command construction", () => {
  const conn = {
    host: "example.com",
    user: "deploy",
    port: 2222,
    remoteCwd: "/srv/app",
    remoteGrokBin: "grok",
    identityFile: "/home/me/.ssh/id_ed25519",
  };

  it("builds batch-mode ssh args with port and identity", () => {
    const args = buildSshArgs(conn);
    assert.ok(args.includes("BatchMode=yes"));
    assert.equal(args[args.indexOf("-p") + 1], "2222");
    assert.equal(args[args.indexOf("-i") + 1], conn.identityFile);
    assert.equal(args[args.length - 1], "deploy@example.com");
  });

  it("single-quotes every argument so metacharacters stay inert", () => {
    const cmd = buildRemoteGrokCommand(conn, [
      "--prompt-file",
      "/tmp/p.txt; rm -rf ~",
      "--cwd",
      "/srv/app",
    ]);
    assert.match(cmd, /^cd '\/srv\/app' && 'grok' /);
    assert.ok(
      cmd.includes("'/tmp/p.txt; rm -rf ~'"),
      `metacharacters must stay inside quotes: ${cmd}`,
    );
    // no bare, unquoted semicolon that the remote shell would treat as a
    // command separator
    assert.doesNotMatch(cmd.replace(/'[^']*'/g, ""), /;/);
  });

  it("escapes embedded single quotes with the POSIX '\\'' idiom", () => {
    assert.equal(shellSingleQuote("it's"), `'it'\\''s'`);
  });

  it("quoting survives a real shell round-trip", () => {
    // Feed the quoted forms to /bin/sh and check the words come back intact —
    // this is the property that matters for remote execution.
    const hostile = [
      "/tmp/p.txt; rm -rf ~",
      "don't run",
      "$(whoami)",
      "`id`",
      "a b\tc",
      "back\\slash",
    ];
    const script = hostile
      .map((s) => `printf '%s\\n' ${shellSingleQuote(s)}`)
      .join("\n");
    const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    assert.deepEqual(out.split("\n").slice(0, hostile.length), hostile);
  });
});

describe("budget ledger durability", () => {
  let data;
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ledger-"));
  });
  after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("round-trips through an atomic save with no temp file left behind", () => {
    saveLedger(data, { days: { "2026-01-01": { spentUsd: 1 } }, sessions: {}, runs: {} });
    assert.equal(loadLedger(data).days["2026-01-01"].spentUsd, 1);
    const leftovers = fs
      .readdirSync(data)
      .filter((f) => f.startsWith("budget-ledger.json.tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("quarantines a truncated ledger instead of throwing forever", () => {
    const p = path.join(data, "budget-ledger.json");
    fs.writeFileSync(p, '{"days":{"2026-01-01":{"spentU');
    const recovered = loadLedger(data);
    assert.deepEqual(recovered, { days: {}, sessions: {}, runs: {} });
    assert.ok(
      fs.readdirSync(data).some((f) => f.includes(".corrupt-")),
      "the unparseable file should be kept aside for inspection",
    );
    // and a subsequent run can still record usage
    recordRunUsage(data, { runId: randomUUID(), turns: 1, costUsd: 0.02 });
    assert.equal(loadLedger(data).days[Object.keys(loadLedger(data).days)[0]].spentUsd, 0.02);
  });

  it("tolerates a ledger missing top-level sections", () => {
    fs.writeFileSync(path.join(data, "budget-ledger.json"), "{}");
    assert.deepEqual(loadLedger(data), { days: {}, sessions: {}, runs: {} });
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
