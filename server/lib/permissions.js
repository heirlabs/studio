/**
 * Permission modes for the agent loop (aligned with grok --permission-mode).
 * Shift+Tab cycles modes in the UI.
 */

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];

export const PERMISSION_META = {
  default: {
    id: "default",
    label: "Default",
    short: "ask",
    description: "Prompt before tool executions that need approval",
  },
  acceptEdits: {
    id: "acceptEdits",
    label: "Accept edits",
    short: "edits",
    description: "Auto-approve file edits; ask for shell/network",
  },
  plan: {
    id: "plan",
    label: "Plan",
    short: "plan",
    description: "Read-only planning — no writes or destructive tools",
  },
  auto: {
    id: "auto",
    label: "Auto",
    short: "auto",
    description: "Auto-approve common safe tools",
  },
  dontAsk: {
    id: "dontAsk",
    label: "Don't ask",
    short: "quiet",
    description: "Skip interactive prompts; deny unknown tools",
  },
  bypassPermissions: {
    id: "bypassPermissions",
    label: "Bypass",
    short: "yolo",
    description: "Auto-approve all tools (equivalent to --always-approve)",
  },
};

/**
 * Normalize a mode string. Unknown values throw.
 */
export function normalizePermissionMode(mode) {
  if (mode == null || mode === "") return "default";
  const raw = String(mode).trim();
  // legacy UI checkbox
  if (raw === "true" || raw === "yolo") return "bypassPermissions";
  if (raw === "false") return "default";
  if (!PERMISSION_MODES.includes(raw)) {
    const err = new Error(
      `Invalid permission mode: ${raw}. Expected one of: ${PERMISSION_MODES.join(", ")}`,
    );
    err.status = 400;
    throw err;
  }
  return raw;
}

/**
 * Cycle to the next mode (Shift+Tab).
 */
export function cyclePermissionMode(current) {
  const mode = normalizePermissionMode(current);
  const idx = PERMISSION_MODES.indexOf(mode);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
}

/**
 * Build CLI argv fragments for permission mode.
 * Returns { args: string[], alwaysApprove: boolean }
 */
export function permissionModeToCliArgs(mode) {
  const m = normalizePermissionMode(mode);
  if (m === "bypassPermissions") {
    return {
      mode: m,
      args: ["--permission-mode", "bypassPermissions", "--always-approve"],
      alwaysApprove: true,
    };
  }
  return {
    mode: m,
    args: ["--permission-mode", m],
    alwaysApprove: false,
  };
}

/**
 * Whether the mode is effectively unrestricted.
 */
export function isBypassMode(mode) {
  return normalizePermissionMode(mode) === "bypassPermissions";
}
