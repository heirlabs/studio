#!/usr/bin/env node
/**
 * Fake grok binary for integration tests.
 *
 * Headless modes via FAKE_GROK_MODE:
 *   pong | image | session-image | fail | slow | stderr | tools | budget-turns
 * Extra env:
 *   FAKE_GROK_IMAGE_DIR, FAKE_GROK_SESSIONS_ROOT, FAKE_GROK_CWD, FAKE_GROK_SLEEP_MS
 *
 * Also serves `fake-grok agent … stdio` as a JSON-RPC ACP agent. There:
 *   FAKE_GROK_MODE=acp-permission     → request permission before answering
 *   FAKE_GROK_ACP_TOOL_KIND=edit      → what kind of tool asks (default execute)
 *   FAKE_GROK_ACP_FAIL=1              → fail the turn, to exercise teardown
 *   FAKE_GROK_ACP_PERM_TIMEOUT_MS     → how long to await a decision (default 12000)
 */
import fs from "fs";
import path from "path";
import readline from "readline";

const mode = process.env.FAKE_GROK_MODE || "pong";
const sleepMs = Number(process.env.FAKE_GROK_SLEEP_MS || 0);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function tinyPng(dest) {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b64, "base64"));
}

function isAcpStdio() {
  const args = process.argv.slice(2);
  return args.includes("agent") && args.includes("stdio");
}

function isVersionProbe() {
  return process.argv.includes("--version") || process.argv.includes("-v");
}

// ── ACP (agent stdio) ────────────────────────────────────────────────

const ACP_TOOL = {
  execute: {
    title: "run_terminal_command",
    kind: "execute",
    rawInput: { command: "echo hi" },
  },
  edit: {
    title: "edit_file",
    kind: "edit",
    rawInput: { path: "src/app.js" },
  },
};

async function runAcp() {
  const rl = readline.createInterface({ input: process.stdin });
  let sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let yolo = process.argv.includes("--always-approve");
  const pending = new Map();
  const tool = ACP_TOOL[process.env.FAKE_GROK_ACP_TOOL_KIND] || ACP_TOOL.execute;

  const respond = (id, result) => emit({ jsonrpc: "2.0", id, result });
  const notify = (method, params) => emit({ jsonrpc: "2.0", method, params });
  const say = (text) =>
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Permission response from the client
    if (msg.id != null && msg.result && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      continue;
    }

    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
        },
        agentInfo: { name: "fake-grok", version: "0.0.0-test" },
      });
      continue;
    }

    if (msg.method === "session/new") {
      if (msg.params?._meta?.yoloMode) yolo = true;
      sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      respond(msg.id, { sessionId });
      continue;
    }

    if (msg.method === "session/load") {
      sessionId = msg.params?.sessionId || sessionId;
      respond(msg.id, { sessionId });
      continue;
    }

    if (msg.method === "x.ai/compact_conversation") {
      respond(msg.id, {
        tokensBefore: 80000,
        tokensAfter: 12000,
        summary: "compacted for tests",
      });
      continue;
    }

    if (msg.method === "session/cancel") continue;

    if (msg.method === "session/prompt") {
      // Must not await the permission inside the read loop — that deadlocks stdin.
      void (async () => {
        const promptId = msg.id;

        if (process.env.FAKE_GROK_ACP_FAIL === "1") {
          emit({
            jsonrpc: "2.0",
            id: promptId,
            error: { code: -32000, message: "fake acp turn failure" },
          });
          return;
        }

        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "acp-think" },
          },
        });

        if (!yolo && (mode === "acp-permission" || mode === "default")) {
          const permId = 9001;
          const permPromise = new Promise((resolve) =>
            pending.set(permId, resolve),
          );
          emit({
            jsonrpc: "2.0",
            id: permId,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: { toolCallId: "tc-1", status: "pending", ...tool },
              options: [
                { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                { optionId: "reject-once", name: "Reject", kind: "reject_once" },
              ],
            },
          });
          const decision = await Promise.race([
            permPromise,
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ outcome: { outcome: "cancelled" } }),
                Number(process.env.FAKE_GROK_ACP_PERM_TIMEOUT_MS || 12000),
              ),
            ),
          ]);

          const selected =
            decision?.outcome?.outcome === "selected"
              ? decision.outcome.optionId
              : null;
          if (selected && String(selected).includes("allow")) {
            notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-1",
                status: "completed",
                ...tool,
              },
            });
            say("ALLOWED_PONG");
          } else {
            say("DENIED_PONG");
          }
        } else {
          say("ACP_PONG");
        }

        respond(promptId, { stopReason: "end_turn" });
        setTimeout(() => process.exit(0), 50);
      })();
      continue;
    }
  }
}

