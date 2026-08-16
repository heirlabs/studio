import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { status, diff, commit, push } from "../../server/lib/git-ops.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-git-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

describe("git-ops", () => {
  let repo;
  let remote;

  before(() => {
    repo = initRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);

    remote = fs.mkdtempSync(path.join(os.tmpdir(), "gs-git-remote-"));
    const bare = path.join(remote, "origin.git");
    git(remote, ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-u", "origin", "main"]);
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  it("reports a clean repo after the initial commit", () => {
    const s = status(repo);
    assert.equal(s.branch, "main");
    assert.equal(s.dirty, false);
    assert.deepEqual(s.staged, []);
    assert.deepEqual(s.unstaged, []);
    assert.deepEqual(s.untracked, []);
    assert.equal(typeof s.ahead, "number");
    assert.equal(typeof s.behind, "number");
  });

  it("classifies staged, unstaged, and untracked paths", () => {
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    fs.writeFileSync(path.join(repo, "loose.txt"), "loose\n");
    git(repo, ["add", "staged.txt"]);

    const s = status(repo);
    assert.equal(s.dirty, true);
    assert.ok(s.staged.some((e) => e.path === "staged.txt" && e.status === "A"));
    assert.ok(s.unstaged.some((e) => e.path === "README.md" && e.status === "M"));
    assert.ok(s.untracked.includes("loose.txt"));

    git(repo, ["checkout", "--", "README.md"]);
    fs.unlinkSync(path.join(repo, "staged.txt"));
    fs.unlinkSync(path.join(repo, "loose.txt"));
    git(repo, ["reset", "-q", "HEAD"]);
  });

  it("returns a unified diff, including staged-only", () => {
    fs.writeFileSync(path.join(repo, "README.md"), "hello diff\n");
    const unstaged = diff(repo);
    assert.match(unstaged.text, /hello diff/);

    git(repo, ["add", "README.md"]);
    const staged = diff(repo, { staged: true });
    assert.match(staged.text, /hello diff/);

    const scoped = diff(repo, { staged: true, path: "README.md" });
    assert.match(scoped.text, /README/);

    git(repo, ["checkout", "--", "README.md"]);
    git(repo, ["reset", "-q", "HEAD"]);
  });

  it("commits all changes when no paths are given", () => {
    fs.writeFileSync(path.join(repo, "all.txt"), "all\n");
    const result = commit(repo, { message: "add all.txt" });
    assert.equal(result.ok, true);
    assert.equal(result.message, "add all.txt");
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.equal(status(repo).dirty, false);
  });

  it("commits only the requested paths", () => {
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep\n");
    fs.writeFileSync(path.join(repo, "skip.txt"), "skip\n");
    const result = commit(repo, {
      message: "add keep.txt",
      paths: ["keep.txt"],
    });
    assert.equal(result.ok, true);
    const s = status(repo);
    assert.ok(s.untracked.includes("skip.txt"));
    fs.unlinkSync(path.join(repo, "skip.txt"));
  });

  it("refuses an empty commit message", () => {
    fs.writeFileSync(path.join(repo, "msg.txt"), "x\n");
    assert.throws(() => commit(repo, { message: "   " }), { status: 400 });
    fs.unlinkSync(path.join(repo, "msg.txt"));
  });

  it("refuses when there is nothing to commit", () => {
    assert.throws(() => commit(repo, { message: "empty" }), {
      status: 400,
      message: /Nothing to commit/,
    });
  });

  it("pushes the current branch to origin", () => {
    const result = push(repo, {});
    assert.equal(result.ok, true);
    assert.equal(result.remote, "origin");
    assert.equal(result.branch, "main");
    assert.equal(typeof result.output, "string");
  });

  it("rejects a path that is not a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-nongit-"));
    assert.throws(() => status(dir), { status: 400, message: /Not a git/ });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a missing cwd via resolveProjectCwd", () => {
    assert.throws(() => status("/no/such/heir-studio-git"), { status: 400 });
  });
});
