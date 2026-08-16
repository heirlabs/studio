/**
 * Git status / diff / commit / push for the phone. Every git invocation uses
 * execFileSync with an argv array — user strings are never interpolated into a
 * shell.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { resolveProjectCwd } from "./runs.js";

function runGit(cwd, args, { timeout = 30000 } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || "git failed").trim();
    const err = new Error(detail || "git failed");
    err.status = 400;
    throw err;
  }
}

function resolveGitCwd(cwd) {
  const resolved = resolveProjectCwd(cwd);
  if (!fs.existsSync(path.join(resolved, ".git"))) {
    const err = new Error(`Not a git repository: ${resolved}`);
    err.status = 400;
    throw err;
  }
  return resolved;
}

function parsePorcelainPath(raw) {
  let filePath = raw;
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    filePath = filePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const arrow = filePath.lastIndexOf(" -> ");
  if (arrow !== -1) filePath = filePath.slice(arrow + 4);
  return filePath;
}

function parseStatus(text) {
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (const line of String(text || "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      if (rest.startsWith("HEAD (no branch)")) {
        branch = "HEAD";
        continue;
      }
      const name = rest.split("...")[0].trim();
      if (name) branch = name;
      const aheadM = rest.match(/ahead (\d+)/);
      const behindM = rest.match(/behind (\d+)/);
      ahead = aheadM ? Number(aheadM[1]) : 0;
      behind = behindM ? Number(behindM[1]) : 0;
      continue;
    }
    if (line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    const filePath = parsePorcelainPath(line.slice(3));
    if (x === "?" && y === "?") {
      untracked.push(filePath);
      continue;
    }
    if (x !== " " && x !== "?") staged.push({ path: filePath, status: x });
    if (y !== " " && y !== "?") unstaged.push({ path: filePath, status: y });
  }

  return {
    branch,
    ahead,
    behind,
    dirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
    staged,
    unstaged,
    untracked,
  };
}

export function status(cwd) {
  const resolved = resolveGitCwd(cwd);
  const text = runGit(resolved, [
    "status",
    "--porcelain=v1",
    "-b",
    "--untracked-files=all",
  ]);
  return parseStatus(text);
}

export function diff(cwd, { staged = false, path: filePath } = {}) {
  const resolved = resolveGitCwd(cwd);
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (filePath) args.push("--", String(filePath));
  return { text: runGit(resolved, args) };
}

export function commit(cwd, { message, paths } = {}) {
  const resolved = resolveGitCwd(cwd);
  const msg = String(message || "").trim();
  if (!msg) {
    const err = new Error("Commit message is required");
    err.status = 400;
    throw err;
  }

  const addPaths = Array.isArray(paths)
    ? paths.map(String).filter((p) => p.length > 0)
    : [];
  if (addPaths.length) {
    runGit(resolved, ["add", "--", ...addPaths]);
  } else {
    runGit(resolved, ["add", "-A"]);
  }

  const staged = runGit(resolved, ["diff", "--cached", "--name-only"]).trim();
  if (!staged) {
    const err = new Error("Nothing to commit");
    err.status = 400;
    throw err;
  }

  runGit(resolved, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    msg,
  ]);
  const sha = runGit(resolved, ["rev-parse", "HEAD"]).trim();
  return { ok: true, sha, message: msg };
}

export function push(cwd, { remote, branch } = {}) {
  const resolved = resolveGitCwd(cwd);
  const rem = String(remote || "origin");
  const br =
    branch != null && String(branch).trim()
      ? String(branch).trim()
      : runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const output = runGit(resolved, ["push", rem, br], { timeout: 60000 });
  return { ok: true, remote: rem, branch: br, output };
}
