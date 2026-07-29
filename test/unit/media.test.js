import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  encodeSessionCwd,
  harvestFromText,
  harvestFromSession,
  listMediaInDir,
  listAttachmentsInDir,
  copyMedia,
  isImageFile,
  isMediaFile,
  isTextAttachFile,
  isAttachmentFile,
  isAttachmentUpload,
  mediaKind,
} from "../../server/lib/media.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("media helpers", () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-media-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies extensions", () => {
    assert.equal(isImageFile("a.PNG"), true);
    assert.equal(isMediaFile("a.mp4"), true);
    assert.equal(isImageFile("a.txt"), false);
    assert.equal(isTextAttachFile("src/app.ts"), true);
    assert.equal(isTextAttachFile("Dockerfile"), true);
    assert.equal(isAttachmentFile("notes.md"), true);
    assert.equal(isAttachmentFile("virus.exe"), false);
    assert.equal(mediaKind("x.py"), "file");
    assert.equal(mediaKind("x.png"), "image");
    assert.ok(
      isAttachmentUpload({ mimetype: "text/plain", originalname: "a.txt" }),
    );
    assert.ok(
      isAttachmentUpload({ mimetype: "image/png", originalname: "a.png" }),
    );
    assert.equal(
      isAttachmentUpload({
        mimetype: "application/octet-stream",
        originalname: "bad.bin",
      }),
      false,
    );
  });

  it("lists text attachments alongside images", () => {
    const dir = path.join(tmp, "atts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.png"), TINY_PNG);
    fs.writeFileSync(path.join(dir, "note.md"), "# hi\n");
    const list = listAttachmentsInDir(dir, tmp);
    assert.ok(list.some((f) => f.name === "a.png" && f.kind === "image"));
    assert.ok(list.some((f) => f.name === "note.md" && f.kind === "file"));
  });

  it("encodeSessionCwd matches encodeURIComponent(resolve)", () => {
    const cwd = "/Users/futjr/grok-studio";
    assert.equal(encodeSessionCwd(cwd), encodeURIComponent(path.resolve(cwd)));
  });

  it("copyMedia writes unique file", () => {
    const src = path.join(tmp, "src.png");
    fs.writeFileSync(src, TINY_PNG);
    const destDir = path.join(tmp, "out");
    const a = copyMedia(src, destDir);
    const b = copyMedia(src, destDir);
    assert.notEqual(a, b);
    assert.ok(fs.existsSync(a));
    assert.equal(fs.readFileSync(a).length, TINY_PNG.length);
  });

  it("copyMedia throws on missing", () => {
    assert.throws(() => copyMedia(path.join(tmp, "nope.png"), tmp), /missing/);
  });

  it("harvestFromText finds OUTPUT paths", () => {
    const src = path.join(tmp, "gen.png");
    fs.writeFileSync(src, TINY_PNG);
    const dest = path.join(tmp, "harvest");
    const got = harvestFromText(`hello\nOUTPUT: ${src}\n`, dest);
    assert.equal(got.length, 1);
    assert.ok(fs.existsSync(got[0]));
  });

  it("harvestFromText ignores missing paths", () => {
    const dest = path.join(tmp, "harvest2");
    fs.mkdirSync(dest, { recursive: true });
    const got = harvestFromText("OUTPUT: /no/such/file.png\n", dest);
    assert.equal(got.length, 0);
  });

  it("harvestFromText finds saved-to quoted paths", () => {
    const src = path.join(tmp, "quoted.webp");
    fs.writeFileSync(src, TINY_PNG);
    const dest = path.join(tmp, "harvest3");
    const got = harvestFromText(`saved to \`${src}\``, dest);
    assert.equal(got.length, 1);
  });

  it("harvestFromSession uses sessionId layout", () => {
    const sessionsRoot = path.join(tmp, "sessions");
    const cwd = path.join(tmp, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const imgDir = path.join(
      sessionsRoot,
      encodeURIComponent(path.resolve(cwd)),
      sessionId,
      "images",
    );
    fs.mkdirSync(imgDir, { recursive: true });
    const shot = path.join(imgDir, "shot.png");
    fs.writeFileSync(shot, TINY_PNG);
    // touch mtime now
    const dest = path.join(tmp, "sess-out");
    const got = harvestFromSession({
      sessionsRoot,
      cwd,
      sessionId,
      sinceMs: Date.now() - 60_000,
      destDir: dest,
    });
    assert.equal(got.length, 1);
    assert.ok(fs.readFileSync(got[0]).equals(TINY_PNG));
  });

  it("harvestFromSession skips old files", () => {
    const sessionsRoot = path.join(tmp, "sessions-old");
    const cwd = path.join(tmp, "workspace-old");
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const imgDir = path.join(
      sessionsRoot,
      encodeURIComponent(path.resolve(cwd)),
      sessionId,
      "images",
    );
    fs.mkdirSync(imgDir, { recursive: true });
    const shot = path.join(imgDir, "old.png");
    fs.writeFileSync(shot, TINY_PNG);
    const past = Date.now() - 120_000;
    fs.utimesSync(shot, past / 1000, past / 1000);
    const dest = path.join(tmp, "sess-old-out");
    const got = harvestFromSession({
      sessionsRoot,
      cwd,
      sessionId,
      sinceMs: Date.now() - 10_000,
      destDir: dest,
    });
    assert.equal(got.length, 0);
  });

  it("listMediaInDir builds urls relative to data root", () => {
    const data = path.join(tmp, "data");
    const uploads = path.join(data, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, "a.png"), TINY_PNG);
    const list = listMediaInDir(uploads, data);
    assert.equal(list.length, 1);
    assert.equal(list[0].url, "/files/uploads/a.png");
    assert.equal(list[0].kind, "image");
  });
});
