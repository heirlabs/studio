/**
 * Read the Grok CLI's own config (~/.grok/config.toml).
 *
 * Why this exists: `grok agent stdio` accepts no `--permission-mode`, so a
 * config-level `permission_mode = "always-approve"` (or `yolo = true`) wins
 * over whatever mode Studio selected. Without surfacing that, the UI would
 * show "mode: ask" while every tool call is auto-approved.
 */
import fs from "fs";
import path from "path";
import os from "os";

export function grokConfigPath(home = os.homedir()) {
  return path.join(home, ".grok", "config.toml");
}

/**
 * Minimal TOML scan for the few scalar keys we care about. Deliberately not a
 * TOML parser: we only read top-level-style `key = value` lines and ignore
 * comments, which is all these settings ever are.
 */
export function parseGrokConfig(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const stripped = line.replace(/#.*$/, "").trim();
    const m = stripped.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^-?\d+$/.test(value)) value = Number(value);
    out[m[1]] = value;
  }
  return out;
}

/** Config values that make the CLI skip interactive approval entirely. */
const ALWAYS_APPROVE_VALUES = new Set([
  "always-approve",
  "always_approve",
  "bypassPermissions",
  "yolo",
]);

/**
 * Describe the CLI's approval posture.
 * @returns {{ path: string, exists: boolean, permissionMode: string|null,
 *   yolo: boolean, forcesAlwaysApprove: boolean }}
 */
export function readCliApprovalPolicy(home = os.homedir()) {
  const p = grokConfigPath(home);
  if (!fs.existsSync(p)) {
    return {
      path: p,
      exists: false,
      permissionMode: null,
      yolo: false,
      forcesAlwaysApprove: false,
    };
  }
  const cfg = parseGrokConfig(fs.readFileSync(p, "utf8"));
  const permissionMode =
    cfg.permission_mode != null ? String(cfg.permission_mode) : null;
  const yolo = cfg.yolo === true;
  return {
    path: p,
    exists: true,
    permissionMode,
    yolo,
    forcesAlwaysApprove:
      yolo || (permissionMode != null && ALWAYS_APPROVE_VALUES.has(permissionMode)),
  };
}

/**
 * Whether the studio-selected mode will actually be honored by the CLI.
 * Only interactive modes are undermined by a forced always-approve.
 */
export function describeApprovalConflict(selectedMode, policy) {
  const interactive =
    selectedMode === "default" ||
    selectedMode === "acceptEdits" ||
    selectedMode === "plan" ||
    selectedMode === "dontAsk";
  if (!policy?.forcesAlwaysApprove || !interactive) {
    return { conflict: false, message: null };
  }
  const source = policy.yolo ? "yolo = true" : `permission_mode = "${policy.permissionMode}"`;
  return {
    conflict: true,
    message:
      `Grok CLI config (${policy.path}) sets ${source}, which auto-approves ` +
      `every tool call. The selected "${selectedMode}" mode will not prompt.`,
  };
}
