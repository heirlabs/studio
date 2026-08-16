import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTunnelPlan } from "../../server/lib/tunnel.js";

describe("resolveTunnelPlan", () => {
  it("refuses to run at all with nothing configured", () => {
    const plan = resolveTunnelPlan({ env: {}, certExists: false, port: 3847 });
    assert.ok(plan.error);
    assert.equal(plan.mode, undefined);
    // the failure must be actionable
    assert.ok(plan.hints.some((h) => h.includes("CLOUDFLARE_TUNNEL_TOKEN")));
    assert.ok(plan.hints.some((h) => h.includes("cloudflared tunnel login")));
  });

  it("never falls back to a quick tunnel implicitly", () => {
    // even fully logged in, an unnamed run must not silently go throwaway
    const plan = resolveTunnelPlan({ env: {}, certExists: true, port: 3847 });
    assert.ok(plan.error);
    assert.notEqual(plan.mode, "quick");
  });

  it("uses a quick tunnel only when explicitly asked", () => {
    const plan = resolveTunnelPlan({
      env: { HEIR_STUDIO_TUNNEL_QUICK: "1" },
      certExists: false,
      port: 3847,
    });
    assert.equal(plan.mode, "quick");
    assert.equal(plan.url, null, "a quick URL is discovered at runtime");
    assert.deepEqual(plan.args, [
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:3847",
    ]);
  });

  describe("dashboard-managed (token)", () => {
    it("runs by token and derives a stable https URL", () => {
      const plan = resolveTunnelPlan({
        env: {
          CLOUDFLARE_TUNNEL_TOKEN: "tok123",
          HEIR_STUDIO_TUNNEL_HOSTNAME: "agent.example.com",
        },
        certExists: false,
        port: 3847,
      });
      assert.equal(plan.mode, "token");
      assert.equal(plan.url, "https://agent.example.com");
      assert.deepEqual(plan.args, [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--token",
        "tok123",
      ]);
      // ingress is configured in Cloudflare, so no --url is passed
      assert.ok(!plan.args.includes("--url"));
    });

    it("needs no local cert", () => {
      const plan = resolveTunnelPlan({
        env: {
          CLOUDFLARE_TUNNEL_TOKEN: "tok",
          HEIR_STUDIO_TUNNEL_HOSTNAME: "a.example.com",
        },
        certExists: false,
      });
      assert.equal(plan.error, undefined);
    });

    it("refuses a token with no hostname, since pairing needs a URL", () => {
      const plan = resolveTunnelPlan({
        env: { CLOUDFLARE_TUNNEL_TOKEN: "tok" },
        certExists: false,
        port: 3847,
      });
      assert.ok(plan.error);
      assert.match(plan.error, /HEIR_STUDIO_TUNNEL_HOSTNAME/);
      assert.ok(plan.hints.some((h) => h.includes("127.0.0.1:3847")));
    });
  });

  describe("locally-managed (named)", () => {
    it("runs the named tunnel against the local port", () => {
      const plan = resolveTunnelPlan({
        env: {
          HEIR_STUDIO_TUNNEL_NAME: "heir-studio",
          HEIR_STUDIO_TUNNEL_HOSTNAME: "agent.example.com",
        },
        certExists: true,
        port: 4000,
      });
      assert.equal(plan.mode, "named");
      assert.equal(plan.url, "https://agent.example.com");
      assert.deepEqual(plan.args, [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--url",
        "http://127.0.0.1:4000",
        "heir-studio",
      ]);
    });

    it("explains how to log in when there is no cert", () => {
      const plan = resolveTunnelPlan({
        env: {
          HEIR_STUDIO_TUNNEL_NAME: "heir-studio",
          HEIR_STUDIO_TUNNEL_HOSTNAME: "agent.example.com",
        },
        certExists: false,
      });
      assert.ok(plan.error);
      assert.match(plan.error, /not logged in/);
      assert.ok(plan.hints.some((h) => h.includes("cloudflared tunnel login")));
      assert.ok(plan.hints.some((h) => h.includes("tunnel create heir-studio")));
    });

    it("explains how to route DNS when the hostname is missing", () => {
      const plan = resolveTunnelPlan({
        env: { HEIR_STUDIO_TUNNEL_NAME: "heir-studio" },
        certExists: true,
      });
      assert.ok(plan.error);
      assert.ok(plan.hints.some((h) => h.includes("route dns heir-studio")));
    });
  });

  it("prefers the dashboard token over a named tunnel", () => {
    const plan = resolveTunnelPlan({
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: "tok",
        HEIR_STUDIO_TUNNEL_NAME: "heir-studio",
        HEIR_STUDIO_TUNNEL_HOSTNAME: "a.example.com",
      },
      certExists: true,
    });
    assert.equal(plan.mode, "token");
  });

  it("ignores blank-string configuration", () => {
    const plan = resolveTunnelPlan({
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: "   ",
        HEIR_STUDIO_TUNNEL_NAME: "",
        HEIR_STUDIO_TUNNEL_HOSTNAME: "  ",
      },
      certExists: true,
    });
    assert.ok(plan.error, "whitespace must not count as configured");
  });
});
