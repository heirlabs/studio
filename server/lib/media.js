import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { MEDIA_EXT, IMAGE_EXT } from "./config.js";
import { safeName } from "./template.js";

export function isMediaFile(name) {
  return MEDIA_EXT.has(path.extname(name).toLowerCase());
}

export function isImageFile(name) {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

export function mediaKind(name) {
  return /\.(mp4|webm|mov)$/i.test(name) ? "video" : "image";
}

export function listMediaInDir(dir, dataRoot) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => isMediaFile(f) && !f.startsWith("."))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (!st.isFile()) return null;
      const rel = path.relative(dataRoot, full).split(path.sep).join("/");
      return {
        name: f,
        path: full,
        url: `/files/${rel}`,
        size: st.size,
        mtime: st.mtimeMs,
        kind: mediaKind(f),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Encode cwd the same way Grok Build names session parent dirs:
 * encodeURIComponent(absolutePath) e.g. %2FUsers%2Ffutjr%2Fgrok-studio
 */
export function encodeSessionCwd(cwd) {
  return encodeURIComponent(path.resolve(cwd));
}

/**
 * Copy a media file into destDir with a unique name. Returns dest path.
 * Throws if source missing or not a media file.
 */
export function copyMedia(src, destDir) {
  if (!fs.existsSync(src)) {
    throw new Error(`media source missing: ${src}`);
  }
  if (!isMediaFile(src)) {
    throw new Error(`not a media file: ${src}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(
    destDir,
    `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(path.basename(src))}`,
  );
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * Extract absolute media paths mentioned in agent text and copy into destDir.
 * Patterns:
 *   OUTPUT: /abs/path.png
 *   saved/wrote/… to `/abs/path.png` or "/abs/path.png"
 *   bare absolute paths ending in media extensions (conservative)
 */
export function harvestFromText(text, destDir, seenSources = new Set()) {
  if (!text) return [];
  const found = new Set();

  const reOutput = /OUTPUT:\s*([^\s\n]+)/gi;
  let m;
  while ((m = reOutput.exec(text))) {
    found.add(m[1].replace(/[.,;)"'`]+$/, ""));
  }

  const reSaved =
    /(?:saved|wrote|written|output|path)[^\n]{0,60}?[`"](\/[^`"\n]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov))[`"]/gi;
  while ((m = reSaved.exec(text))) {
    found.add(m[1]);
  }

  const copied = [];
  for (const p of found) {
    if (!path.isAbsolute(p) || !fs.existsSync(p) || !isMediaFile(p)) continue;
    const resolved = path.resolve(p);
    if (seenSources.has(resolved)) continue;
    seenSources.add(resolved);
    copied.push(copyMedia(resolved, destDir));
  }
  return copied;
}

/**
 * Harvest media from a Grok session directory.
 * Prefer sessionId when known: sessionsRoot/encodedCwd/sessionId/{images,videos}
 * Fallback: all session dirs under encodedCwd with mtime >= sinceMs
 */
export function harvestFromSession({
  sessionsRoot,
  cwd,
  sessionId,
  sinceMs,
  destDir,
  seenSources = new Set(),
}) {
  const parent = path.join(sessionsRoot, encodeSessionCwd(cwd));
  if (!fs.existsSync(parent)) return [];

  const sessionDirs = [];
  if (sessionId) {
    const d = path.join(parent, sessionId);
    if (fs.existsSync(d)) sessionDirs.push(d);
  } else {
    for (const name of fs.readdirSync(parent)) {
      const d = path.join(parent, name);
      const st = fs.statSync(d);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs + 1000 < sinceMs) continue;
      sessionDirs.push(d);
    }
  }

  const copied = [];
  for (const sessionDir of sessionDirs) {
    for (const sub of ["images", "videos"]) {
      const dir = path.join(sessionDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!isMediaFile(f)) continue;
        const full = path.resolve(path.join(dir, f));
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (st.mtimeMs + 500 < sinceMs) continue;
        if (seenSources.has(full)) continue;
        seenSources.add(full);
        copied.push(copyMedia(full, destDir));
      }
    }
  }
  return copied;
}

export function isImageUpload(file) {
  return (
    /^image\//.test(file.mimetype || "") || isImageFile(file.originalname || "")
  );
}
