/**
 * Multi-model catalog + selection rules.
 * Reads ~/.grok/models_cache.json when present; always includes grok-4.5.
 */
import fs from "fs";
import path from "path";
import os from "os";

export const BUILTIN_MODELS = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    description: "Frontier coding model (default)",
    contextWindow: 500000,
    supportsReasoningEffort: true,
    reasoningEfforts: ["high", "medium", "low"],
    defaultReasoningEffort: "high",
    tier: "frontier",
  },
];

/** Task complexity → preferred model / effort */
export const SELECTION_RULES = [
  {
    id: "quick",
    match: /\b(typo|rename|one.?line|quick|simple|explain briefly)\b/i,
    model: "grok-4.5",
    reasoningEffort: "low",
  },
  {
    id: "review",
    match: /\b(review|audit|security|threat|cso)\b/i,
    model: "grok-4.5",
    reasoningEffort: "high",
  },
  {
    id: "implement",
    match: /\b(implement|build|feature|refactor|migrate|architect)\b/i,
    model: "grok-4.5",
    reasoningEffort: "high",
  },
  {
    id: "debug",
    match: /\b(bug|fix|broken|error|crash|failing|stack.?trace)\b/i,
    model: "grok-4.5",
    reasoningEffort: "high",
  },
  {
    id: "balanced",
    match: /.*/,
    model: "grok-4.5",
    reasoningEffort: "medium",
  },
];

export function defaultModelsCachePath(home = os.homedir()) {
  return path.join(home, ".grok", "models_cache.json");
}

/**
 * Parse models_cache.json into a normalized list.
 */
export function parseModelsCache(raw) {
  if (!raw || typeof raw !== "object") return [];
  const models = raw.models || {};
  const out = [];
  for (const [id, entry] of Object.entries(models)) {
    const info = entry?.info || entry || {};
    const efforts = Array.isArray(info.reasoning_efforts)
      ? info.reasoning_efforts.map((e) => e.value || e.id).filter(Boolean)
      : info.supports_reasoning_effort
        ? ["high", "medium", "low"]
        : [];
    const defaultEffort =
      (Array.isArray(info.reasoning_efforts) &&
        info.reasoning_efforts.find((e) => e.default)?.value) ||
      info.reasoning_effort ||
      (efforts[0] || null);
    out.push({
      id: info.id || info.model || id,
      name: info.name || id,
      description: info.description || "",
      contextWindow: info.context_window || null,
      supportsReasoningEffort: Boolean(info.supports_reasoning_effort),
      reasoningEfforts: efforts,
      defaultReasoningEffort: defaultEffort,
      tier: info.agent_type || "standard",
      hidden: Boolean(info.hidden),
      supportedInApi: info.supported_in_api !== false,
    });
  }
  return out.filter((m) => !m.hidden);
}

export function loadModelsFromDisk(cachePath = defaultModelsCachePath()) {
  if (!fs.existsSync(cachePath)) return [];
  const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  return parseModelsCache(raw);
}

/**
 * Merge disk cache with builtins. Disk wins on id collision.
 */
export function listModels(options = {}) {
  const cachePath = options.cachePath || defaultModelsCachePath();
  const fromDisk = loadModelsFromDisk(cachePath);
  const byId = new Map();
  for (const m of BUILTIN_MODELS) byId.set(m.id, m);
  for (const m of fromDisk) byId.set(m.id, m);
  return [...byId.values()];
}

/**
 * Normalize reasoning effort. Empty → null (use model default).
 */
export function normalizeReasoningEffort(effort, model) {
  if (effort == null || effort === "" || effort === "off") return null;
  const e = String(effort).toLowerCase();
  if (!["low", "medium", "high"].includes(e)) {
    const err = new Error(
      `Invalid reasoning effort: ${effort}. Expected low|medium|high|off`,
    );
    err.status = 400;
    throw err;
  }
  if (model && model.supportsReasoningEffort === false) return null;
  return e;
}

/**
 * Pick model + effort from task text using selection rules.
 */
export function selectModelForTask(prompt, options = {}) {
  const text = String(prompt || "");
  const models = listModels(options);
  for (const rule of SELECTION_RULES) {
    if (!rule.match.test(text)) continue;
    const model =
      models.find((m) => m.id === rule.model) || models[0] || BUILTIN_MODELS[0];
    return {
      ruleId: rule.id,
      model: model.id,
      reasoningEffort: rule.reasoningEffort,
      modelInfo: model,
    };
  }
  const fallback = models[0] || BUILTIN_MODELS[0];
  return {
    ruleId: "default",
    model: fallback.id,
    reasoningEffort: fallback.defaultReasoningEffort || "medium",
    modelInfo: fallback,
  };
}
