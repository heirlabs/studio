import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES,
  normalizePermissionMode,
  cyclePermissionMode,
  permissionModeToCliArgs,
  isBypassMode,
} from "../../server/lib/permissions.js";

describe("permissions", () => {
  it("lists six modes", () => {
    assert.equal(PERMISSION_MODES.length, 6);
    assert.ok(PERMISSION_MODES.includes("plan"));
    assert.ok(PERMISSION_MODES.includes("bypassPermissions"));
  });

  it("normalizes legacy yolo aliases", () => {
    assert.equal(normalizePermissionMode("yolo"), "bypassPermissions");
    assert.equal(normalizePermissionMode("true"), "bypassPermissions");
    assert.equal(normalizePermissionMode("false"), "default");
    assert.equal(normalizePermissionMode(""), "default");
  });

  it("rejects unknown modes", () => {
    assert.throws(() => normalizePermissionMode("superuser"), /Invalid/);
  });

  it("cycles through all modes", () => {
    let m = "default";
    const seen = new Set();
    for (let i = 0; i < PERMISSION_MODES.length; i++) {
      m = cyclePermissionMode(m);
      seen.add(m);
    }
    assert.equal(seen.size, PERMISSION_MODES.length);
    assert.equal(cyclePermissionMode("bypassPermissions"), "default");
  });

  it("maps bypass to always-approve args", () => {
    const { args, alwaysApprove } = permissionModeToCliArgs("bypassPermissions");
    assert.equal(alwaysApprove, true);
    assert.ok(args.includes("--always-approve"));
    assert.ok(args.includes("bypassPermissions"));
  });

  it("maps plan without always-approve", () => {
    const { args, alwaysApprove } = permissionModeToCliArgs("plan");
    assert.equal(alwaysApprove, false);
    assert.deepEqual(args, ["--permission-mode", "plan"]);
  });

  it("detects bypass mode", () => {
    assert.equal(isBypassMode("bypassPermissions"), true);
    assert.equal(isBypassMode("default"), false);
  });
});
