import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveGrokBin(env = process.env, home = os.homedir()) {
  if (env.GROK_BIN) return env.GROK_BIN;
  const candidates = [
    path.join(home, ".grok", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execFileSync("which", ["grok"], { encoding: "utf8" }).trim();
  } catch {
    return "grok";
  }
}

export function createConfig(overrides = {}) {
  const root =
    overrides.root ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const data = overrides.data || path.join(root, "data");
  const home = overrides.home || os.homedir();
  const cfg = {
    root,
    data,
    home,
    uploads: path.join(data, "uploads"),
    outputs: path.join(data, "outputs"),
    runs: path.join(data, "runs"),
    catalogPath:
      overrides.catalogPath || path.join(root, "workflows", "catalog.json"),
    publicDir: overrides.publicDir || path.join(root, "public"),
    // Never widen the bind address implicitly — remote access is opt-in.
    host: overrides.host || process.env.HEIR_STUDIO_HOST || "127.0.0.1",
    port: Number(overrides.port ?? process.env.HEIR_STUDIO_PORT ?? 3847),
    remoteEnabled:
      overrides.remoteEnabled ?? process.env.HEIR_STUDIO_REMOTE === "1",
    // false when fronted by a tunnel/proxy: loopback then needs a token too
    trustLoopback:
      overrides.trustLoopback ?? process.env.HEIR_STUDIO_TRUST_LOOPBACK !== "0",
    remoteAllowedCidrs:
      overrides.remoteAllowedCidrs ||
      (process.env.HEIR_STUDIO_REMOTE_CIDRS
        ? process.env.HEIR_STUDIO_REMOTE_CIDRS.split(",").map((s) => s.trim())
        : null),
    grokBin: overrides.grokBin || resolveGrokBin(process.env, home),
    sessionsRoot:
      overrides.sessionsRoot || path.join(home, ".grok", "sessions"),
    userWorkflowsDir:
      overrides.userWorkflowsDir || path.join(home, ".grok", "workflows"),
    studioWorkflowsDir:
      overrides.studioWorkflowsDir || path.join(root, ".grok", "workflows"),
    modelsCachePath:
      overrides.modelsCachePath ||
      path.join(home, ".grok", "models_cache.json"),
    keybindingsPath:
      overrides.keybindingsPath ||
      path.join(home, ".heir-studio", "keybindings.json"),
    settingsHome: overrides.settingsHome || home,
    maxConcurrentRuns: Number(overrides.maxConcurrentRuns ?? 3),
    maxUploadBytes: Number(overrides.maxUploadBytes ?? 80 * 1024 * 1024),
    maxUploadFiles: Number(overrides.maxUploadFiles ?? 20),
    defaultProjectCwd: overrides.defaultProjectCwd || null,
  };
  for (const d of [cfg.uploads, cfg.outputs, cfg.runs]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return cfg;
}

export const MEDIA_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".avif",
  ".mp4",
  ".webm",
  ".mov",
]);

export const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".avif",
]);

/** Non-image files attachable to a coding turn (prompt @paths) */
export const TEXT_ATTACH_EXT = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".astro",
  ".csv",
  ".log",
  ".diff",
  ".patch",
  ".lock",
  ".gitignore",
  ".dockerfile",
  ".makefile",
]);

export function isLoopback(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === ":ffff:127.0.0.1"
  );
}

export function isUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}
