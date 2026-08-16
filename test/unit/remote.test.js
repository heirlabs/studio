import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  TAILSCALE_CIDRS,
  normalizeIp,
  ipToBytes,
  ipInCidr,
  isAllowedRemoteIp,
  secretsMatch,
  parseBearer,
  generateToken,
  loadOrCreateToken,
  rotateToken,
  evaluateAccess,
  detectTailnetAddress,
  createAuthThrottle,
  parseCookieValue,
  presentedToken,
  requestLooksTunneled,
} from "../../server/lib/remote.js";

describe("ip parsing", () => {
  it("unwraps IPv4-mapped IPv6 and strips zone ids", () => {
    assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeIp("fe80::1%en0"), "fe80::1");
    assert.equal(normalizeIp("  100.101.102.103 "), "100.101.102.103");
  });

  it("rejects malformed addresses", () => {
    assert.equal(ipToBytes("999.1.1.1"), null);
    assert.equal(ipToBytes("1.2.3"), null);
    assert.equal(ipToBytes("not-an-ip"), null);
    assert.equal(ipToBytes("::1::2"), null);
    assert.equal(ipToBytes(""), null);
  });

  it("parses IPv6 including compressed forms", () => {
    assert.equal(ipToBytes("::1").length, 16);
    assert.equal(ipToBytes("fd7a:115c:a1e0::1").length, 16);
    assert.deepEqual(Array.from(ipToBytes("::1").slice(14)), [0, 1]);
  });
});

describe("ipInCidr", () => {
  it("matches inside and rejects outside a v4 block", () => {
    assert.equal(ipInCidr("100.64.0.1", "100.64.0.0/10"), true);
    assert.equal(ipInCidr("100.127.255.254", "100.64.0.0/10"), true);
    // just below and just above the block
    assert.equal(ipInCidr("100.63.255.255", "100.64.0.0/10"), false);
    assert.equal(ipInCidr("100.128.0.0", "100.64.0.0/10"), false);
  });

  it("respects non-byte-aligned prefixes", () => {
    assert.equal(ipInCidr("192.168.1.5", "192.168.1.0/29"), true);
    assert.equal(ipInCidr("192.168.1.9", "192.168.1.0/29"), false);
  });

  it("never matches across address families", () => {
    assert.equal(ipInCidr("100.64.0.1", "fd7a:115c:a1e0::/48"), false);
    assert.equal(ipInCidr("fd7a:115c:a1e0::1", "100.64.0.0/10"), false);
  });

  it("matches the Tailscale v6 prefix", () => {
    assert.equal(ipInCidr("fd7a:115c:a1e0::abcd", "fd7a:115c:a1e0::/48"), true);
    assert.equal(ipInCidr("fd7a:115c:a1e1::1", "fd7a:115c:a1e0::/48"), false);
  });

  it("rejects a malformed cidr rather than matching it", () => {
    assert.equal(ipInCidr("10.0.0.1", "10.0.0.0/99"), false);
    assert.equal(ipInCidr("10.0.0.1", "garbage/8"), false);
    assert.equal(ipInCidr("10.0.0.1", ""), false);
  });

  it("public addresses are not in the tailnet range", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "192.168.1.10"]) {
      assert.equal(isAllowedRemoteIp(ip, TAILSCALE_CIDRS), false, ip);
    }
    assert.equal(isAllowedRemoteIp("100.100.5.5", TAILSCALE_CIDRS), true);
  });
});

describe("token handling", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-tok-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("generates long, unique, url-safe tokens", () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 42, `token too short: ${a.length}`);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });

  it("persists a token 0600 and reuses it", () => {
    const first = loadOrCreateToken(dir);
    const second = loadOrCreateToken(dir);
    assert.equal(first.token, second.token);
    const mode = fs.statSync(path.join(dir, "remote-access.json")).mode & 0o777;
    assert.equal(mode, 0o600, `token file mode was ${mode.toString(8)}`);
  });

  it("rotation invalidates the previous token", () => {
    const before = loadOrCreateToken(dir).token;
    const after = rotateToken(dir).token;
    assert.notEqual(before, after);
    assert.equal(loadOrCreateToken(dir).token, after);
    assert.equal(secretsMatch(before, after), false);
  });

  it("compares secrets safely, including length mismatch", () => {
    assert.equal(secretsMatch("abc", "abc"), true);
    assert.equal(secretsMatch("abc", "abcd"), false);
    assert.equal(secretsMatch("", ""), false);
    assert.equal(secretsMatch(null, "abc"), false);
    assert.equal(secretsMatch("abc", undefined), false);
  });

  it("parses only well-formed bearer headers", () => {
    assert.equal(parseBearer("Bearer xyz"), "xyz");
    assert.equal(parseBearer("bearer  xyz  "), "xyz");
    assert.equal(parseBearer("Basic xyz"), null);
    assert.equal(parseBearer(""), null);
    assert.equal(parseBearer(undefined), null);
  });
});

