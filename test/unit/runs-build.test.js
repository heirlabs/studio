import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveImages,
  buildPrompt,
  resolveProjectCwd,
  buildGrokArgs,
  normalizeStreamEvent,
} from "../../server/lib/runs.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("resolveImages", () => {
  it("resolves basename under uploads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-up-"));
    const f = path.join(dir, "photo.png");
    fs.writeFileSync(f, TINY_PNG);
    assert.deepEqual(resolveImages(["photo.png"], dir), [f]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves /files/uploads/ url form", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-up2-"));
    const f = path.join(dir, "x.jpg");
    fs.writeFileSync(f, TINY_PNG);
    assert.deepEqual(resolveImages(["/files/uploads/x.jpg"], dir), [f]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws when missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-up3-"));
    assert.throws(() => resolveImages(["nope.png"], dir), /not found/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blocks path traversal via relative ref", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-up4-"));
    assert.throws(
      () => resolveImages(["../../etc/passwd"], dir),
      /invalid image ref|not found/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildPrompt", () => {
  it("prefixes @ attachments and fills template", () => {
    const wf = {
      promptTemplate:
        "cwd={{cwd}}\nDo: {{prompt}}\n{{#if images}}Refs:\n{{images}}{{/if}}",
    };
    const text = buildPrompt({
      wf,
      prompt: "fix the bug",
      staged: ["/tmp/a.png"],
      aspect_ratio: "1:1",
      duration: "6",
      resolution: "480p",
      workflow_name: "",
      workflow_args: "{}",
      cwd: "/Users/me/proj",
    });
    assert.match(text, /^@\/tmp\/a\.png/);
    assert.match(text, /cwd=\/Users\/me\/proj/);
    assert.match(text, /Do: fix the bug/);
    assert.match(text, /Refs:\n1\. \/tmp\/a\.png/);
  });
});

describe("resolveProjectCwd", () => {
  it("resolves existing directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cwd-"));
    assert.equal(resolveProjectCwd(dir), path.resolve(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects missing path", () => {
    assert.throws(
      () => resolveProjectCwd("/tmp/does-not-exist-grok-studio-xyz"),
      /not found/,
    );
  });

  it("rejects empty", () => {
    assert.throws(() => resolveProjectCwd(""), /required/i);
  });

  it("rejects file path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cwd2-"));
    const f = path.join(dir, "file.txt");
    fs.writeFileSync(f, "x");
    assert.throws(() => resolveProjectCwd(f), /not a directory/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildGrokArgs streaming defaults", () => {
  it("always uses streaming-json output", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.txt",
      workDir: "/tmp/proj",
    });
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("streaming-json"));
    const i = args.indexOf("--prompt-file");
    assert.equal(args[i + 1], "/tmp/p.txt");
  });
});

describe("normalizeStreamEvent", () => {
  // Captured verbatim from grok 0.2.117 `--output-format streaming-json`.
  const REAL_TOOL_CALL = {
    type: "tool_call",
    toolCallId: "call-a98d299f-bcb3-4bf0-befc-c517c4464d96-0",
    title: "list_dir",
    kind: "list",
    status: "pending",
    toolName: "list_dir",
    rawInput: { target_directory: "." },
    content: [],
    locations: [],
  };

  it("gives real tool_call events the name/input the UI renders", () => {
    const out = normalizeStreamEvent(REAL_TOOL_CALL);
    assert.equal(out.type, "tool_call");
    assert.equal(out.name, "list_dir");
    assert.deepEqual(out.input, { target_directory: "." });
    // original fields are preserved for the run log
    assert.equal(out.toolCallId, REAL_TOOL_CALL.toolCallId);
    assert.equal(out.kind, "list");
  });

  it("maps tool_call_update onto tool_result", () => {
    const out = normalizeStreamEvent({
      type: "tool_call_update",
      toolCallId: "call-1",
      title: "read_file",
      status: "completed",
      rawOutput: "contents",
    });
    assert.equal(out.type, "tool_result");
    assert.equal(out.name, "read_file");
    assert.equal(out.result, "contents");
    assert.equal(out.status, "completed");
  });

  it("falls back through rawOutput → content → status", () => {
    assert.equal(
      normalizeStreamEvent({ type: "tool_call_update", content: "c" }).result,
      "c",
    );
    assert.equal(
      normalizeStreamEvent({ type: "tool_call_update", status: "failed" })
        .result,
      "failed",
    );
    assert.equal(normalizeStreamEvent({ type: "tool_call_update" }).result, null);
  });

  it("drops available_commands", () => {
    assert.equal(
      normalizeStreamEvent({ type: "available_commands", tools: [], commands: [] }),
      null,
    );
  });

  it("names an unlabelled tool call rather than emitting undefined", () => {
    assert.equal(normalizeStreamEvent({ type: "tool_call" }).name, "tool");
    assert.equal(normalizeStreamEvent({ type: "tool" }).name, "tool");
    assert.equal(normalizeStreamEvent({ type: "tool" }).type, "tool_call");
  });

  it("passes text, thought and end through untouched", () => {
    for (const evt of [
      { type: "text", data: "hi" },
      { type: "thought", data: "hmm" },
      { type: "end", stopReason: "end_turn", total_cost_usd: 0.0649208 },
      { type: "usage", usage: { input_tokens: 1 } },
    ]) {
      assert.deepEqual(normalizeStreamEvent(evt), evt);
    }
  });

  it("tolerates non-objects", () => {
    assert.equal(normalizeStreamEvent(null), null);
    assert.equal(normalizeStreamEvent("nope"), "nope");
  });
});

describe("normalizeStreamEvent tool correlation", () => {
  it("labels a title-less update from the call it belongs to", () => {
    const names = new Map();
    normalizeStreamEvent(
      { type: "tool_call", toolCallId: "c1", title: "list_dir" },
      names,
    );
    const upd = normalizeStreamEvent(
      { type: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "ok" },
      names,
    );
    assert.equal(upd.name, "list_dir");
    assert.equal(upd.result, "ok");
  });

  it("reports status instead of an empty content array", () => {
    const upd = normalizeStreamEvent({
      type: "tool_call_update",
      toolCallId: "c9",
      status: "in_progress",
      content: [],
    });
    assert.equal(upd.result, "in_progress");
  });

  it("keeps a non-empty content array as the result", () => {
    const upd = normalizeStreamEvent({
      type: "tool_call_update",
      content: [{ type: "ListDir" }],
    });
    assert.deepEqual(upd.result, [{ type: "ListDir" }]);
  });

  it("falls back to 'tool' for an update with no matching call", () => {
    assert.equal(
      normalizeStreamEvent({ type: "tool_call_update", toolCallId: "unknown" })
        .name,
      "tool",
    );
  });

  it("keeps names separate across concurrent tool calls", () => {
    const names = new Map();
    normalizeStreamEvent({ type: "tool_call", toolCallId: "a", title: "grep" }, names);
    normalizeStreamEvent({ type: "tool_call", toolCallId: "b", title: "write" }, names);
    assert.equal(
      normalizeStreamEvent({ type: "tool_call_update", toolCallId: "b" }, names).name,
      "write",
    );
    assert.equal(
      normalizeStreamEvent({ type: "tool_call_update", toolCallId: "a" }, names).name,
      "grep",
    );
  });
});
