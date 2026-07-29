#!/usr/bin/env node
/**
 * Fake grok binary for integration tests.
 * Modes via env:
 *   FAKE_GROK_MODE=pong|image|fail|slow|stderr|tools|acp-permission
 *   FAKE_GROK_IMAGE_DIR=path
 *   FAKE_GROK_SLEEP_MS=N
 *
 * Also supports: `fake-grok agent stdio` (JSON-RPC ACP for interactive tests).
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

async function runAcp() {
  const rl = readline.createInterface({ input: process.stdin });
  let sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let yolo = process.argv.includes("--always-approve");
  const pending = new Map();

  const respond = (id, result) => {
    emit({ jsonrpc: "2.0", id, result });
  };

  const notify = (method, params) => {
    emit({ jsonrpc: "2.0", method, params });
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Permission response from client
    if (msg.id != null && msg.result && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      waiter(msg.result);
      continue;
    }

    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
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

    if (msg.method === "session/cancel") {
      continue;
    }

    if (msg.method === "session/prompt") {
      // Must not await permission inside the read loop — that deadlocks stdin.
      void (async () => {
        const promptId = msg.id;
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "acp-think" },
          },
        });

        if (!yolo && (mode === "acp-permission" || mode === "default")) {
          const permId = 9001;
          const permPromise = new Promise((resolve) => {
            pending.set(permId, resolve);
          });
          emit({
            jsonrpc: "2.0",
            id: permId,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: {
                toolCallId: "tc-1",
                title: "run_terminal_command",
                kind: "execute",
                status: "pending",
                rawInput: { command: "echo hi" },
              },
              options: [
                {
                  optionId: "allow-once",
                  name: "Allow once",
                  kind: "allow_once",
                },
                {
                  optionId: "reject-once",
                  name: "Reject",
                  kind: "reject_once",
                },
              ],
            },
          });
          const decision = await Promise.race([
            permPromise,
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ outcome: { outcome: "cancelled" } }),
                12000,
              ),
            ),
          ]);

          const selected =
            decision?.outcome?.outcome === "selected"
              ? decision.outcome.optionId
              : null;
          if (selected === "allow-once" || String(selected || "").includes("allow")) {
            notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-1",
                title: "run_terminal_command",
                status: "completed",
                rawInput: { command: "echo hi" },
              },
            });
            notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "ALLOWED_PONG" },
              },
            });
          } else {
            notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "DENIED_PONG" },
              },
            });
          }
        } else {
          notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "ACP_PONG" },
            },
          });
        }

        respond(promptId, { stopReason: "end_turn" });
        setTimeout(() => process.exit(0), 50);
      })();
      continue;
    }
  }
}

async function runHeadless() {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write("fake-grok 0.0.0-test\n");
    return;
  }

  if (sleepMs > 0) {
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
    const sessionsRoot = process.env.FAKE_GROK_SESSIONS_ROOT;
    const cwd = process.env.FAKE_GROK_CWD;
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const parent = path.join(
      sessionsRoot,
      encodeURIComponent(path.resolve(cwd)),
    );
    const imgDir = path.join(parent, sessionId, "images");
    const out = path.join(imgDir, "session-shot.png");
    tinyPng(out);
    emit({ type: "text", data: "Saved session image.\n" });
    emit({ type: "end", stopReason: "EndTurn", sessionId });
    return;
  }

  if (mode === "tools") {
    emit({ type: "thought", data: "planning tools" });
    emit({
      type: "tool_call",
      name: "read_file",
      input: { target_file: "src/app.js", limit: 50 },
    });
    emit({
      type: "tool_result",
      name: "read_file",
      result: "export function app() { return 1; }",
    });
    emit({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "00000000-0000-4000-8000-000000000077",
      total_cost_usd: 0.12,
      num_turns: 2,
    });
    // text after tools for harvest-friendly path
    // (emit text before end for stream consumers)
    return;
  }

  if (mode === "tools") {
    // unreachable guard
  }

  // tools mode needs text - fix above
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

// Fix tools mode properly in main branch
async function main() {
  if (isAcpStdio()) {
    await runAcp();
    return;
  }

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write("fake-grok 0.0.0-test\n");
    return;
  }

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
    const sessionsRoot = process.env.FAKE_GROK_SESSIONS_ROOT;
    const cwd = process.env.FAKE_GROK_CWD;
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const parent = path.join(
      sessionsRoot,
      encodeURIComponent(path.resolve(cwd)),
    );
    const imgDir = path.join(parent, sessionId, "images");
    const out = path.join(imgDir, "session-shot.png");
    tinyPng(out);
    emit({ type: "text", data: "Saved session image.\n" });
    emit({ type: "end", stopReason: "EndTurn", sessionId });
    return;
  }

  if (mode === "tools") {
    emit({ type: "thought", data: "planning tools" });
    emit({
      type: "tool_call",
      name: "read_file",
      input: { target_file: "src/app.js", limit: 50 },
    });
    emit({
      type: "tool_result",
      name: "read_file",
      result: "export function app() { return 1; }",
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
    // Emit many tool_calls so mid-run budget can fire
    for (let i = 0; i < 5; i++) {
      emit({
        type: "tool_call",
        name: "read_file",
        input: { target_file: `f${i}.js` },
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
