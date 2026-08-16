import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseGrokConfig,
  readCliApprovalPolicy,
  describeApprovalConflict,
  grokConfigPath,
} from "../../server/lib/cli-config.js";

function homeWith(toml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cli-"));
  if (toml != null) {
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    fs.writeFileSync(grokConfigPath(home), toml);
  }
  return home;
}

describe("parseGrokConfig", () => {
  it("reads quoted strings, booleans and ints, ignoring comments", () => {
    const cfg = parseGrokConfig(`
# a comment
auto_update = true
yolo = false
permission_mode = "always-approve"   # trailing comment
port = 8080
name = 'single'
`);
    assert.equal(cfg.auto_update, true);
    assert.equal(cfg.yolo, false);
    assert.equal(cfg.permission_mode, "always-approve");
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.name, "single");
  });

  it("skips section headers and malformed lines", () => {
    const cfg = parseGrokConfig("[cli]\nnot a pair\nkey = 1\n");
    assert.deepEqual(Object.keys(cfg), ["key"]);
  });

  it("handles empty input", () => {
    assert.deepEqual(parseGrokConfig(""), {});
    assert.deepEqual(parseGrokConfig(null), {});
  });
});

describe("readCliApprovalPolicy", () => {
  it("flags permission_mode = always-approve", () => {
    const home = homeWith('permission_mode = "always-approve"\n');
    const p = readCliApprovalPolicy(home);
    assert.equal(p.exists, true);
    assert.equal(p.permissionMode, "always-approve");
    assert.equal(p.forcesAlwaysApprove, true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("flags yolo = true even when permission_mode is unset", () => {
    const home = homeWith("yolo = true\n");
    const p = readCliApprovalPolicy(home);
    assert.equal(p.yolo, true);
    assert.equal(p.forcesAlwaysApprove, true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does not flag an interactive config", () => {
    const home = homeWith('yolo = false\npermission_mode = "default"\n');
    const p = readCliApprovalPolicy(home);
    assert.equal(p.forcesAlwaysApprove, false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reports a missing config without throwing", () => {
    const home = homeWith(null);
    const p = readCliApprovalPolicy(home);
    assert.equal(p.exists, false);
    assert.equal(p.forcesAlwaysApprove, false);
    assert.equal(p.path, grokConfigPath(home));
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("describeApprovalConflict", () => {
  const forced = {
    path: "/home/u/.grok/config.toml",
    exists: true,
    permissionMode: "always-approve",
    yolo: false,
    forcesAlwaysApprove: true,
  };

  it("warns for every mode that is supposed to prompt", () => {
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk"]) {
      const c = describeApprovalConflict(mode, forced);
      assert.equal(c.conflict, true, `${mode} should warn`);
      assert.match(c.message, /always-approve/);
      assert.match(c.message, new RegExp(mode));
    }
  });

  it("stays quiet when the user already chose bypass", () => {
    assert.equal(
      describeApprovalConflict("bypassPermissions", forced).conflict,
      false,
    );
    assert.equal(describeApprovalConflict("auto", forced).conflict, false);
  });

  it("stays quiet when the CLI is not forcing anything", () => {
    assert.equal(
      describeApprovalConflict("default", { forcesAlwaysApprove: false })
        .conflict,
      false,
    );
    assert.equal(describeApprovalConflict("default", null).conflict, false);
  });

  it("names yolo as the source when that is what is set", () => {
    const c = describeApprovalConflict("default", {
      ...forced,
      yolo: true,
      permissionMode: null,
    });
    assert.match(c.message, /yolo = true/);
  });
});
