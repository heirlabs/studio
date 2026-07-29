/**
 * Isolated git worktrees for parallel agent sessions.
 * Creates a branch + worktree under <repo>/.grok-studio/worktrees/<name>
 * so concurrent sessions do not collide on the main working tree.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";

function runGit(cwd, args, { timeout = 30000 } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function isGitRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    const out = runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out === "true";
  } catch {
    return false;
  }
}

export function gitRoot(dir) {
  if (!isGitRepo(dir)) return null;
  try {
    return runGit(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export function worktreeBaseDir(repoRoot) {
  return path.join(repoRoot, ".grok-studio", "worktrees");
}

export function sanitizeWorktreeName(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || `wt-${randomBytes(4).toString("hex")}`;
}

/**
 * Create an isolated worktree for a studio session.
 * @returns {{ name, path, branch, baseRef, repoRoot }}
 */
export function createWorktree(projectCwd, { name, baseRef } = {}) {
  const repoRoot = gitRoot(projectCwd);
  if (!repoRoot) {
    const err = new Error(
      "Project is not a git repository — cannot create isolated worktree",
    );
    err.status = 400;
    err.code = "NOT_GIT";
    throw err;
  }

  const wtName = sanitizeWorktreeName(
    name || `session-${randomBytes(3).toString("hex")}`,
  );
  const base = worktreeBaseDir(repoRoot);
  fs.mkdirSync(base, { recursive: true });
  const wtPath = path.join(base, wtName);

  if (fs.existsSync(wtPath)) {
    // Reuse existing path if already a worktree
    if (isGitRepo(wtPath)) {
      return {
        name: wtName,
        path: wtPath,
        branch: currentBranch(wtPath),
        baseRef: baseRef || null,
        repoRoot,
        reused: true,
      };
    }
    const err = new Error(`Worktree path exists and is not a git worktree: ${wtPath}`);
    err.status = 409;
    throw err;
  }

  const branch = `studio/${wtName}`;
  const ref = baseRef || "HEAD";

  // Ensure branch does not already exist; if it does, use a unique suffix
  let branchName = branch;
  try {
    runGit(repoRoot, ["rev-parse", "--verify", branchName]);
    branchName = `${branch}-${randomBytes(2).toString("hex")}`;
  } catch {
    // branch does not exist — good
  }

  runGit(repoRoot, [
    "worktree",
    "add",
    "-b",
    branchName,
    wtPath,
    ref,
  ]);

  return {
    name: wtName,
    path: wtPath,
    branch: branchName,
    baseRef: ref,
    repoRoot,
    reused: false,
  };
}

function currentBranch(cwd) {
  try {
    return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return null;
  }
}

export function listWorktrees(projectCwd) {
  const repoRoot = gitRoot(projectCwd);
  if (!repoRoot) return [];
  let raw;
  try {
    raw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const items = [];
  let cur = {};
  for (const line of raw.split("\n")) {
    if (!line) {
      if (cur.path) items.push(cur);
      cur = {};
      continue;
    }
    if (line.startsWith("worktree ")) {
      cur.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    }
  }
  if (cur.path) items.push(cur);

  const base = worktreeBaseDir(repoRoot);
  return items
    .filter((w) => w.path && w.path.startsWith(base + path.sep))
    .map((w) => ({
      name: path.basename(w.path),
      path: w.path,
      branch: w.branch || null,
      head: w.head || null,
      repoRoot,
    }));
}

/**
 * Remove a studio worktree by name or absolute path.
 */
export function removeWorktree(projectCwd, nameOrPath) {
  const repoRoot = gitRoot(projectCwd);
  if (!repoRoot) {
    const err = new Error("Not a git repository");
    err.status = 400;
    throw err;
  }
  const base = worktreeBaseDir(repoRoot);
  const wtPath = path.isAbsolute(nameOrPath)
    ? nameOrPath
    : path.join(base, sanitizeWorktreeName(nameOrPath));

  if (!wtPath.startsWith(base + path.sep) && wtPath !== base) {
    const err = new Error("Worktree path outside studio worktree root");
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(wtPath)) {
    const err = new Error(`Worktree not found: ${wtPath}`);
    err.status = 404;
    throw err;
  }

  runGit(repoRoot, ["worktree", "remove", "--force", wtPath], {
    timeout: 60000,
  });

  // Drop the branch if it was a studio/* branch and is fully merged or orphaned
  try {
    const branch = currentBranch(repoRoot); // not useful — branch already gone with worktree
    void branch;
  } catch {
    /* ignore */
  }

  return { ok: true, path: wtPath };
}

/**
 * Resolve the effective cwd for a run given optional worktree isolation.
 */
export function resolveRunCwd({ projectCwd, worktree, worktreeName }) {
  if (!worktree) return { cwd: projectCwd, worktree: null };
  const created = createWorktree(projectCwd, { name: worktreeName });
  return { cwd: created.path, worktree: created };
}
