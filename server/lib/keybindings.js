/**
 * Context-aware keybinding system (Claude Desktop–style).
 * Config: ~/.grok-studio/keybindings.json or studio data/keybindings.json
 *
 * 17 contexts control when a binding is active.
 * Two actions are hardcoded and cannot be rebound: forceCancel, emergencyStop.
 */
import fs from "fs";
import path from "path";
import os from "os";

export const KEYBINDING_CONTEXTS = [
  "global",
  "chat",
  "composer",
  "transcript",
  "transcriptViewer",
  "historySearch",
  "sessionList",
  "settings",
  "modal",
  "permissionPrompt",
  "running",
  "idle",
  "planMode",
  "toolOutput",
  "sshManager",
  "checkpointPicker",
  "agentPicker",
];

/** Actions that cannot be rebound */
export const HARDCODED_ACTIONS = new Set(["forceCancel", "emergencyStop"]);

export const DEFAULT_KEYBINDINGS = [
  // global
  { key: "ctrl+c", command: "cancelTurn", when: "running", hardcoded: false },
  { key: "ctrl+c", command: "forceCancel", when: "running", hardcoded: true },
  { key: "escape", command: "emergencyStop", when: "running", hardcoded: true },
  { key: "ctrl+r", command: "historySearch", when: "global" },
  { key: "ctrl+o", command: "openTranscriptViewer", when: "global" },
  { key: "alt+t", command: "toggleExtendedThinking", when: "global" },
  { key: "shift+tab", command: "cyclePermissionMode", when: "global" },
  { key: "ctrl+n", command: "newSession", when: "global" },
  { key: "ctrl+k", command: "focusComposer", when: "global" },
  { key: "ctrl+,", command: "openSettings", when: "global" },
  { key: "ctrl+b", command: "toggleBackground", when: "chat" },
  { key: "ctrl+shift+p", command: "commandPalette", when: "global" },
  { key: "ctrl+shift+s", command: "openSshManager", when: "global" },
  { key: "ctrl+shift+a", command: "openAgentPicker", when: "global" },
  { key: "ctrl+shift+c", command: "createCheckpoint", when: "chat" },
  { key: "enter", command: "sendMessage", when: "composer" },
  { key: "shift+enter", command: "insertNewline", when: "composer" },
  { key: "up", command: "historyPrev", when: "composer" },
  { key: "down", command: "historyNext", when: "composer" },
  { key: "ctrl+p", command: "historyPrev", when: "historySearch" },
  { key: "ctrl+n", command: "historyNext", when: "historySearch" },
  { key: "enter", command: "historyAccept", when: "historySearch" },
  { key: "escape", command: "closeModal", when: "modal" },
  { key: "escape", command: "closeModal", when: "transcriptViewer" },
  { key: "escape", command: "closeModal", when: "historySearch" },
  { key: "ctrl+1", command: "selectSession1", when: "sessionList" },
  { key: "ctrl+2", command: "selectSession2", when: "sessionList" },
  { key: "ctrl+3", command: "selectSession3", when: "sessionList" },
  { key: "ctrl+/", command: "showKeybindingsHelp", when: "global" },
];

export function defaultKeybindingsPath(home = os.homedir()) {
  return path.join(home, ".grok-studio", "keybindings.json");
}

/**
 * Normalize a single key stroke: "Cmd+Shift+O" → "meta+shift+o"
 */
