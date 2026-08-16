import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  loadDevices,
  registerDevice,
  removeDevice,
  normalizeDeviceToken,
  createApnsJwt,
  sendPush,
  resolveApnsConfig,
  attachPushHooks,
  PUSH_CATEGORY,
  DEVICES_FILE,
} from "../../server/lib/push.js";

function tmpData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gs-push-"));
}

const HEX = "ab".repeat(32);

describe("normalizeDeviceToken", () => {
  it("accepts 64-char hex and lowercases it", () => {
    assert.equal(normalizeDeviceToken("AB".repeat(32)), HEX);
  });

  it("accepts the equivalent base64 token", () => {
    const b64 = Buffer.from(HEX, "hex").toString("base64");
    assert.equal(normalizeDeviceToken(b64), HEX);
  });

  it("rejects an empty token", () => {
    assert.throws(() => normalizeDeviceToken("  "), { status: 400 });
  });

  it("rejects garbage", () => {
    assert.throws(() => normalizeDeviceToken("not-a-token"), { status: 400 });
  });
});

describe("device registry", () => {
  it("registers, dedups hex/base64, and writes mode 0600", () => {
    const dir = tmpData();
    const first = registerDevice(dir, { token: HEX });
    assert.equal(first.token, HEX);
    assert.ok(first.addedAt);
    assert.equal(first.bundleId, "com.heir.studio.mobile");

    const b64 = Buffer.from(HEX, "hex").toString("base64");
    registerDevice(dir, { token: b64, bundleId: "com.heir.studio.mobile" });
    const devices = loadDevices(dir);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].token, HEX);

    const st = fs.statSync(path.join(dir, DEVICES_FILE));
    assert.equal(st.mode & 0o777, 0o600);

    const other = registerDevice(dir, { token: "cd".repeat(32) });
    assert.equal(other.token, "cd".repeat(32));
    assert.equal(loadDevices(dir).length, 2);
  });

  it("removes a token and is a no-op for an unknown one after that", () => {
    const dir = tmpData();
    registerDevice(dir, { token: HEX });
    const gone = removeDevice(dir, HEX);
    assert.equal(gone.ok, true);
    assert.equal(gone.removed, true);
    assert.deepEqual(loadDevices(dir), []);
    const again = removeDevice(dir, HEX);
    assert.equal(again.removed, false);
  });

  it("returns an empty list when the file is missing", () => {
    assert.deepEqual(loadDevices(tmpData()), []);
  });
});

describe("createApnsJwt", () => {
  it("signs ES256 with ieee-p1363 and the expected claims", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const now = 1_700_000_000;
    const jwt = createApnsJwt({
      keyPem: pem,
      keyId: "629PDCXMGR",
      teamId: "2Y8MR5FHTC",
      now,
    });
    const [h, p, s] = jwt.split(".");
    assert.ok(h && p && s);
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, "629PDCXMGR");
    assert.equal(payload.iss, "2Y8MR5FHTC");
    assert.equal(payload.iat, now);
    assert.equal(Buffer.from(s, "base64url").length, 64);
  });
});

describe("sendPush", () => {
  it("no-ops when the device list is empty and does not need a key", async () => {
    const result = await sendPush({ devices: [], title: "x", body: "y" });
    assert.deepEqual(result, { sent: 0, failed: 0, results: [] });
  });

  it("refuses to hit APNs without a key", async () => {
    await assert.rejects(
      () =>
        sendPush({
          devices: [{ token: HEX }],
          title: "x",
          body: "y",
          keyId: "ABC",
          teamId: "TEAM",
        }),
      { status: 503, message: /APNs key/ },
    );
  });
});

