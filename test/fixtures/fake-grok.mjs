#!/usr/bin/env node
/**
 * Fake grok binary for integration tests.
 * Modes via env:
 *   FAKE_GROK_MODE=pong|image|fail|slow|stderr
 *   FAKE_GROK_IMAGE_DIR=path  (where to write a PNG for image mode)
 *   FAKE_GROK_SLEEP_MS=N
 */
import fs from "fs";
import path from "path";

const mode = process.env.FAKE_GROK_MODE || "pong";
const sleepMs = Number(process.env.FAKE_GROK_SLEEP_MS || 0);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function tinyPng(dest) {
  // 1x1 PNG
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b64, "base64"));
}

async function main() {
  // Support --version for health checks
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
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_GROK_SLEEP_MS || 2000)));
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
    // Write into sessionsRoot/encodedCwd/sessionId/images like real grok
    const sessionsRoot = process.env.FAKE_GROK_SESSIONS_ROOT;
    const cwd = process.env.FAKE_GROK_CWD;
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const parent = path.join(sessionsRoot, encodeURIComponent(path.resolve(cwd)));
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
    });
    return;
  }

  // default pong
  emit({ type: "thought", data: "." });
  emit({ type: "text", data: "PONG" });
  emit({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "00000000-0000-4000-8000-000000000000",
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
