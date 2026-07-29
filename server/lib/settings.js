/**
 * Layered settings: defaults < user < project < local (session data).
 * Scopes:
 *   user    → ~/.grok-studio/settings.json
 *   project → <projectCwd>/.grok-studio/settings.json
 *   local   → <dataDir>/settings.local.json
 */
import fs from "fs";
import path from "path";
import os from "os";
import {
  PERMISSION_MODES,
  normalizePermissionMode,
} from "./permissions.js";

export const DEFAULT_SETTINGS = {
  permissionMode: "bypassPermissions",
  model: "grok-4.5",
  reasoningEffort: "high",
  extendedThinking: true,
  maxTurns: null,
  maxBudgetUsd: null,
  sandbox: null,
  allowRules: [],
  denyRules: [],
  disableWebSearch: false,
  noSubagents: false,
  // Reserved: Grok CLI has no --forward-subagent-text; kept for UI/settings parity
  forwardSubagentText: false,
  agent: null,
  provider: {
    gatewayUrl: null,
    xaiApiBaseUrl: null,
    cliChatProxyBaseUrl: null,
  },
  notifications: {
    onRunComplete: true,
    onRunFail: true,
    sound: false,
  },
  background: {
    default: false,
  },
  ssh: {
    defaultConnectionId: null,
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function userSettingsPath(home = os.homedir()) {
  return path.join(home, ".grok-studio", "settings.json");
}

export function projectSettingsPath(projectCwd) {
  if (!projectCwd) return null;
  return path.join(projectCwd, ".grok-studio", "settings.json");
}

export function localSettingsPath(dataDir) {
  return path.join(dataDir, "settings.local.json");
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Validate and coerce a settings patch.
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const err = new Error("settings must be an object");
    err.status = 400;
    throw err;
  }
  const out = {};
  if (patch.permissionMode != null) {
    out.permissionMode = normalizePermissionMode(patch.permissionMode);
  }
  if (patch.model != null) out.model = String(patch.model).trim() || null;
  if (patch.reasoningEffort != null) {
    const e = String(patch.reasoningEffort).toLowerCase();
    if (!["low", "medium", "high", "off", ""].includes(e)) {
      const err = new Error("reasoningEffort must be low|medium|high|off");
      err.status = 400;
      throw err;
    }
    out.reasoningEffort = e === "off" || e === "" ? null : e;
  }
  if (patch.extendedThinking != null)
    out.extendedThinking = Boolean(patch.extendedThinking);
  if (patch.maxTurns !== undefined) {
    if (
      patch.maxTurns === null ||
      patch.maxTurns === "" ||
      patch.maxTurns === false
    ) {
      out.maxTurns = null;
    } else {
      const n = Number(patch.maxTurns);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        const err = new Error("maxTurns must be an integer 1–500");
        err.status = 400;
        throw err;
      }
      out.maxTurns = n;
    }
  }
  if (patch.maxBudgetUsd !== undefined) {
    if (
      patch.maxBudgetUsd === null ||
      patch.maxBudgetUsd === "" ||
      patch.maxBudgetUsd === false
    ) {
      out.maxBudgetUsd = null;
    } else {
      const n = Number(patch.maxBudgetUsd);
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error("maxBudgetUsd must be a non-negative number");
        err.status = 400;
        throw err;
      }
      out.maxBudgetUsd = n;
    }
  }
  if (patch.sandbox != null) {
    const s = String(patch.sandbox).trim();
    out.sandbox = s === "" || s === "none" ? null : s;
  }
  if (patch.allowRules != null) {
    if (!Array.isArray(patch.allowRules)) {
      const err = new Error("allowRules must be an array");
      err.status = 400;
      throw err;
    }
    out.allowRules = patch.allowRules.map(String);
  }
  if (patch.denyRules != null) {
    if (!Array.isArray(patch.denyRules)) {
      const err = new Error("denyRules must be an array");
      err.status = 400;
      throw err;
    }
    out.denyRules = patch.denyRules.map(String);
  }
  if (patch.disableWebSearch != null)
    out.disableWebSearch = Boolean(patch.disableWebSearch);
  if (patch.noSubagents != null) out.noSubagents = Boolean(patch.noSubagents);
  if (patch.forwardSubagentText != null)
    out.forwardSubagentText = Boolean(patch.forwardSubagentText);
  if (patch.agent != null) out.agent = String(patch.agent).trim() || null;
  if (patch.provider != null) {
    if (typeof patch.provider !== "object") {
      const err = new Error("provider must be an object");
      err.status = 400;
      throw err;
    }
    out.provider = {};
    for (const k of ["gatewayUrl", "xaiApiBaseUrl", "cliChatProxyBaseUrl"]) {
      if (patch.provider[k] !== undefined) {
        const v = patch.provider[k];
        out.provider[k] = v == null || v === "" ? null : String(v);
      }
    }
  }
  if (patch.notifications != null) {
    out.notifications = { ...patch.notifications };
  }
  if (patch.background != null) {
    out.background = { ...patch.background };
  }
  if (patch.ssh != null) {
    out.ssh = { ...patch.ssh };
  }
  return out;
}

export function loadSettings({ dataDir, projectCwd, home = os.homedir() } = {}) {
  const layers = {
    defaults: { ...DEFAULT_SETTINGS, provider: { ...DEFAULT_SETTINGS.provider } },
    user: readJsonFile(userSettingsPath(home)),
    project: projectCwd ? readJsonFile(projectSettingsPath(projectCwd)) : {},
    local: dataDir ? readJsonFile(localSettingsPath(dataDir)) : {},
  };
  let merged = layers.defaults;
  merged = deepMerge(merged, layers.user);
  merged = deepMerge(merged, layers.project);
  merged = deepMerge(merged, layers.local);
  // normalize
  merged.permissionMode = normalizePermissionMode(merged.permissionMode);
  return {
    settings: merged,
    layers,
    paths: {
      user: userSettingsPath(home),
      project: projectSettingsPath(projectCwd),
      local: dataDir ? localSettingsPath(dataDir) : null,
    },
  };
}

/**
 * Write a patch to one scope and return full merged settings.
 */
export function saveSettings(scope, patch, { dataDir, projectCwd, home = os.homedir() } = {}) {
  const validated = validateSettingsPatch(patch);
  let filePath;
  if (scope === "user") filePath = userSettingsPath(home);
  else if (scope === "project") {
    if (!projectCwd) {
      const err = new Error("project cwd required for project settings");
      err.status = 400;
      throw err;
    }
    filePath = projectSettingsPath(projectCwd);
  } else if (scope === "local") {
    if (!dataDir) {
      const err = new Error("dataDir required for local settings");
      err.status = 400;
      throw err;
    }
    filePath = localSettingsPath(dataDir);
  } else {
    const err = new Error("scope must be user|project|local");
    err.status = 400;
    throw err;
  }
  const existing = readJsonFile(filePath);
  const next = deepMerge(existing, validated);
  writeJsonFile(filePath, next);
  return loadSettings({ dataDir, projectCwd, home });
}

export { PERMISSION_MODES };
