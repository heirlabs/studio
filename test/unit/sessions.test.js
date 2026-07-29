import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createSession,
  listSessions,
  getSession,
  appendUserMessage,
  appendAssistantPlaceholder,
  attachRunToAssistantMessage,
  finalizeAssistantMessage,
  failAssistantMessage,
  deleteSession,
  updateSession,
  searchMessageHistory,
  listRecentUserPrompts,
  restoreSessionFromCheckpoint,
} from "../../server/lib/sessions.js";

describe("chat sessions", () => {
  let data;
  before(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-sess-"));
  });
  after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("creates and lists sessions", () => {
    const s = createSession(data, {
      cwd: "/tmp/proj",
      workflowId: "code-agent",
    });
    assert.ok(s.id);
    assert.equal(s.title, "New chat");
    const list = listSessions(data);
    assert.equal(list.sessions.length, 1);
    assert.equal(list.activeId, s.id);
  });

  it("titles from first user message", () => {
    const s = createSession(data, { cwd: "/tmp/proj" });
    appendUserMessage(data, s.id, {
      text: "Fix the flaky auth test in login.spec.ts please",
    });
    const got = getSession(data, s.id);
    assert.match(got.title, /Fix the flaky/);
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].role, "user");
  });

  it("finalizes assistant message and stores grok session", () => {
    const s = createSession(data, { cwd: "/tmp/proj" });
    appendUserMessage(data, s.id, { text: "hello" });
    const { message } = appendAssistantPlaceholder(data, s.id, {
      runId: "11111111-1111-4111-8111-111111111111",
    });
    finalizeAssistantMessage(data, s.id, message.id, {
      text: "PONG",
      status: "completed",
      outputs: [],
      grokSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    const got = getSession(data, s.id);
    const asst = got.messages.find((m) => m.role === "assistant");
    assert.equal(asst.text, "PONG");
    assert.equal(asst.status, "completed");
    assert.equal(got.grokSessionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("updates and deletes", () => {
    const s = createSession(data, { cwd: "/tmp/a" });
    updateSession(data, s.id, { title: "Renamed", pinned: true });
    assert.equal(getSession(data, s.id).title, "Renamed");
    const after = deleteSession(data, s.id);
    assert.ok(!after.sessions.some((x) => x.id === s.id));
  });

  it("searches user message history", () => {
    const s = createSession(data, { cwd: "/tmp/proj" });
    appendUserMessage(data, s.id, { text: "unique-zebra-prompt-42" });
    const hits = searchMessageHistory(data, "zebra-prompt");
    assert.ok(hits.some((h) => h.text.includes("unique-zebra")));
    const recent = listRecentUserPrompts(data, { limit: 5 });
    assert.ok(recent.length >= 1);
  });

  it("attaches run id after placeholder and fails cleanly", () => {
    const s = createSession(data, { cwd: "/tmp/proj" });
    appendUserMessage(data, s.id, { text: "hi" });
    const { message } = appendAssistantPlaceholder(data, s.id, {});
    assert.equal(message.runId, null);
    const runId = "22222222-2222-4222-8222-222222222222";
    attachRunToAssistantMessage(data, s.id, message.id, runId);
    let got = getSession(data, s.id);
    assert.equal(got.messages.find((m) => m.id === message.id).runId, runId);
    assert.ok(got.runIds.includes(runId));
    failAssistantMessage(data, s.id, message.id, {
      text: "spawn failed",
      status: "error",
    });
    got = getSession(data, s.id);
    const asst = got.messages.find((m) => m.id === message.id);
    assert.equal(asst.status, "error");
    assert.equal(asst.text, "spawn failed");
  });

  it("returns newest search hits when over limit", () => {
    const s = createSession(data, { cwd: "/tmp/proj" });
    for (let i = 0; i < 5; i++) {
      appendUserMessage(data, s.id, { text: `needle-item-${i}` });
    }
    const hits = searchMessageHistory(data, "needle-item", { limit: 2 });
    assert.equal(hits.length, 2);
    assert.ok(hits[0].at >= hits[1].at);
    assert.match(hits[0].text, /needle-item-4/);
  });

  it("restores session from checkpoint snapshot", () => {
    const s = createSession(data, { cwd: "/tmp/proj", title: "orig" });
    appendUserMessage(data, s.id, { text: "before restore" });
    const snap = getSession(data, s.id);
    appendUserMessage(data, s.id, { text: "after snap" });
    const restored = restoreSessionFromCheckpoint(data, s.id, {
      id: "cp-1",
      label: "test-cp",
      messages: snap.messages,
      messageCount: snap.messages.length,
      cwd: snap.cwd,
      workflowId: snap.workflowId,
      title: snap.title,
    });
    assert.ok(restored.messages.some((m) => m.role === "system"));
    assert.ok(
      restored.messages.filter((m) => m.role === "user").every((m) => m.text === "before restore"),
    );
  });
});
