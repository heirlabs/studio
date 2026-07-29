import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLoopback, isUuid, resolveGrokBin } from "../../server/lib/config.js";
import fs from "fs";
import os from "os";
import path from "path";

describe("isLoopback", () => {
  it("accepts ipv4 and ipv6 loopback forms", () => {
    assert.equal(isLoopback("127.0.0.1"), true);
    assert.equal(isLoopback("::1"), true);
    assert.equal(isLoopback("::ffff:127.0.0.1"), true);
    assert.equal(isLoopback(":ffff:127.0.0.1"), true);
  });
  it("rejects non-local", () => {
    assert.equal(isLoopback("192.168.1.1"), false);
    assert.equal(isLoopback("10.0.0.5"), false);
    assert.equal(isLoopback(""), false);
  });
});

describe("isUuid", () => {
  it("validates uuid v4 shape", () => {
    assert.equal(isUuid("5ceb4c6f-a5ca-4752-b25c-2b477cbe048c"), true);
    assert.equal(isUuid("not-a-uuid"), false);
    assert.equal(isUuid("../etc/passwd"), false);
    assert.equal(isUuid(""), false);
  });
});

describe("resolveGrokBin", () => {
  it("honors GROK_BIN env", () => {
    assert.equal(
      resolveGrokBin({ GROK_BIN: "/custom/grok" }, "/tmp"),
      "/custom/grok",
    );
  });

  it("finds home bin when present", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-home-"));
    const bin = path.join(home, ".grok", "bin", "grok");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\n");
    assert.equal(resolveGrokBin({}, home), bin);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
