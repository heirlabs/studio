import fs from "fs";
import path from "path";
import { resolveProjectCwd } from "./runs.js";

const MAX_RECENTS = 12;

function recentsPath(dataDir) {
  return path.join(dataDir, "recents.json");
}

export function loadRecents(dataDir) {
  const p = recentsPath(dataDir);
  if (!fs.existsSync(p)) return { current: null, recent: [] };
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    current: data.current || null,
    recent: Array.isArray(data.recent) ? data.recent : [],
  };
}

export function saveRecents(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(recentsPath(dataDir), JSON.stringify(state, null, 2));
}

/**
 * Validate and remember a project folder. Returns { cwd, recent }.
 */
export function setProject(dataDir, cwd) {
  const resolved = resolveProjectCwd(cwd);
  const state = loadRecents(dataDir);
  const recent = [
    resolved,
    ...state.recent.filter((p) => path.resolve(p) !== resolved),
  ].slice(0, MAX_RECENTS);
  const next = { current: resolved, recent };
  saveRecents(dataDir, next);
  return next;
}

export function getProject(dataDir, fallback) {
  const state = loadRecents(dataDir);
  if (state.current && fs.existsSync(state.current)) {
    return state;
  }
  // prune dead recents
  const recent = state.recent.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  const current =
    recent[0] ||
    (fallback && fs.existsSync(fallback) ? path.resolve(fallback) : null);
  const next = { current, recent };
  if (current || recent.length) saveRecents(dataDir, next);
  return next;
}
