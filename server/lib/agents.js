/**
 * Subagent / agent definition discovery.
 * Sources (priority high → low for same name):
 *   1. project: <cwd>/.grok/agents/*.md
 *   2. user:    ~/.grok/agents/*.md
 *   3. studio:  <data>/.grok/agents/*.md  (optional)
 *   4. bundled: ~/.grok/bundled/agents/*.md
 */
import fs from "fs";
import path from "path";
import os from "os";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Minimal YAML-ish frontmatter parser for agent md files.
 * Supports key: value and key: > multiline (collapsed to single line).
 */
export function parseAgentFrontmatter(text) {
  const m = String(text || "").match(FRONTMATTER_RE);
  if (!m) {
    return { meta: {}, body: String(text || "").trim() };
  }
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    let val = kv[2];
    if (val === ">" || val === "|") {
      const parts = [];
      i++;
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i] === "")) {
        parts.push(lines[i].replace(/^\s+/, ""));
        i++;
      }
      meta[key] = parts.join(" ").trim();
      continue;
    }
    // strip quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val === "true") meta[key] = true;
    else if (val === "false") meta[key] = false;
    else meta[key] = val;
    i++;
  }
  return { meta, body: m[2].trim() };
}

function listMdFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f));
}

function loadAgentFile(filePath, scope) {
  const text = fs.readFileSync(filePath, "utf8");
  const { meta, body } = parseAgentFrontmatter(text);
  const base = path.basename(filePath, ".md");
  return {
    id: meta.name || base,
    name: meta.name || base,
    description: String(meta.description || "").trim(),
    permissionMode: meta.permission_mode || meta.permissionMode || null,
    promptMode: meta.prompt_mode || meta.promptMode || null,
    model: meta.model || null,
    body,
    path: filePath,
    scope,
  };
}

export function agentSearchDirs({
  projectCwd,
  dataDir,
  home = os.homedir(),
  includeBundled = true,
} = {}) {
  const dirs = [];
  if (projectCwd) {
    dirs.push({
      dir: path.join(projectCwd, ".grok", "agents"),
      scope: "project",
    });
    dirs.push({
      dir: path.join(projectCwd, ".claude", "agents"),
      scope: "project-claude",
    });
  }
  dirs.push({ dir: path.join(home, ".grok", "agents"), scope: "user" });
  dirs.push({ dir: path.join(home, ".claude", "agents"), scope: "user-claude" });
  if (dataDir) {
    dirs.push({
      dir: path.join(dataDir, "agents"),
      scope: "studio",
    });
  }
  if (includeBundled) {
    dirs.push({
      dir: path.join(home, ".grok", "bundled", "agents"),
      scope: "bundled",
    });
  }
  return dirs;
}

/**
 * List all agents. Higher-priority scopes shadow lower on same id.
 */
export function listAgents(options = {}) {
  const dirs = agentSearchDirs(options);
  // reverse so higher priority overwrites
  const byId = new Map();
  // process low → high priority
  for (const { dir, scope } of [...dirs].reverse()) {
    for (const file of listMdFiles(dir)) {
      const agent = loadAgentFile(file, scope);
      byId.set(agent.id, agent);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgent(id, options = {}) {
  if (!id) return null;
  return listAgents(options).find((a) => a.id === id) || null;
}

/**
 * Write an agent definition into project or user agents dir.
 */
export function writeAgent(
  { name, description, body, permissionMode, model },
  { scope = "project", projectCwd, home = os.homedir(), dataDir } = {},
) {
  const id = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!id) {
    const err = new Error("agent name required");
    err.status = 400;
    throw err;
  }
  let dir;
  if (scope === "project") {
    if (!projectCwd) {
      const err = new Error("projectCwd required for project agents");
      err.status = 400;
      throw err;
    }
    dir = path.join(projectCwd, ".grok", "agents");
  } else if (scope === "user") {
    dir = path.join(home, ".grok", "agents");
  } else if (scope === "studio") {
    if (!dataDir) {
      const err = new Error("dataDir required for studio agents");
      err.status = 400;
      throw err;
    }
    dir = path.join(dataDir, "agents");
  } else {
    const err = new Error("scope must be project|user|studio");
    err.status = 400;
    throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.md`);
  const lines = ["---", `name: ${id}`];
  if (description) lines.push(`description: >\n  ${description}`);
  if (permissionMode) lines.push(`permission_mode: ${permissionMode}`);
  if (model) lines.push(`model: ${model}`);
  lines.push("---", "", String(body || "").trim(), "");
  fs.writeFileSync(filePath, lines.join("\n"));
  return loadAgentFile(filePath, scope);
}

/**
 * Build --agent / --agents CLI args.
 */
export function agentToCliArgs(agentIdOrPath, options = {}) {
  const args = [];
  if (!agentIdOrPath) return args;
  const asPath = path.isAbsolute(agentIdOrPath)
    ? agentIdOrPath
    : getAgent(agentIdOrPath, options)?.path;
  if (asPath && fs.existsSync(asPath)) {
    args.push("--agent", asPath);
  } else {
    args.push("--agent", String(agentIdOrPath));
  }
  return args;
}