describe("evaluateAccess", () => {
  const token = "s3cret-token";
  const base = {
    remoteEnabled: true,
    allowedCidrs: TAILSCALE_CIDRS,
    token,
  };

  it("lets loopback through with no token at all", () => {
    const v = evaluateAccess({
      ...base,
      ip: "127.0.0.1",
      isLoopbackIp: true,
      authorization: undefined,
    });
    assert.deepEqual(v, { allow: true, remote: false });
  });

  it("loopback is allowed even when remote access is disabled", () => {
    const v = evaluateAccess({
      ...base,
      remoteEnabled: false,
      ip: "127.0.0.1",
      isLoopbackIp: true,
    });
    assert.equal(v.allow, true);
  });

  it("refuses every remote client when remote access is off", () => {
    const v = evaluateAccess({
      ...base,
      remoteEnabled: false,
      ip: "100.64.0.9",
      isLoopbackIp: false,
      authorization: `Bearer ${token}`,
    });
    assert.equal(v.allow, false);
    assert.equal(v.status, 403);
  });

  it("refuses an address outside the allowed range even with a valid token", () => {
    const v = evaluateAccess({
      ...base,
      ip: "203.0.113.7",
      isLoopbackIp: false,
      authorization: `Bearer ${token}`,
    });
    assert.equal(v.allow, false);
    assert.equal(v.status, 403);
    assert.match(v.error, /outside the allowed remote range/);
  });

  it("refuses an in-range address with no token", () => {
    const v = evaluateAccess({
      ...base,
      ip: "100.64.0.9",
      isLoopbackIp: false,
      authorization: undefined,
    });
    assert.equal(v.allow, false);
    assert.equal(v.status, 401);
    assert.match(v.error, /Missing bearer token/);
  });

  it("refuses an in-range address with the wrong token", () => {
    const v = evaluateAccess({
      ...base,
      ip: "100.64.0.9",
      isLoopbackIp: false,
      authorization: "Bearer not-the-token",
    });
    assert.equal(v.allow, false);
    assert.equal(v.status, 401);
    assert.match(v.error, /Invalid bearer token/);
  });

  it("admits an in-range address with the right token and marks it remote", () => {
    const v = evaluateAccess({
      ...base,
      ip: "100.64.0.9",
      isLoopbackIp: false,
      authorization: `Bearer ${token}`,
    });
    assert.deepEqual(v, { allow: true, remote: true });
  });

  it("admits a tailnet IPv6 client", () => {
    const v = evaluateAccess({
      ...base,
      ip: "fd7a:115c:a1e0::5",
      isLoopbackIp: false,
      authorization: `Bearer ${token}`,
    });
    assert.equal(v.allow, true);
  });
});

describe("detectTailnetAddress", () => {
  it("finds the CGNAT address among real-looking interfaces", () => {
    const ip = detectTailnetAddress({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
    });
    assert.equal(ip, "100.101.102.103");
  });

  it("returns null when Tailscale is not up", () => {
    assert.equal(
      detectTailnetAddress({
        en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      }),
      null,
    );
    assert.equal(detectTailnetAddress({}), null);
    assert.equal(detectTailnetAddress(null), null);
  });

  it("ignores internal interfaces", () => {
    assert.equal(
      detectTailnetAddress({
        fake: [{ address: "100.64.0.1", family: "IPv4", internal: true }],
      }),
      null,
    );
  });
});

