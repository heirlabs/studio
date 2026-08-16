import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createSession,
  getSession,
  appendUserMessage,
  appendAssistantPlaceholder,
  finalizeAssistantMessage,
  listRewindPoints,
  rewindToMessage,
  setSessionActiveRun,
} from "../../server/lib/sessions.js";

function tmpData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-rw-"));
  return dir;
}

describe("rewindToMessage", () => {
  it("keeps the chosen user turn and drops later messages", () => {
    const data = tmpData();
    const s = createSession(data, { title: "t", cwd: data });
    const a = appendUserMessage(data, s.id, { text: "first" }).message;
    const asst = appendAssistantPlaceholder(data, s.id, {}).message;
    finalizeAssistantMessage(data, s.id, asst.id, { text: "ok", status: "ok" });
    appendUserMessage(data, s.id, { text: "second" });
    const points = listRewindPoints(getSession(data, s.id));
    assert.equal(points.length, 2);
    assert.equal(points[0].id, a.id);

    const { session, userIndex } = rewindToMessage(data, s.id, a.id);
    assert.equal(userIndex, 0);
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].text, "first");
    assert.match(session.lastPreview, /first/);
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("refuses rewind while a run is live", () => {
    const data = tmpData();
    const s = createSession(data, { title: "t", cwd: data });
    const a = appendUserMessage(data, s.id, { text: "first" }).message;
    setSessionActiveRun(data, s.id, "run-1");
    assert.throws(() => rewindToMessage(data, s.id, a.id), /live/);
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("404s a missing user message", () => {
    const data = tmpData();
    const s = createSession(data, { title: "t", cwd: data });
    assert.throws(() => rewindToMessage(data, s.id, "nope"), /not found/);
    fs.rmSync(data, { recursive: true, force: true });
  });
});
