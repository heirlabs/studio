/**
 * Background agent processing + notification hooks.
 * Tracks runs marked as background; persists notification events to disk;
 * supports registering in-process hooks (for Electron notifications).
 */
import fs from "fs";
import path from "path";
import { isUuid } from "./config.js";

function jobsPath(dataDir) {
  return path.join(dataDir, "background-jobs.json");
}

function notificationsPath(dataDir) {
  return path.join(dataDir, "notifications.jsonl");
}

function readJobs(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = jobsPath(dataDir);
  if (!fs.existsSync(p)) return { jobs: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJobs(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(jobsPath(dataDir), JSON.stringify(store, null, 2));
}

/** @type {Set<Function>} */
const hooks = new Set();

/**
 * Register a notification hook. Returns unsubscribe.
 * hook(event) receives { type, runId, sessionId, status, title, body, at }
 */
export function registerNotificationHook(fn) {
  if (typeof fn !== "function") {
    throw new Error("hook must be a function");
  }
  hooks.add(fn);
  return () => hooks.delete(fn);
}

export function clearNotificationHooks() {
  hooks.clear();
}

export function emitNotification(dataDir, event) {
  const payload = {
    ...event,
    at: event.at || Date.now(),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(notificationsPath(dataDir), JSON.stringify(payload) + "\n");
  for (const fn of hooks) {
    fn(payload);
  }
  return payload;
}

export function listNotifications(dataDir, { limit = 50 } = {}) {
  const p = notificationsPath(dataDir);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    out.push(JSON.parse(lines[i]));
  }
  return out;
}

export function registerBackgroundJob(dataDir, {
  runId,
  sessionId,
  title,
  promptPreview,
} = {}) {
  if (!isUuid(runId)) {
    const err = new Error("valid runId required");
    err.status = 400;
    throw err;
  }
  const store = readJobs(dataDir);
  store.jobs = store.jobs.filter((j) => j.runId !== runId);
  const job = {
    runId,
    sessionId: sessionId || null,
    title: title || "Background agent",
    promptPreview: String(promptPreview || "").slice(0, 200),
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
  };
  store.jobs.unshift(job);
  // keep last 100
  store.jobs = store.jobs.slice(0, 100);
  writeJobs(dataDir, store);
  emitNotification(dataDir, {
    type: "background.started",
    runId,
    sessionId,
    status: "running",
    title: job.title,
    body: job.promptPreview,
  });
  return job;
}

export function finishBackgroundJob(dataDir, runId, { status, summary } = {}) {
  const store = readJobs(dataDir);
  const job = store.jobs.find((j) => j.runId === runId);
  if (!job) return null;
  job.status = status || "completed";
  job.finishedAt = Date.now();
  job.summary = summary || null;
  writeJobs(dataDir, store);
  emitNotification(dataDir, {
    type:
      job.status === "completed"
        ? "background.completed"
        : "background.failed",
    runId,
    sessionId: job.sessionId,
    status: job.status,
    title: job.title,
    body: summary || `Run ${job.status}`,
  });
  return job;
}

export function listBackgroundJobs(dataDir, { status } = {}) {
  const store = readJobs(dataDir);
  let jobs = store.jobs;
  if (status) jobs = jobs.filter((j) => j.status === status);
  return jobs;
}

export function getBackgroundJob(dataDir, runId) {
  return listBackgroundJobs(dataDir).find((j) => j.runId === runId) || null;
}