// ── Headless (streaming-json) ────────────────────────────────────────

async function runHeadless() {
  if (sleepMs > 0 && mode !== "slow") {
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  if (mode === "fail") {
    emit({ type: "error", message: "fake failure" });
    process.exit(1);
  }

  if (mode === "stderr") {
    process.stderr.write("fake stderr line\n");
  }

  if (mode === "slow") {
    emit({ type: "thought", data: "thinking" });
    await new Promise((r) =>
      setTimeout(r, Number(process.env.FAKE_GROK_SLEEP_MS || 2000)),
    );
    emit({ type: "text", data: "done" });
    emit({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "00000000-0000-4000-8000-000000000099",
    });
    return;
  }

  if (mode === "image") {
    const dir = process.env.FAKE_GROK_IMAGE_DIR;
    if (!dir) {
      emit({ type: "error", message: "FAKE_GROK_IMAGE_DIR required" });
      process.exit(1);
    }
    const out = path.join(dir, "generated.png");
    tinyPng(out);
    emit({ type: "text", data: `Created image.\nOUTPUT: ${out}\n` });
    emit({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    return;
  }

  if (mode === "session-image") {
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const parent = path.join(
      process.env.FAKE_GROK_SESSIONS_ROOT,
      encodeURIComponent(path.resolve(process.env.FAKE_GROK_CWD)),
    );
    tinyPng(path.join(parent, sessionId, "images", "session-shot.png"));
    emit({ type: "text", data: "Saved session image.\n" });
    emit({ type: "end", stopReason: "EndTurn", sessionId });
    return;
  }

  if (mode === "tools") {
    // Field-for-field the shape grok 0.2.117 emits — no `name`, no `input`,
    // and results arrive as tool_call_update. Studio must normalize these.
    emit({ type: "thought", data: "planning tools" });
    emit({
      type: "available_commands",
      tools: ["read_file", "run_terminal_command"],
      commands: ["compact", "context"],
    });
    emit({
      type: "tool_call",
      toolCallId: "call-abc-0",
      title: "read_file",
      kind: "read",
      status: "pending",
      toolName: "read_file",
      rawInput: { target_file: "src/app.js", limit: 50 },
      content: [],
      locations: [],
    });
    // In-flight update: no title, empty content — must not render as "[]"
    emit({
      type: "tool_call_update",
      toolCallId: "call-abc-0",
      status: "in_progress",
      content: [],
    });
    // Completion: still no title, so the name comes from the call it updates
    emit({
      type: "tool_call_update",
      toolCallId: "call-abc-0",
      status: "completed",
      rawOutput: "export function app() { return 1; }",
    });
    emit({ type: "text", data: "Used tools. PONG" });
    emit({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "00000000-0000-4000-8000-000000000077",
      total_cost_usd: 0.12,
      num_turns: 2,
    });
    return;
  }

  if (mode === "budget-turns") {
    // Many tool_calls so mid-run budget enforcement can fire
    for (let i = 0; i < 5; i++) {
      emit({
        type: "tool_call",
        toolCallId: `call-${i}`,
        title: "read_file",
        kind: "read",
        toolName: "read_file",
        rawInput: { target_file: `f${i}.js` },
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    emit({ type: "text", data: "many turns" });
    emit({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "00000000-0000-4000-8000-000000000088",
      total_cost_usd: 0.5,
    });
    return;
  }

  emit({ type: "thought", data: "." });
  emit({ type: "text", data: "PONG" });
  emit({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "00000000-0000-4000-8000-000000000000",
    total_cost_usd: 0.05,
    num_turns: 1,
  });
}

async function main() {
  if (isAcpStdio()) {
    await runAcp();
    return;
  }
  if (isVersionProbe()) {
    process.stdout.write("fake-grok 0.0.0-test\n");
    return;
  }
  await runHeadless();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
