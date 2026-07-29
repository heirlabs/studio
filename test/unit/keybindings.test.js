import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  KEYBINDING_CONTEXTS,
  HARDCODED_ACTIONS,
  DEFAULT_KEYBINDINGS,
  normalizeKeyChord,
  chordFromEvent,
  loadKeybindings,
  saveKeybindings,
  resolveBinding,
  isChordSequence,
  hasChordPrefix,
  createChordTracker,
} from "../../server/lib/keybindings.js";

describe("keybindings", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-kb-"));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defines 17 contexts", () => {
    assert.equal(KEYBINDING_CONTEXTS.length, 17);
  });

  it("hardcodes two actions", () => {
    assert.equal(HARDCODED_ACTIONS.size, 2);
    assert.ok(HARDCODED_ACTIONS.has("forceCancel"));
    assert.ok(HARDCODED_ACTIONS.has("emergencyStop"));
  });

  it("normalizes chords with modifiers", () => {
    assert.equal(normalizeKeyChord("Cmd+Shift+O"), "shift+meta+o");
    assert.equal(normalizeKeyChord("Ctrl+R"), "ctrl+r");
    assert.equal(normalizeKeyChord("Alt+T"), "alt+t");
    assert.equal(normalizeKeyChord("Shift+Tab"), "shift+tab");
  });

  it("rejects empty chord", () => {
    assert.throws(() => normalizeKeyChord(""), /required|invalid/i);
  });

  it("builds chord from event-like object", () => {
    assert.equal(
      chordFromEvent({ key: "r", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
      "ctrl+r",
    );
    assert.equal(
      chordFromEvent({ key: "Tab", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
      "shift+tab",
    );
  });

  it("loads defaults when file missing", () => {
    const result = loadKeybindings(path.join(dir, "missing.json"));
    assert.equal(result.source, "defaults");
    assert.ok(result.bindings.length >= DEFAULT_KEYBINDINGS.length);
  });

  it("merges custom bindings and rejects rebinding hardcoded", () => {
    const p = path.join(dir, "keybindings.json");
    saveKeybindings(p, [
      { key: "ctrl+shift+h", command: "historySearch", when: "global" },
    ]);
    const loaded = loadKeybindings(p);
    assert.equal(loaded.source, "file");
    const hit = resolveBinding(loaded.bindings, "ctrl+shift+h", ["global"]);
    assert.equal(hit.command, "historySearch");

    assert.throws(
      () =>
        saveKeybindings(p, [
          { key: "f12", command: "forceCancel", when: "running" },
        ]),
      /hardcoded/,
    );
  });

  it("resolves specific context over global", () => {
    const bindings = [
      { key: "enter", command: "sendMessage", when: "composer" },
      { key: "enter", command: "historyAccept", when: "historySearch" },
    ];
    assert.equal(
      resolveBinding(bindings, "enter", ["historySearch", "global"]).command,
      "historyAccept",
    );
    assert.equal(
      resolveBinding(bindings, "enter", ["composer", "global"]).command,
      "sendMessage",
    );
  });

  it("rejects invalid when context", () => {
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(
      p,
      JSON.stringify([{ key: "a", command: "x", when: "nope" }]),
    );
    assert.throws(() => loadKeybindings(p), /invalid when/);
  });

  it("normalizes multi-stroke chord sequences", () => {
    assert.equal(
      normalizeKeyChord("Ctrl+K Ctrl+S"),
      "ctrl+k ctrl+s",
    );
    assert.ok(isChordSequence("ctrl+k ctrl+s"));
    assert.ok(!isChordSequence("ctrl+k"));
  });

  it("tracks multi-stroke sequences to match", () => {
    const bindings = [
      { key: "ctrl+k ctrl+s", command: "saveAll", when: "global" },
      { key: "ctrl+s", command: "save", when: "global" },
    ];
    const tracker = createChordTracker({
      bindings,
      getContexts: () => ["global"],
      timeoutMs: 5000,
    });
    const first = tracker.feed("ctrl+k");
    assert.equal(first.type, "prefix");
    const second = tracker.feed("ctrl+s");
    assert.equal(second.type, "match");
    assert.equal(second.binding.command, "saveAll");
  });

  it("falls back to single stroke after incomplete sequence", () => {
    const bindings = [
      { key: "ctrl+k ctrl+s", command: "saveAll", when: "global" },
      { key: "ctrl+r", command: "historySearch", when: "global" },
    ];
    assert.ok(hasChordPrefix(bindings, "ctrl+k", ["global"]));
    const tracker = createChordTracker({
      bindings,
      getContexts: () => ["global"],
    });
    assert.equal(tracker.feed("ctrl+k").type, "prefix");
    const hit = tracker.feed("ctrl+r");
    assert.equal(hit.type, "match");
    assert.equal(hit.binding.command, "historySearch");
  });
});