function normalizeSingleStroke(stroke) {
  const parts = stroke
    .toLowerCase()
    .replace(/\s+/g, "")
    .split(/[+\-]/)
    .filter(Boolean)
    .map((p) => {
      if (p === "cmd" || p === "command" || p === "super" || p === "win")
        return "meta";
      if (p === "control" || p === "ctl") return "ctrl";
      if (p === "option" || p === "opt") return "alt";
      if (p === "return") return "enter";
      if (p === "esc") return "escape";
      if (p === "spacebar") return "space";
      return p;
    });

  const mods = [];
  let key = "";
  for (const p of parts) {
    if (p === "ctrl" || p === "alt" || p === "shift" || p === "meta") {
      if (!mods.includes(p)) mods.push(p);
    } else {
      key = p;
    }
  }
  if (!key) {
    const err = new Error(`invalid key chord: ${stroke}`);
    err.status = 400;
    throw err;
  }
  const order = ["ctrl", "alt", "shift", "meta"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join("+");
}

/**
 * Normalize a key chord string: "Cmd+Shift+O" → "meta+shift+o"
 * Chord sequences use space: "ctrl+k ctrl+s" → "ctrl+k ctrl+s"
 */
export function normalizeKeyChord(chord) {
  if (!chord || typeof chord !== "string") {
    const err = new Error("key chord required");
    err.status = 400;
    throw err;
  }
  // Multi-stroke sequences are space-separated (after collapsing internal spaces
  // around +). Split on whitespace that separates strokes.
  const trimmed = chord.trim().replace(/\s+/g, " ");
  const strokes = trimmed.split(" ").filter(Boolean);
  if (strokes.length === 0) {
    const err = new Error(`invalid key chord: ${chord}`);
    err.status = 400;
    throw err;
  }
  return strokes.map(normalizeSingleStroke).join(" ");
}

/**
 * Whether a binding key is a multi-stroke chord sequence.
 */
export function isChordSequence(key) {
  return String(key || "").includes(" ");
}

/**
 * Build chord from a KeyboardEvent-like object.
 */
export function chordFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  let key = String(e.key || "").toLowerCase();
  if (key === " ") key = "space";
  if (key === "esc") key = "escape";
  if (key.length === 1 || ["enter", "escape", "tab", "space", "up", "down", "left", "right", "backspace", "delete"].includes(key)) {
    return normalizeKeyChord([...mods, key].join("+"));
  }
  // Named keys like "ArrowUp"
  if (key.startsWith("arrow")) key = key.replace("arrow", "");
  return normalizeKeyChord([...mods, key].join("+"));
}

function validateBinding(b, index) {
  if (!b || typeof b !== "object") {
    const err = new Error(`keybinding[${index}] must be an object`);
    err.status = 400;
    throw err;
  }
  if (!b.key || !b.command) {
    const err = new Error(`keybinding[${index}] requires key and command`);
    err.status = 400;
    throw err;
  }
  const when = b.when || "global";
  if (!KEYBINDING_CONTEXTS.includes(when)) {
    const err = new Error(
      `keybinding[${index}] invalid when context: ${when}`,
    );
    err.status = 400;
    throw err;
  }
  return {
    key: normalizeKeyChord(b.key),
    command: String(b.command),
    when,
    hardcoded: Boolean(b.hardcoded) || HARDCODED_ACTIONS.has(b.command),
    args: b.args || undefined,
  };
}

/**
 * Load keybindings: defaults merged with user file overrides.
 * User file can be an array of bindings or { bindings: [...] }.
 * Bindings with the same key+when replace defaults.
 * Attempting to rebind hardcoded actions is rejected.
 */
