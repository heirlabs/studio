import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isUuid } from "./config.js";

function rootDir(dataDir) {
  return path.join(dataDir, "chat-sessions");
}

function indexPath(dataDir) {
  return path.join(rootDir(dataDir), "index.json");
}

function sessionPath(dataDir, id) {
  return path.join(rootDir(dataDir), `${id}.json`);
}

function ensureDir(dataDir) {
  fs.mkdirSync(rootDir(dataDir), { recursive: true });
}

function readIndex(dataDir) {
  ensureDir(dataDir);
  const p = indexPath(dataDir);
  if (!fs.existsSync(p)) return { activeId: null, sessions: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeIndex(dataDir, index) {
  ensureDir(dataDir);
  fs.writeFileSync(indexPath(dataDir), JSON.stringify(index, null, 2));
}

function readSession(dataDir, id) {
  if (!isUuid(id)) return null;
  const p = sessionPath(dataDir, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeSession(dataDir, session) {
  ensureDir(dataDir);
  fs.writeFileSync(
    sessionPath(dataDir, session.id),
    JSON.stringify(session, null, 2),
  );
}

function titleFromText(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "New chat";
  return t.length > 48 ? t.slice(0, 45) + "…" : t;
}

function toSummary(session) {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    workflowId: session.workflowId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: (session.messages || []).length,
    pinned: Boolean(session.pinned),
    lastPreview: session.lastPreview || "",
    activeRunId: session.activeRunId || null,
  };
}

function touchIndex(dataDir, session, makeActive = false) {
  const index = readIndex(dataDir);
  const summary = toSummary(session);
  const rest = (index.sessions || []).filter((s) => s.id !== session.id);
  index.sessions = [summary, ...rest].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  if (makeActive || !index.activeId) index.activeId = session.id;
  writeIndex(dataDir, index);
  return index;
}

export function listSessions(dataDir) {
  const index = readIndex(dataDir);
  // prune missing files
  const sessions = [];
  for (const s of index.sessions || []) {
    if (fs.existsSync(sessionPath(dataDir, s.id))) sessions.push(s);
  }
  if (sessions.length !== (index.sessions || []).length) {
    index.sessions = sessions;
    if (index.activeId && !sessions.some((s) => s.id === index.activeId)) {
      index.activeId = sessions[0]?.id || null;
    }
    writeIndex(dataDir, index);
  }
  return { activeId: index.activeId, sessions };
}

export function getSession(dataDir, id) {
  return readSession(dataDir, id);
}

export function createSession(dataDir, { title, cwd, workflowId } = {}) {
  const now = Date.now();
  const session = {
    id: randomUUID(),
    title: title || "New chat",
    cwd: cwd || null,
    workflowId: workflowId || "code-agent",
    createdAt: now,
    updatedAt: now,
    pinned: false,
    lastPreview: "",
    grokSessionId: null,
    activeRunId: null,
    messages: [],
    runIds: [],
  };
  writeSession(dataDir, session);
  touchIndex(dataDir, session, true);
  return session;
}

export function updateSession(dataDir, id, patch) {
  const session = readSession(dataDir, id);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  if (patch.title != null) session.title = String(patch.title).slice(0, 120);
  if (patch.cwd !== undefined) session.cwd = patch.cwd;
  if (patch.workflowId != null) session.workflowId = patch.workflowId;
  if (patch.pinned != null) session.pinned = Boolean(patch.pinned);
  if (patch.grokSessionId != null) session.grokSessionId = patch.grokSessionId;
  if (patch.activeRunId !== undefined) {
    session.activeRunId = patch.activeRunId || null;
  }
  session.updatedAt = Date.now();
  writeSession(dataDir, session);
  touchIndex(dataDir, session, false);
  return session;
}

/**
 * Mark the live run for a session (for GUI reattachment after switch).
 */
export function setSessionActiveRun(dataDir, id, runId) {
  return updateSession(dataDir, id, { activeRunId: runId || null });
}

/**
 * Find the most recent assistant message still marked running.
 */
export function findRunningAssistant(session) {
  if (!session?.messages?.length) return null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "assistant" && m.status === "running" && m.runId) {
      return m;
    }
  }
  return null;
}

export function setActiveSession(dataDir, id) {
  if (id && !readSession(dataDir, id)) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  const index = readIndex(dataDir);
  index.activeId = id || null;
  writeIndex(dataDir, index);
  return listSessions(dataDir);
}

export function deleteSession(dataDir, id) {
  if (!isUuid(id)) {
    const err = new Error("invalid session id");
    err.status = 400;
    throw err;
  }
  const p = sessionPath(dataDir, id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const index = readIndex(dataDir);
  index.sessions = (index.sessions || []).filter((s) => s.id !== id);
  if (index.activeId === id) {
    index.activeId = index.sessions[0]?.id || null;
  }
  writeIndex(dataDir, index);
  return listSessions(dataDir);
}

/**
 * Append a user message and optionally set title from first message.
 */
export function appendUserMessage(dataDir, id, { text, images = [] }) {
  const session = readSession(dataDir, id);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  const lastAt = session.messages.length
    ? session.messages[session.messages.length - 1].at || 0
    : 0;
  const msg = {
    id: randomUUID(),
    role: "user",
    text: String(text || ""),
    images: images || [],
    // Monotonic within a session so history sort is stable under burst writes
    at: Math.max(Date.now(), lastAt + 1),
  };
  session.messages.push(msg);
  if (
    session.title === "New chat" ||
    !session.title ||
    session.messages.filter((m) => m.role === "user").length === 1
  ) {
    session.title = titleFromText(msg.text);
  }
  session.lastPreview = titleFromText(msg.text);
  session.updatedAt = Date.now();
  writeSession(dataDir, session);
  touchIndex(dataDir, session, true);
  return { session, message: msg };
}

/**
 * Append assistant placeholder, then finalize with text / run meta.
 */
export function appendAssistantPlaceholder(dataDir, id, { runId } = {}) {
  const session = readSession(dataDir, id);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  const msg = {
    id: randomUUID(),
    role: "assistant",
    text: "",
    thoughts: "",
    runId: runId || null,
    status: "running",
    outputs: [],
    at: Date.now(),
  };
  session.messages.push(msg);
  if (runId) {
    if (!session.runIds) session.runIds = [];
    if (!session.runIds.includes(runId)) session.runIds.push(runId);
  }
  session.updatedAt = Date.now();
  writeSession(dataDir, session);
  touchIndex(dataDir, session, true);
  return { session, message: msg };
}

/**
 * Attach a run id to an existing assistant placeholder (after spawn).
 */
export function attachRunToAssistantMessage(dataDir, id, messageId, runId) {
  const session = readSession(dataDir, id);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  const msg = session.messages.find((m) => m.id === messageId);
  if (!msg) {
    const err = new Error("message not found");
    err.status = 404;
    throw err;
  }
  msg.runId = runId || null;
  if (runId) {
    if (!session.runIds) session.runIds = [];
    if (!session.runIds.includes(runId)) session.runIds.push(runId);
  }
  session.updatedAt = Date.now();
  writeSession(dataDir, session);
  touchIndex(dataDir, session, false);
  return { session, message: msg };
}

/**
 * Mark a running assistant message as failed when spawn rejects before finish.
 */
export function failAssistantMessage(dataDir, id, messageId, { text, status } = {}) {
  return finalizeAssistantMessage(dataDir, id, messageId, {
    text: text || "",
    status: status || "error",
    outputs: [],
  });
}

export function finalizeAssistantMessage(
  dataDir,
  id,
  messageId,
  { text, thoughts, status, outputs, grokSessionId },
) {
  const session = readSession(dataDir, id);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  const msg = session.messages.find((m) => m.id === messageId);
  if (!msg) {
    const err = new Error("message not found");
    err.status = 404;
    throw err;
  }
  if (text != null) msg.text = text;
  if (thoughts != null) msg.thoughts = thoughts;
  if (status != null) msg.status = status;
  if (outputs != null) msg.outputs = outputs;
  msg.finishedAt = Date.now();
  if (grokSessionId) session.grokSessionId = grokSessionId;
  session.lastPreview = titleFromText(msg.text || status || "done");
  session.updatedAt = Date.now();
  writeSession(dataDir, session);
  touchIndex(dataDir, session, false);
  return session;
}

export function appendSystemNote(dataDir, id, text) {
  const session = readSession(dataDir, id);
  if (!session) return null;
  session.messages.push({
    id: randomUUID(),
    role: "system",
    text: String(text || ""),
    at: Date.now(),
  });
  session.updatedAt = Date.now();
  writeSession(dataDir, session);
  touchIndex(dataDir, session, false);
  return session;
}

/**
 * Replace session messages with a checkpoint snapshot (restore).
 */
export function restoreSessionFromCheckpoint(dataDir, id, checkpoint) {
  const session = readSession(dataDir, id);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  if (!checkpoint || !Array.isArray(checkpoint.messages)) {
    const err = new Error("checkpoint messages required");
    err.status = 400;
    throw err;
  }
  session.messages = checkpoint.messages.map((m) => ({ ...m }));
  if (checkpoint.workflowId) session.workflowId = checkpoint.workflowId;
  if (checkpoint.cwd != null) session.cwd = checkpoint.cwd;
  if (checkpoint.grokSessionId != null) {
    session.grokSessionId = checkpoint.grokSessionId;
  }
  if (checkpoint.title) session.title = checkpoint.title;
  session.lastPreview = titleFromText(
    [...session.messages].reverse().find((m) => m.text)?.text || "restored",
  );
  session.updatedAt = Date.now();
  session.messages.push({
    id: randomUUID(),
    role: "system",
    text: `Restored checkpoint “${checkpoint.label || checkpoint.id}” (${checkpoint.messageCount ?? session.messages.length - 1} messages).`,
    at: Date.now(),
  });
  writeSession(dataDir, session);
  touchIndex(dataDir, session, true);
  return session;
}

/**
 * Search message history across sessions (for Ctrl+R reverse history).
 */
export function searchMessageHistory(dataDir, query, { limit = 40 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const { sessions } = listSessions(dataDir);
  const hits = [];
  for (const summary of sessions) {
    const session = readSession(dataDir, summary.id);
    if (!session) continue;
    for (const msg of session.messages || []) {
      if (msg.role !== "user") continue;
      const text = String(msg.text || "");
      if (!text.toLowerCase().includes(q)) continue;
      hits.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: msg.id,
        text,
        at: msg.at,
        cwd: session.cwd,
      });
    }
  }
  return hits
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(1, Number(limit) || 40));
}

/**
 * Recent user prompts for history search when query is empty.
 */
export function listRecentUserPrompts(dataDir, { limit = 30 } = {}) {
  const { sessions } = listSessions(dataDir);
  const hits = [];
  for (const summary of sessions) {
    const session = readSession(dataDir, summary.id);
    if (!session) continue;
    for (const msg of session.messages || []) {
      if (msg.role !== "user" || !msg.text) continue;
      hits.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: msg.id,
        text: msg.text,
        at: msg.at,
        cwd: session.cwd,
      });
    }
  }
  return hits.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}