describe("resolveApnsConfig", () => {
  it("returns null when no key file exists", () => {
    const cfg = resolveApnsConfig({
      HEIR_STUDIO_APNS_CERT_PATH: "/no/such.crt",
      HEIR_STUDIO_APNS_TLS_KEY_PATH: "/no/such.key",
      HEIR_STUDIO_APNS_KEY_PATH: "/no/such/AuthKey_NONE.p8",
    });
    assert.equal(cfg, null);
  });

  it("reads key id from the filename and honours production host", () => {
    const dir = tmpData();
    const keyPath = path.join(dir, "AuthKey_ABCDEF1234.p8");
    fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n");
    const cfg = resolveApnsConfig({
      HEIR_STUDIO_APNS_CERT_PATH: "/no/such.crt",
      HEIR_STUDIO_APNS_TLS_KEY_PATH: "/no/such.key",
      HEIR_STUDIO_APNS_KEY_PATH: keyPath,
      HEIR_STUDIO_APNS_PRODUCTION: "1",
    });
    assert.equal(cfg.auth, "token");
    assert.equal(cfg.keyPath, keyPath);
    assert.equal(cfg.keyId, "ABCDEF1234");
    assert.equal(cfg.teamId, "2Y8MR5FHTC");
    assert.equal(cfg.bundleId, "com.heir.studio.mobile");
    assert.equal(cfg.production, true);
    assert.equal(cfg.host, "api.push.apple.com");
  });

  it("prefers the App ID TLS cert when the PEM pair is present", () => {
    const dir = tmpData();
    const certPath = path.join(dir, "aps.crt.pem");
    const tlsKeyPath = path.join(dir, "aps.key");
    fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----\n");
    fs.writeFileSync(tlsKeyPath, "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n");
    const cfg = resolveApnsConfig({
      HEIR_STUDIO_APNS_CERT_PATH: certPath,
      HEIR_STUDIO_APNS_TLS_KEY_PATH: tlsKeyPath,
    });
    assert.equal(cfg.auth, "cert");
    assert.equal(cfg.certPath, certPath);
    assert.equal(cfg.tlsKeyPath, tlsKeyPath);
    assert.equal(cfg.bundleId, "com.heir.studio.mobile");
    assert.equal(cfg.production, true);
    assert.equal(cfg.host, "api.push.apple.com");
  });
});

describe("attachPushHooks", () => {
  it("calls sendPush on permission_request and onFinish", async () => {
    const dir = tmpData();
    registerDevice(dir, { token: HEX });
    const sent = [];
    let captured;
    const runs = {
      startRun(opts) {
        captured = opts;
        return { id: "run-1", meta: { chatSessionId: "sess-1" } };
      },
    };
    const warns = [];
    attachPushHooks(runs, {
      dataDir: dir,
      log: { warn(_e, rec) { warns.push(rec); } },
      send: async (opts) => {
        sent.push(opts);
        return { sent: 1, failed: 0 };
      },
      resolveConfig: () => ({
        keyPath: "/tmp/fake.p8",
        keyId: "KID",
        teamId: "TEAM",
        bundleId: "com.heir.studio.mobile",
        production: false,
        host: "api.sandbox.push.apple.com",
      }),
    });

    const userEvents = [];
    runs.startRun({
      chatSessionId: "sess-1",
      prompt: "please ship it",
      onEvent: (e) => userEvents.push(e),
      onFinish: () => {},
    });

    captured.onEvent({
      type: "studio",
      event: "permission_request",
      id: 42,
      sessionId: "acp-sess",
      toolCall: { title: "bash", kind: "execute" },
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject-once", kind: "reject_once" },
      ],
    });
    captured.onFinish({ meta: { status: "completed", chatSessionId: "sess-1" } });

    await new Promise((r) => setImmediate(r));

    assert.equal(userEvents.length, 1);
    assert.equal(sent.length, 2);

    const perm = sent.find((s) => s.category === PUSH_CATEGORY.PERMISSION);
    assert.ok(perm);
    assert.equal(perm.title, "Permission needed");
    assert.equal(perm.body, "bash");
    assert.equal(perm.payload.sessionId, "sess-1");
    assert.equal(perm.payload.runId, "run-1");
    assert.equal(perm.payload.permissionId, "42");
    assert.equal(perm.payload.optionAllow, "allow-once");
    assert.equal(perm.payload.optionDeny, "reject-once");
    assert.equal(perm.devices[0].token, HEX);

    const run = sent.find((s) => s.category === PUSH_CATEGORY.RUN);
    assert.ok(run);
    assert.equal(run.title, "Run finished");
    assert.equal(run.payload.runId, "run-1");
    assert.equal(run.payload.sessionId, "sess-1");
    assert.equal(run.payload.status, "completed");
  });

  it("warns and does not call send when no devices are registered", async () => {
    const dir = tmpData();
    const sent = [];
    const warns = [];
    let captured;
    const runs = {
      startRun(opts) {
        captured = opts;
        return { id: "run-2", meta: {} };
      },
    };
    attachPushHooks(runs, {
      dataDir: dir,
      log: { warn(_e, rec) { warns.push(rec); } },
      send: async (opts) => {
        sent.push(opts);
      },
      resolveConfig: () => ({ keyPath: "/tmp/fake.p8" }),
    });
    runs.startRun({});
    captured.onEvent({
      type: "studio",
      event: "permission_request",
      id: "p",
      options: [],
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0);
    assert.ok(warns.some((w) => w.reason === "no devices"));
  });
});
