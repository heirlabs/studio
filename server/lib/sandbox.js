/**
 * Sandbox profiles for tool execution safety.
 * Maps to grok --sandbox <profile> plus allow/deny rules.
 */
export const SANDBOX_PROFILES = {
  none: {
    id: "none",
    label: "None",
    description: "No sandbox — full host access (default when unset)",
    cliValue: null,
  },
  "read-only": {
    id: "read-only",
    label: "Read only",
    description: "Filesystem read-only; no network writes",
    cliValue: "read-only",
    denyRules: ["Bash(rm *)", "Bash(sudo *)", "Edit", "Write"],
  },
  "workspace-write": {
    id: "workspace-write",
    label: "Workspace write",
    description: "Write only inside project cwd; limited network",
    cliValue: "workspace-write",
  },
  full: {
    id: "full",
    label: "Full",
    description: "Sandboxed but with broad write + network for agent work",
    cliValue: "full",
  },
};

export function normalizeSandbox(profile) {
  if (profile == null || profile === "" || profile === "none") return null;
  const id = String(profile).trim();
  if (!SANDBOX_PROFILES[id] && id !== "none") {
    // allow passthrough of custom grok sandbox names
    return id;
  }
  if (id === "none") return null;
  return id;
}

/**
 * Build CLI args for sandbox + allow/deny rules.
 */
export function sandboxToCliArgs({
  sandbox,
  allowRules = [],
  denyRules = [],
} = {}) {
  const args = [];
  const profile = normalizeSandbox(sandbox);
  if (profile) {
    args.push("--sandbox", profile);
  }
  const profileMeta = SANDBOX_PROFILES[profile];
  const mergedDeny = [
    ...(profileMeta?.denyRules || []),
    ...denyRules,
  ];
  for (const rule of allowRules) {
    if (rule) args.push("--allow", String(rule));
  }
  for (const rule of mergedDeny) {
    if (rule) args.push("--deny", String(rule));
  }
  return { args, profile, denyRules: mergedDeny };
}

/**
 * Policy check before allowing certain high-risk operations at studio layer.
 * Returns { allowed, reason }.
 */
export function evaluateToolPolicy(toolName, { permissionMode, sandbox } = {}) {
  const tool = String(toolName || "").toLowerCase();
  if (permissionMode === "plan") {
    const blocked = [
      "edit",
      "write",
      "delete",
      "bash",
      "shell",
      "run_terminal",
      "spawn",
    ];
    if (blocked.some((b) => tool.includes(b))) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" blocked in plan permission mode`,
      };
    }
  }
  if (sandbox === "read-only") {
    if (
      tool.includes("edit") ||
      tool.includes("write") ||
      tool.includes("delete")
    ) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" blocked in read-only sandbox`,
      };
    }
  }
  return { allowed: true, reason: null };
}
