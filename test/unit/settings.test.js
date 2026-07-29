import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadSettings,
  saveSettings,
  validateSettingsPatch,
  DEFAULT_SETTINGS,
} from "../../server/lib/settings.js";

describe("settings layers", () => {
  let home;
  let data;
  let project;
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-set-home-"));
    data = fs.mkdtempSync(path.join(os.tmpdir(), "gs-set-data-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "gs-set-proj-"));
  });
  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("returns defaults when no files", () => {
    const { settings } = loadSettings({ dataDir: data, home });
    assert.equal(settings.model, DEFAULT_SETTINGS.model);
    assert.equal(settings.permissionMode, DEFAULT_SETTINGS.permissionMode);
  });

  it("validates maxTurns bounds", () => {
    assert.throws(() => validateSettingsPatch({ maxTurns: 0 }), /maxTurns/);
    assert.throws(() => validateSettingsPatch({ maxTurns: 9999 }), /maxTurns/);
    assert.equal(validateSettingsPatch({ maxTurns: 10 }).maxTurns, 10);
  });

  it("merges user < project < local", () => {
    saveSettings(
      "user",
      { model: "user-model", maxTurns: 5 },
      { dataDir: data, projectCwd: project, home },
    );
    saveSettings(
      "project",
      { model: "project-model" },
      { dataDir: data, projectCwd: project, home },
    );
    saveSettings(
      "local",
      { maxBudgetUsd: 2.5 },
      { dataDir: data, projectCwd: project, home },
    );
    const { settings } = loadSettings({
      dataDir: data,
      projectCwd: project,
      home,
    });
    assert.equal(settings.model, "project-model");
    assert.equal(settings.maxTurns, 5);
    assert.equal(settings.maxBudgetUsd, 2.5);
  });

  it("rejects invalid scope", () => {
    assert.throws(
      () => saveSettings("global", { model: "x" }, { dataDir: data, home }),
      /scope/,
    );
  });

  it("clears maxBudgetUsd when set to null", () => {
    saveSettings(
      "local",
      { maxBudgetUsd: 0.001 },
      { dataDir: data, projectCwd: project, home },
    );
    let loaded = loadSettings({ dataDir: data, projectCwd: project, home });
    assert.equal(loaded.settings.maxBudgetUsd, 0.001);
    saveSettings(
      "local",
      { maxBudgetUsd: null },
      { dataDir: data, projectCwd: project, home },
    );
    loaded = loadSettings({ dataDir: data, projectCwd: project, home });
    assert.equal(loaded.settings.maxBudgetUsd, null);
  });
});
