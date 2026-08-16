import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  expandHome,
  listDirectories,
  listEntries,
  readFileText,
} from "../../server/lib/fs-browse.js";

describe("expandHome", () => {
  const home = "/Users/tester";
  it("treats empty and ~ as home", () => {
    assert.equal(expandHome("", home), home);
    assert.equal(expandHome("~", home), home);
    assert.equal(expandHome("~/", home), home);
  });
  it("expands ~/subdir", () => {
    assert.equal(expandHome("~/code", home), path.join(home, "code"));
  });
  it("leaves absolute paths alone", () => {
    assert.equal(expandHome("/tmp/x", home), "/tmp/x");
  });
});

describe("listDirectories", () => {
  it("lists only directories and skips dotfiles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fs-"));
    fs.mkdirSync(path.join(root, "visible"));
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    const listing = listDirectories(root, { home: os.homedir() });
    assert.equal(listing.path, path.resolve(root));
    assert.deepEqual(
      listing.entries.map((e) => e.name),
      ["visible"],
    );
    assert.equal(listing.entries[0].type, "dir");
    assert.equal(listing.entries[0].path, path.join(root, "visible"));
    assert.ok(listing.parent);
  });

  it("rejects a missing path", () => {
    assert.throws(() => listDirectories("/no/such/heir-studio-dir"), {
      status: 400,
    });
  });

  it("rejects a file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fs-"));
    const file = path.join(root, "only.txt");
    fs.writeFileSync(file, "x");
    assert.throws(() => listDirectories(file), { status: 400 });
  });
});

describe("listEntries", () => {
  it("lists directories and files, with size on files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fs-ent-"));
    fs.mkdirSync(path.join(root, "visible"));
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, "file.txt"), "hello");
    fs.writeFileSync(path.join(root, ".secret"), "nope");
    const listing = listEntries(root, { home: os.homedir() });
    assert.equal(listing.path, path.resolve(root));
    const names = listing.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["file.txt", "visible"]);
    const file = listing.entries.find((e) => e.name === "file.txt");
    const dir = listing.entries.find((e) => e.name === "visible");
    assert.equal(file.type, "file");
    assert.equal(file.size, Buffer.byteLength("hello"));
    assert.equal(dir.type, "dir");
    assert.equal(dir.size, undefined);
  });

  it("rejects a missing path", () => {
    assert.throws(() => listEntries("/no/such/heir-studio-dir"), { status: 400 });
  });
});

describe("readFileText", () => {
  it("returns utf8 text and a resolved path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fs-read-"));
    const file = path.join(root, "note.txt");
    fs.writeFileSync(file, "payload");
    const result = readFileText(file);
    assert.equal(result.path, path.resolve(file));
    assert.equal(result.text, "payload");
    assert.equal(result.truncated, false);
  });

  it("refuses a missing file", () => {
    assert.throws(() => readFileText("/no/such/heir-studio-file.txt"), {
      status: 404,
    });
  });

  it("refuses a directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fs-dir-"));
    assert.throws(() => readFileText(root), { status: 400, message: /Not a file/ });
  });

  it("refuses a file larger than maxBytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fs-big-"));
    const file = path.join(root, "big.txt");
    fs.writeFileSync(file, "abcdefghij");
    assert.throws(() => readFileText(file, { maxBytes: 4 }), {
      status: 400,
      message: /too large/,
    });
  });
});