describe("auth throttle", () => {
  it("allows traffic until the failure budget is spent", () => {
    const t = createAuthThrottle({ maxFailures: 3, windowMs: 1000, lockoutMs: 500 });
    assert.equal(t.check(0).blocked, false);
    t.recordFailure(0);
    t.recordFailure(1);
    assert.equal(t.check(2).blocked, false);
    const last = t.recordFailure(2);
    assert.equal(last.locked, true);
    assert.equal(t.check(3).blocked, true);
  });

  it("reports how long to wait", () => {
    const t = createAuthThrottle({ maxFailures: 1, lockoutMs: 5000 });
    t.recordFailure(1000);
    const { blocked, retryAfterMs } = t.check(2000);
    assert.equal(blocked, true);
    assert.equal(retryAfterMs, 4000);
  });

  it("unlocks once the lockout elapses", () => {
    const t = createAuthThrottle({ maxFailures: 1, lockoutMs: 500 });
    t.recordFailure(0);
    assert.equal(t.check(400).blocked, true);
    assert.equal(t.check(600).blocked, false);
  });

  it("forgets failures older than the window", () => {
    const t = createAuthThrottle({ maxFailures: 3, windowMs: 1000, lockoutMs: 500 });
    t.recordFailure(0);
    t.recordFailure(100);
    // this one is outside the window of the first two
    const r = t.recordFailure(2000);
    assert.equal(r.locked, false);
    assert.equal(t.check(2000).blocked, false);
  });

  it("a success clears accumulated failures", () => {
    const t = createAuthThrottle({ maxFailures: 2, lockoutMs: 500 });
    t.recordFailure(0);
    t.recordSuccess();
    assert.equal(t.recordFailure(1).locked, false);
    assert.equal(t.check(1).blocked, false);
  });
});

describe("tunnel deployment mode (trustLoopback: false)", () => {
  const base = { remoteEnabled: true, allowedCidrs: TAILSCALE_CIDRS, token: "tok", trustLoopback: false };

  it("a tunnelled request (appears as loopback) still needs the token", () => {
    const v = evaluateAccess({ ...base, ip: "127.0.0.1", isLoopbackIp: true, viaTunnel: true });
    assert.equal(v.allow, false);
    assert.equal(v.status, 401);
  });

  it("a tunnelled request with the token is admitted and marked remote", () => {
    const v = evaluateAccess({
      ...base, ip: "127.0.0.1", isLoopbackIp: true, viaTunnel: true, authorization: "Bearer tok",
    });
    assert.deepEqual(v, { allow: true, remote: true });
  });

  it("accepts the stream cookie the same as a bearer header", () => {
    const v = evaluateAccess({
      ...base, ip: "127.0.0.1", isLoopbackIp: true, viaTunnel: true, cookie: "heir_stream=tok",
    });
    assert.deepEqual(v, { allow: true, remote: true });
  });

  it("a local Electron window that presents the token is still local", () => {
    const v = evaluateAccess({
      ...base, ip: "127.0.0.1", isLoopbackIp: true, viaTunnel: false, authorization: "Bearer tok",
    });
    assert.deepEqual(v, { allow: true, remote: false });
  });

  it("skips the range check, since the tunnel is the only peer", () => {
    assert.equal(
      evaluateAccess({
        ...base, ip: "127.0.0.1", isLoopbackIp: true, viaTunnel: true, authorization: "Bearer tok",
      }).allow,
      true,
    );
  });

  it("still refuses everything when remote access is off", () => {
    const v = evaluateAccess({
      ...base, remoteEnabled: false, ip: "127.0.0.1", isLoopbackIp: true, authorization: "Bearer tok",
    });
    assert.equal(v.allow, false);
    assert.equal(v.status, 403);
  });
});

describe("cookie / tunnel helpers", () => {
  it("parses heir_stream out of a cookie header", () => {
    assert.equal(parseCookieValue("a=1; heir_stream=abc%2B1; b=2", "heir_stream"), "abc+1");
    assert.equal(parseCookieValue("", "heir_stream"), null);
  });

  it("prefers the Authorization header over the cookie", () => {
    assert.equal(
      presentedToken({ authorization: "Bearer from-header", cookie: "heir_stream=from-cookie" }),
      "from-header",
    );
    assert.equal(presentedToken({ cookie: "heir_stream=from-cookie" }), "from-cookie");
  });

  it("detects Cloudflare-terminated requests", () => {
    assert.equal(requestLooksTunneled({ headers: { "cf-ray": "abc" } }), true);
    assert.equal(requestLooksTunneled({ headers: {} }), false);
  });
});
