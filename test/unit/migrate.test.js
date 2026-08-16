import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  migrateDir,
  migrateHomeConfig,
  migrateAppSupport,
} from "../../server/lib/migrate.js";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-mig-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(dir, files = { "a.json": "{}" }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("migrateDir", () => {
  it("moves a populated legacy directory", () => {
    const from = seed(path.join(tmp, "old"), { "settings.json": '{"a":1}' });
    const to = path.join(tmp, "new");
    const r = migrateDir(from, to);
    assert.equal(r.migrated, true);
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.readFileSync(path.join(to, "settings.json"), "utf8"), '{"a":1}');
  });

  it("never overwrites an existing destination", () => {
    const from = seed(path.join(tmp, "old"), { "x.json": "legacy" });
    const to = seed(path.join(tmp, "new"), { "x.json": "current" });
    const r = migrateDir(from, to);
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "destination exists");
    // both sides untouched
    assert.equal(fs.readFileSync(path.join(to, "x.json"), "utf8"), "current");
    assert.equal(fs.readFileSync(path.join(from, "x.json"), "utf8"), "legacy");
  });

  it("does nothing when there is no legacy directory", () => {
    const r = migrateDir(path.join(tmp, "missing"), path.join(tmp, "new"));
    assert.equal(r.migrated, false);
    assert.equal(fs.existsSync(path.join(tmp, "new")), false);
  });

  it("leaves an empty legacy directory alone", () => {
    fs.mkdirSync(path.join(tmp, "old"), { recursive: true });
    const r = migrateDir(path.join(tmp, "old"), path.join(tmp, "new"));
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "source is empty");
  });

  it("refuses when the source is a file, not a directory", () => {
    fs.writeFileSync(path.join(tmp, "old"), "not a dir");
    const r = migrateDir(path.join(tmp, "old"), path.join(tmp, "new"));
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "source is not a directory");
  });

  it("is idempotent — a second run is a no-op", () => {
    const from = seed(path.join(tmp, "old"));
    const to = path.join(tmp, "new");
    assert.equal(migrateDir(from, to).migrated, true);
    assert.equal(migrateDir(from, to).migrated, false);
  });

  it("preserves nested content", () => {
    const from = path.join(tmp, "old");
    fs.mkdirSync(path.join(from, "runs", "abc"), { recursive: true });
    fs.writeFileSync(path.join(from, "runs", "abc", "meta.json"), '{"id":"abc"}');
    const to = path.join(tmp, "new");
    migrateDir(from, to);
    assert.equal(
      fs.readFileSync(path.join(to, "runs", "abc", "meta.json"), "utf8"),
      '{"id":"abc"}',
    );
  });
});

describe("migrateHomeConfig", () => {
  it("moves ~/.grok-studio to ~/.heir-studio", () => {
    seed(path.join(tmp, ".grok-studio"), { "settings.json": '{"model":"x"}' });
    const r = migrateHomeConfig(tmp);
    assert.equal(r.migrated, true);
    assert.equal(
      fs.readFileSync(path.join(tmp, ".heir-studio", "settings.json"), "utf8"),
      '{"model":"x"}',
    );
  });

  it("does not clobber an existing ~/.heir-studio", () => {
    seed(path.join(tmp, ".grok-studio"), { "settings.json": "old" });
    seed(path.join(tmp, ".heir-studio"), { "settings.json": "new" });
    assert.equal(migrateHomeConfig(tmp).migrated, false);
    assert.equal(
      fs.readFileSync(path.join(tmp, ".heir-studio", "settings.json"), "utf8"),
      "new",
    );
  });
});

describe("migrateAppSupport", () => {
  it("adopts the lowercase legacy app directory", () => {
    seed(path.join(tmp, "grok-studio", "data", "chat-sessions"), {
      "index.json": '{"sessions":[]}',
    });
    const r = migrateAppSupport(tmp, "heir-studio");
    assert.equal(r.migrated, true);
    assert.ok(
      fs.existsSync(
        path.join(tmp, "heir-studio", "data", "chat-sessions", "index.json"),
      ),
    );
  });

  it("adopts the display-name legacy directory too", () => {
    seed(path.join(tmp, "Grok Studio", "data"), { "recents.json": "{}" });
    const r = migrateAppSupport(tmp, "heir-studio");
    assert.equal(r.migrated, true);
    assert.ok(fs.existsSync(path.join(tmp, "heir-studio", "data", "recents.json")));
  });

  it("migrates only once, leaving the other legacy dir untouched", () => {
    seed(path.join(tmp, "grok-studio", "data"), { "a.json": "first" });
    seed(path.join(tmp, "Grok Studio", "data"), { "b.json": "second" });
    const r = migrateAppSupport(tmp, "heir-studio");
    assert.equal(r.migrated, true);
    assert.ok(fs.existsSync(path.join(tmp, "heir-studio", "data", "a.json")));
    // the unclaimed one is preserved for the user, not deleted
    assert.ok(fs.existsSync(path.join(tmp, "Grok Studio", "data", "b.json")));
  });

  it("is a no-op with no legacy data", () => {
    const r = migrateAppSupport(tmp, "heir-studio");
    assert.equal(r.migrated, false);
    assert.equal(fs.existsSync(path.join(tmp, "heir-studio")), false);
  });

  it("never treats the current name as legacy", () => {
    seed(path.join(tmp, "grok-studio", "data"), { "a.json": "x" });
    const r = migrateAppSupport(tmp, "grok-studio");
    assert.equal(r.migrated, false);
    assert.ok(fs.existsSync(path.join(tmp, "grok-studio", "data", "a.json")));
  });
});
