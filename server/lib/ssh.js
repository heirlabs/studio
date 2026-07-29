/**
 * SSH connection profiles for remote development.
 * Connections stored in <dataDir>/ssh-connections.json.
 * Remote runs execute: ssh … '<remoteGrokBin> …' with streamed stdout.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { spawn, execFileSync } from "child_process";

function storePath(dataDir) {
  return path.join(dataDir, "ssh-connections.json");
}

function readStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = storePath(dataDir);
  if (!fs.existsSync(p)) return { connections: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeStore(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2));
}

export function listConnections(dataDir) {
  return readStore(dataDir).connections;
}

export function getConnection(dataDir, id) {
  return listConnections(dataDir).find((c) => c.id === id) || null;
}

/**
 * Validate connection fields.
 */
export function validateConnectionInput(input) {
  if (!input || typeof input !== "object") {
    const err = new Error("connection body required");
    err.status = 400;
    throw err;
  }
  const host = String(input.host || "").trim();
  if (!host) {
    const err = new Error("host is required");
    err.status = 400;
    throw err;
  }
  if (/[\s;|&$`<>]/.test(host)) {
    const err = new Error("host contains invalid characters");
    err.status = 400;
    throw err;
  }
  const user = String(input.user || "").trim();
  if (user && /[\s;|&$`<>]/.test(user)) {
    const err = new Error("user contains invalid characters");
    err.status = 400;
    throw err;
  }
  const port = input.port != null ? Number(input.port) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error("port must be 1–65535");
    err.status = 400;
    throw err;
  }
  const remoteCwd = String(input.remoteCwd || "~").trim() || "~";
  const remoteGrokBin = String(input.remoteGrokBin || "grok").trim() || "grok";
  const identityFile = input.identityFile
    ? String(input.identityFile).trim()
    : null;
  if (identityFile && !path.isAbsolute(identityFile)) {
    const err = new Error("identityFile must be an absolute path");
    err.status = 400;
    throw err;
  }
  const name = String(input.name || `${user ? user + "@" : ""}${host}`).trim();
  return {
    name,
    host,
    user: user || null,
    port,
    remoteCwd,
    remoteGrokBin,
    identityFile,
    extraSshArgs: Array.isArray(input.extraSshArgs)
      ? input.extraSshArgs.map(String)
      : [],
  };
}

export function createConnection(dataDir, input) {
  const fields = validateConnectionInput(input);
  const store = readStore(dataDir);
  const conn = {
    id: randomUUID(),
    ...fields,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
  };
  store.connections.push(conn);
  writeStore(dataDir, store);
  return conn;
}

export function updateConnection(dataDir, id, patch) {
  const store = readStore(dataDir);
  const idx = store.connections.findIndex((c) => c.id === id);
  if (idx < 0) {
    const err = new Error("connection not found");
    err.status = 404;
    throw err;
  }
  const merged = validateConnectionInput({
    ...store.connections[idx],
    ...patch,
  });
  store.connections[idx] = {
    ...store.connections[idx],
    ...merged,
    updatedAt: Date.now(),
  };
  writeStore(dataDir, store);
  return store.connections[idx];
}

export function deleteConnection(dataDir, id) {
  const store = readStore(dataDir);
  const before = store.connections.length;
  store.connections = store.connections.filter((c) => c.id !== id);
  if (store.connections.length === before) {
    const err = new Error("connection not found");
    err.status = 404;
    throw err;
  }
  writeStore(dataDir, store);
  return { ok: true };
}

/**
 * Build ssh argv (without remote command).
 */
export function buildSshArgs(conn) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(conn.port || 22),
  ];
  if (conn.identityFile) {
    args.push("-i", conn.identityFile);
  }
  if (Array.isArray(conn.extraSshArgs)) {
    args.push(...conn.extraSshArgs);
  }
  const target = conn.user ? `${conn.user}@${conn.host}` : conn.host;
  args.push(target);
  return args;
}

/**
 * Shell-escape a string for remote single-quoted command.
 */
export function shellSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Test connectivity: ssh … true
 */
export function testConnection(dataDir, id) {
  const conn = getConnection(dataDir, id);
  if (!conn) {
    const err = new Error("connection not found");
    err.status = 404;
    throw err;
  }
  const args = [...buildSshArgs(conn), "true"];
  const started = Date.now();
  let ok = false;
  let error = null;
  try {
    execFileSync("ssh", args, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ok = true;
  } catch (e) {
    ok = false;
    error = (e.stderr || e.message || String(e)).toString().trim();
  }
  const store = readStore(dataDir);
  const idx = store.connections.findIndex((c) => c.id === id);
  if (idx >= 0) {
    store.connections[idx].lastTestAt = Date.now();
    store.connections[idx].lastTestOk = ok;
    store.connections[idx].lastTestError = error;
    writeStore(dataDir, store);
  }
  return {
    ok,
    error,
    durationMs: Date.now() - started,
    connection: getConnection(dataDir, id),
  };
}

/**
 * Spawn remote grok via ssh. Returns ChildProcess.
 * remoteArgs are args after the grok binary (e.g. --prompt-file …).
 * For remote, prompt file content is passed via stdin heredoc or --prompt-file
 * is rewritten to use a remote temp path uploaded via ssh.
 *
 * Production path used by runs.js:
 *   1. scp prompt file to remote /tmp
 *   2. ssh run grok with remote path
 */
export function uploadFileViaScp(conn, localPath, remotePath) {
  const scpArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-P",
    String(conn.port || 22),
  ];
  if (conn.identityFile) scpArgs.push("-i", conn.identityFile);
  const target = conn.user ? `${conn.user}@${conn.host}` : conn.host;
  scpArgs.push(localPath, `${target}:${remotePath}`);
  execFileSync("scp", scpArgs, {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return remotePath;
}

/**
 * Build remote command string to run grok in remoteCwd.
 */
export function buildRemoteGrokCommand(conn, remoteGrokArgs) {
  const bin = conn.remoteGrokBin || "grok";
  const cwd = conn.remoteCwd || "~";
  const quotedArgs = remoteGrokArgs.map(shellSingleQuote).join(" ");
  return `cd ${shellSingleQuote(cwd)} && ${shellSingleQuote(bin)} ${quotedArgs}`;
}

/**
 * Spawn ssh running a remote command. stdio piped.
 */
export function spawnRemoteCommand(conn, remoteCommand) {
  const args = [...buildSshArgs(conn), remoteCommand];
  return spawn("ssh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
}
