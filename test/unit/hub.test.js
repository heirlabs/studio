import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { createHub, sessionHubPayload } from "../../server/lib/hub.js";

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.status = (n) => {
    res.statusCode = n;
    return res;
  };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.flushHeaders = () => {};
  res.write = (c) => {
    res.chunks.push(String(c));
    return true;
  };
  return res;
}

describe("hub", () => {
  it("fans an event out to every attached client", () => {
    const hub = createHub({ heartbeatMs: 60_000 });
    const a = fakeRes();
    const b = fakeRes();
    hub.attach(a);
    hub.attach(b);
    assert.equal(hub.size, 2);
    hub.publish({ type: "run", event: "started", sessionId: "s1", runId: "r1" });
    const hit = (res) =>
      res.chunks.some((c) => c.includes('"event":"started"') && c.includes("r1"));
    assert.equal(hit(a), true);
    assert.equal(hit(b), true);
  });

  it("drops a client when its response closes", () => {
    const hub = createHub({ heartbeatMs: 60_000 });
    const a = fakeRes();
    hub.attach(a);
    assert.equal(hub.size, 1);
    a.emit("close");
    assert.equal(hub.size, 0);
  });
});

describe("sessionHubPayload", () => {
  it("strips the transcript", () => {
    const p = sessionHubPayload({
      id: "x",
      title: "Hi",
      cwd: "/tmp",
      activeRunId: "r",
      updatedAt: 1,
      messages: [{ id: "m" }, { id: "n" }],
    });
    assert.equal(p.messageCount, 2);
    assert.equal(p.messages, undefined);
    assert.equal(p.title, "Hi");
  });
});
