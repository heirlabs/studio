import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertCanCompact,
  applyCompactResult,
  sessionContext,
} from "../../server/lib/compact.js";

describe("assertCanCompact", () => {
  it("404s when the session is missing", () => {
    assert.throws(() => assertCanCompact(null), (err) => err.status === 404);
  });

  it("409s while a run is live", () => {
    assert.throws(
      () =>
        assertCanCompact({
          id: "s",
          activeRunId: "r1",
          grokSessionId: "g",
        }),
      (err) => err.status === 409 && /live/.test(err.message),
    );
  });

  it("409s when Grok has no session id yet", () => {
    assert.throws(
      () => assertCanCompact({ id: "s", activeRunId: null, grokSessionId: null }),
      (err) => err.status === 409 && /No Grok session/.test(err.message),
    );
  });

  it("allows an idle session that has a grok id", () => {
    assert.doesNotThrow(() =>
      assertCanCompact({
        id: "s",
        activeRunId: null,
        grokSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    );
  });
});

describe("applyCompactResult", () => {
  it("computes percent from before/after tokens", () => {
    const ctx = applyCompactResult({
      tokensBefore: 80000,
      tokensAfter: 12000,
      note: "keep auth",
      trigger: "manual",
    });
    assert.equal(ctx.used, 12000);
    assert.equal(ctx.total, 80000);
    assert.equal(ctx.percent, 15);
    assert.equal(ctx.lastNote, "keep auth");
    assert.equal(ctx.trigger, "manual");
    assert.ok(ctx.compactedAt);
  });

  it("does not invent a percent when both counts are missing", () => {
    const ctx = applyCompactResult({});
    assert.equal(ctx.percent, 0);
    assert.equal(ctx.tokensBefore, null);
    assert.equal(ctx.tokensAfter, null);
  });
});

describe("sessionContext", () => {
  it("returns stored context or an empty shell", () => {
    assert.equal(sessionContext({ context: { percent: 40 } }).percent, 40);
    assert.equal(sessionContext({}).percent, null);
    assert.equal(sessionContext(null).used, null);
  });
});
