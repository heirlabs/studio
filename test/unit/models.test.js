import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseModelsCache,
  listModels,
  selectModelForTask,
  normalizeReasoningEffort,
  BUILTIN_MODELS,
} from "../../server/lib/models.js";

describe("models", () => {
  let dir;
  let cachePath;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-mod-"));
    cachePath = path.join(dir, "models_cache.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        models: {
          "grok-4.5": {
            info: {
              id: "grok-4.5",
              name: "Grok 4.5",
              context_window: 500000,
              supports_reasoning_effort: true,
              reasoning_efforts: [
                { value: "high", default: true },
                { value: "medium" },
                { value: "low" },
              ],
            },
          },
          "hidden-model": {
            info: { id: "hidden-model", hidden: true },
          },
        },
      }),
    );
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses cache and hides hidden models", () => {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const list = parseModelsCache(raw);
    assert.ok(list.some((m) => m.id === "grok-4.5"));
    assert.ok(!list.some((m) => m.id === "hidden-model"));
    assert.deepEqual(
      list.find((m) => m.id === "grok-4.5").reasoningEfforts,
      ["high", "medium", "low"],
    );
  });

  it("lists models with builtins fallback", () => {
    const list = listModels({ cachePath });
    assert.ok(list.length >= 1);
    assert.ok(list.some((m) => m.id === BUILTIN_MODELS[0].id));
  });

  it("selects low effort for quick tasks", () => {
    const pick = selectModelForTask("quick typo fix please", { cachePath });
    assert.equal(pick.ruleId, "quick");
    assert.equal(pick.reasoningEffort, "low");
  });

  it("selects high effort for review", () => {
    const pick = selectModelForTask("security audit this module", {
      cachePath,
    });
    assert.equal(pick.ruleId, "review");
    assert.equal(pick.reasoningEffort, "high");
  });

  it("normalizes reasoning effort", () => {
    assert.equal(normalizeReasoningEffort("HIGH"), "high");
    assert.equal(normalizeReasoningEffort("off"), null);
    assert.equal(normalizeReasoningEffort(""), null);
    assert.throws(() => normalizeReasoningEffort("extreme"), /Invalid/);
  });
});
