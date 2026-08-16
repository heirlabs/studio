/**
 * List directories (and optionally files) on this Mac so a remote client
 * can pick a project cwd or inspect a file.
 */
import fs from "fs";
import os from "os";
import path from "path";

const MAX_ENTRIES = 400;
const DEFAULT_MAX_FILE_BYTES = 512_000;

export function expandHome(raw, home = os.homedir()) {
  const s = String(raw || "").trim();
  if (!s || s === "~") return home;
  if (s.startsWith("~/") || s === "~") return path.join(home, s.slice(2));
  return s;
}

function resolveDir(rawPath, home) {
  const requested = expandHome(rawPath, home);
  const resolved = path.resolve(requested);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    const err = new Error(`Not a directory: ${resolved}`);
    err.status = 400;
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`Not a directory: ${resolved}`);
    err.status = 400;
    throw err;
  }
  return resolved;
}

function readNames(resolved) {
  try {
    return fs.readdirSync(resolved);
  } catch {
    const err = new Error(`Cannot read directory: ${resolved}`);
    err.status = 403;
    throw err;
  }
}

export function listDirectories(rawPath, { home = os.homedir() } = {}) {
  const resolved = resolveDir(rawPath, home);
  const names = readNames(resolved);

  const entries = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(resolved, name);
    try {
      if (fs.statSync(full).isDirectory()) {
        entries.push({ name, path: full, type: "dir" });
      }
    } catch {
      // unreadable / raced
    }
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent !== resolved ? parent : null,
    home,
    entries,
  };
}

export function listEntries(rawPath, { home = os.homedir() } = {}) {
  const resolved = resolveDir(rawPath, home);
  const names = readNames(resolved);

  const entries = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(resolved, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        entries.push({ name, path: full, type: "dir" });
      } else if (st.isFile()) {
        entries.push({ name, path: full, type: "file", size: st.size });
      }
    } catch {
      // unreadable / raced
    }
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent !== resolved ? parent : null,
    home,
    entries,
  };
}

export function readFileText(
  rawPath,
  { maxBytes = DEFAULT_MAX_FILE_BYTES, home = os.homedir() } = {},
) {
  const requested = expandHome(rawPath, home);
  const resolved = path.resolve(requested);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    const err = new Error(`File not found: ${resolved}`);
    err.status = 404;
    throw err;
  }
  if (!stat.isFile()) {
    const err = new Error(`Not a file: ${resolved}`);
    err.status = 400;
    throw err;
  }
  if (stat.size > maxBytes) {
    const err = new Error(
      `File too large (${stat.size} bytes, max ${maxBytes})`,
    );
    err.status = 400;
    throw err;
  }
  const text = fs.readFileSync(resolved, "utf8");
  return { path: resolved, text, truncated: false };
}
