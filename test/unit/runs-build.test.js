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