export function loadKeybindings(filePath) {
  const defaults = DEFAULT_KEYBINDINGS.map((b, i) => validateBinding(b, i));
  if (!filePath || !fs.existsSync(filePath)) {
    return { path: filePath || null, bindings: defaults, source: "defaults" };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.bindings;
  if (!Array.isArray(list)) {
    const err = new Error("keybindings.json must be an array or { bindings: [] }");
    err.status = 400;
    throw err;
  }
  const custom = list.map((b, i) => validateBinding(b, i));

  // Reject attempts to rebind hardcoded commands to different keys
  for (const c of custom) {
    if (!HARDCODED_ACTIONS.has(c.command)) continue;
    const def = defaults.find((d) => d.command === c.command && d.hardcoded);
    if (def && def.key !== c.key) {
      const err = new Error(
        `Command "${c.command}" is hardcoded to ${def.key} and cannot be rebound`,
      );
      err.status = 400;
      throw err;
    }
  }

  const map = new Map();
  for (const b of defaults) map.set(`${b.when}::${b.key}`, b);
  for (const b of custom) {
    // Hardcoded slots always stay
    if (b.hardcoded && HARDCODED_ACTIONS.has(b.command)) {
      map.set(`${b.when}::${b.key}`, { ...b, hardcoded: true });
      continue;
    }
    // Don't allow custom binding to overwrite a hardcoded key slot with another command
    const existing = map.get(`${b.when}::${b.key}`);
    if (existing?.hardcoded) continue;
    map.set(`${b.when}::${b.key}`, b);
  }

  // Ensure hardcoded defaults always present
  for (const b of defaults) {
    if (b.hardcoded) map.set(`${b.when}::${b.key}`, b);
  }

  return {
    path: filePath,
    bindings: [...map.values()],
    source: "file",
  };
}

export function saveKeybindings(filePath, bindings) {
  if (!filePath) {
    const err = new Error("keybindings path required");
    err.status = 400;
    throw err;
  }
  const validated = (bindings || []).map((b, i) => validateBinding(b, i));
  for (const b of validated) {
    if (HARDCODED_ACTIONS.has(b.command)) {
      const def = DEFAULT_KEYBINDINGS.find((d) => d.command === b.command);
      if (def && normalizeKeyChord(def.key) !== b.key) {
        const err = new Error(
          `Command "${b.command}" is hardcoded and cannot be rebound`,
        );
        err.status = 400;
        throw err;
      }
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    version: 1,
    bindings: validated.filter((b) => !b.hardcoded),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return loadKeybindings(filePath);
}

/**
 * Resolve which command fires for a chord given active contexts.
 * More specific contexts win over global; first match in reverse context priority.
 * `chord` may be a single stroke or a space-separated sequence buffer.
 */
export function resolveBinding(bindings, chord, activeContexts = ["global"]) {
  const key = normalizeKeyChord(chord);
  const contexts = new Set(activeContexts);
  contexts.add("global");

  // Priority: non-global contexts first (order given), then global
  const ordered = [
    ...activeContexts.filter((c) => c !== "global"),
    "global",
  ];

  for (const ctx of ordered) {
    if (!contexts.has(ctx)) continue;
    const hit = bindings.find((b) => b.when === ctx && b.key === key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Partial-match helpers for multi-stroke chord sequences.
 * Returns true if any binding starts with the current buffer + more strokes.
 */
export function hasChordPrefix(bindings, buffer, activeContexts = ["global"]) {
  if (!buffer) return false;
  const prefix = normalizeKeyChord(buffer) + " ";
  const contexts = new Set([...activeContexts, "global"]);
  return bindings.some(
    (b) =>
      contexts.has(b.when) &&
      isChordSequence(b.key) &&
      b.key.startsWith(prefix),
  );
}

/**
 * Create a chord-sequence state machine for keyboard input.
 * timeoutMs: how long to wait for the next stroke (default 1000).
 */
export function createChordTracker({
  bindings,
  getContexts = () => ["global"],
  timeoutMs = 1000,
  now = () => Date.now(),
} = {}) {
  let buffer = "";
  let lastAt = 0;

  function reset() {
    buffer = "";
    lastAt = 0;
  }

  /**
   * Feed a single stroke. Returns:
   *   { type: "match", binding }
   *   { type: "prefix" }  — waiting for more strokes
   *   { type: "none" }
   */
  function feed(stroke) {
    const t = now();
    if (buffer && t - lastAt > timeoutMs) reset();
    const strokeNorm = normalizeKeyChord(stroke);
    const candidate = buffer ? `${buffer} ${strokeNorm}` : strokeNorm;
    const contexts = getContexts();

    const exact = resolveBinding(bindings, candidate, contexts);
    if (exact) {
      reset();
      return { type: "match", binding: exact, chord: candidate };
    }
    if (hasChordPrefix(bindings, candidate, contexts)) {
      buffer = candidate;
      lastAt = t;
      return { type: "prefix", chord: candidate };
    }
    // Fall back: if buffer was set, try stroke alone as a fresh start
    if (buffer) {
      reset();
      const alone = resolveBinding(bindings, strokeNorm, contexts);
      if (alone) {
        return { type: "match", binding: alone, chord: strokeNorm };
      }
      if (hasChordPrefix(bindings, strokeNorm, contexts)) {
        buffer = strokeNorm;
        lastAt = t;
        return { type: "prefix", chord: strokeNorm };
      }
    }
    return { type: "none", chord: candidate };
  }

  return { feed, reset, getBuffer: () => buffer };
}

/**
 * Resolve keybindings path: explicit → data dir → user home.
 */
export function resolveKeybindingsPath(cfg) {
  if (cfg?.keybindingsPath) return cfg.keybindingsPath;
  const userPath = defaultKeybindingsPath();
  if (fs.existsSync(userPath)) return userPath;
  if (cfg?.data) {
    const dataPath = path.join(cfg.data, "keybindings.json");
    if (fs.existsSync(dataPath)) return dataPath;
    return userPath;
  }
  return userPath;
}
