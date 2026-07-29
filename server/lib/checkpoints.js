/**
 * Checkpoints for long-running agent sessions.
 * Snapshot messages + optional git HEAD/status so users can restore state.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { isUuid } from "./config.js";

function rootDir(dataDir) {
  return path.join(dataDir, "checkpoints");
}

function sessionDir(dataDir, sessionId) {
  return path.join(rootDir(dataDir), sessionId);
}

function ensureSessionDir(dataDir, sessionId) {
  const d = sessionDir(dataDir, sessionId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Capture lightweight git state for a project cwd (best-effort).
 */
export function captureGitState(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const gitDir = path.join(cwd, ".git");
  if (!fs.existsSync(gitDir)) return null;
  const run = (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  };
  return {
    head: run(["rev-parse", "HEAD"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    status: run(["status", "--porcelain"]),
    dirty: Boolean(run(["status", "--porcelain"])),
  };
}

/**
 * Create a checkpoint from a session object snapshot.
 */
export function createCheckpoint(
  dataDir,
  sessionId,
  {
    label,
    session,
    runId,
    reason = "manual",
    includeGit = true,
  } = {},
) {
  if (!isUuid(sessionId)) {
    const err = new Error("invalid session id");
    err.status = 400;
    throw err;
  }
  if (!session || typeof session !== "object") {
    const err = new Error("session snapshot required");
    err.status = 400;
    throw err;
  }
  const id = randomUUID();
  const dir = ensureSessionDir(dataDir, sessionId);
  const git =
    includeGit && session.cwd ? captureGitState(session.cwd) : null;
  const checkpoint = {
    id,
    sessionId,
    label: String(label || `Checkpoint ${new Date().toISOString()}`).slice(
      0,
      200,
    ),
    reason,
    runId: runId || null,
    createdAt: Date.now(),
    messageCount: (session.messages || []).length,
    title: session.title || null,
    cwd: session.cwd || null,
    grokSessionId: session.grokSessionId || null,
    git,
    // Full message history for restore
    messages: session.messages || [],
    workflowId: session.workflowId || null,
  };
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify(checkpoint, null, 2),
  );
  return summarize(checkpoint);
}

function summarize(cp) {
  return {
    id: cp.id,
    sessionId: cp.sessionId,
    label: cp.label,
    reason: cp.reason,
    runId: cp.runId,
    createdAt: cp.createdAt,
    messageCount: cp.messageCount,
    title: cp.title,
    cwd: cp.cwd,
    grokSessionId: cp.grokSessionId,
    git: cp.git
      ? {
          head: cp.git.head,
          branch: cp.git.branch,
          dirty: cp.git.dirty,
        }
      : null,
  };
}

export function listCheckpoints(dataDir, sessionId) {
  if (!isUuid(sessionId)) {
    const err = new Error("invalid session id");
    err.status = 400;
    throw err;
  }
  const dir = sessionDir(dataDir, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return summarize(raw);
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getCheckpoint(dataDir, sessionId, checkpointId) {
  if (!isUuid(sessionId) || !isUuid(checkpointId)) {
    const err = new Error("invalid id");
    err.status = 400;
    throw err;
  }
  const p = path.join(sessionDir(dataDir, sessionId), `${checkpointId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Restore messages from checkpoint onto a session write function.
 * Returns the checkpoint payload (full) for the caller to apply.
 */
export function loadCheckpointForRestore(dataDir, sessionId, checkpointId) {
  const cp = getCheckpoint(dataDir, sessionId, checkpointId);
  if (!cp) {
    const err = new Error("checkpoint not found");
    err.status = 404;
    throw err;
  }
  return cp;
}

export function deleteCheckpoint(dataDir, sessionId, checkpointId) {
  if (!isUuid(sessionId) || !isUuid(checkpointId)) {
    const err = new Error("invalid id");
    err.status = 400;
    throw err;
  }
  const p = path.join(sessionDir(dataDir, sessionId), `${checkpointId}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true };
}
