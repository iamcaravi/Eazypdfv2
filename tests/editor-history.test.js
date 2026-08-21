import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historySource = readFileSync(resolve(ROOT, "js/editor/editor-history.js"), "utf8");

// js/editor/editor-history.js is a classic (non-module) browser script,
// same architecture as js/core/pdf-processing-utils.js (see that file's
// own test for the full rationale) - loaded into an isolated vm context so
// its undo/redo behavior can be exercised without a real DOM or a real
// EditorObjects/RenderEngine stack.
//
// The mock EditorObjects below tracks one real mutable "live state" object
// (not a dummy counter) so getState()/restoreState() behave the way the
// real editor-objects.js pair does: getState() always reflects whatever
// was most recently either committed or restored, and restoreState()
// actually changes what a later getState() call returns. Undo/redo's
// correctness depends on that round-trip property - a mock that just
// handed back an arbitrary distinct value per call would validate the
// wrong thing.
function createHarness() {
  const listeners = new Map();
  const historyChanges = [];
  const restoreLog = [];
  let liveState = { v: "initial" };

  const sandbox = {
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      if (event.type === "editor:historyChange") historyChanges.push(event.detail);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    EditorObjects: {
      getState() { return { ...liveState }; },
      restoreState(state) { liveState = { ...state }; restoreLog.push({ ...state }); },
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(historySource, context, { filename: "editor-history.js" });
  sandbox.EditorHistory.init();
  historyChanges.length = 0; // drop the init()-time baseline emission

  // Simulates a real edit: captures the live state as "before" (exactly
  // what editor-objects.js does prior to firing editor:objectsCommitted),
  // then advances live state to the new value, as the UI action itself
  // would have already done by the time the commit event fires.
  function commit(newValue) {
    const before = { ...liveState };
    liveState = { v: newValue };
    sandbox.dispatchEvent(new sandbox.CustomEvent("editor:objectsCommitted", { detail: { before } }));
  }

  return { sandbox, commit, historyChanges, restoreLog, getLiveState: () => liveState };
}

describe("editor undo/redo history", () => {
  it("walks backward through committed states on repeated undo, and forward again on redo", () => {
    const { sandbox, commit, restoreLog } = createHarness();
    commit("A"); // live: initial -> A
    commit("B"); // live: A -> B

    sandbox.EditorHistory.undo();
    expect(restoreLog.at(-1)).toEqual({ v: "A" }); // back to what preceded "B"

    sandbox.EditorHistory.undo();
    expect(restoreLog.at(-1)).toEqual({ v: "initial" }); // back to what preceded "A"

    sandbox.EditorHistory.redo();
    expect(restoreLog.at(-1)).toEqual({ v: "A" }); // forward to the state undo #1 had left

    sandbox.EditorHistory.redo();
    expect(restoreLog.at(-1)).toEqual({ v: "B" }); // forward to the state before any undo
  });

  it("clears the redo stack on a new commit", () => {
    const { sandbox, commit, historyChanges } = createHarness();
    commit("A");
    sandbox.EditorHistory.undo();
    expect(historyChanges.at(-1).canRedo).toBe(true);

    commit("B");
    expect(historyChanges.at(-1)).toEqual({ canUndo: true, canRedo: false });
  });

  it("resets both stacks when a new document loads", () => {
    const { sandbox, commit, historyChanges } = createHarness();
    commit("A");
    sandbox.dispatchEvent(new sandbox.CustomEvent("editor:documentLoaded", { detail: {} }));
    expect(historyChanges.at(-1)).toEqual({ canUndo: false, canRedo: false });
    sandbox.EditorHistory.undo(); // no-op, stack is empty
    expect(historyChanges.at(-1)).toEqual({ canUndo: false, canRedo: false });
  });

  it("is a no-op when there is nothing to undo or redo", () => {
    const { sandbox, restoreLog, historyChanges } = createHarness();
    sandbox.EditorHistory.undo();
    sandbox.EditorHistory.redo();
    expect(restoreLog).toHaveLength(0);
    expect(historyChanges).toHaveLength(0);
  });

  it("bounds the undo stack instead of growing without limit", () => {
    // One more commit than the documented 50-entry cap: after exactly 50
    // undos the stack must be empty (canUndo false), proving the oldest
    // commit was evicted rather than retained forever.
    const { sandbox, commit, historyChanges } = createHarness();
    for (let i = 0; i < 51; i++) commit(`step-${i}`);
    for (let i = 0; i < 49; i++) sandbox.EditorHistory.undo();
    expect(historyChanges.at(-1).canUndo).toBe(true); // one step still left
    sandbox.EditorHistory.undo(); // the 50th undo
    expect(historyChanges.at(-1).canUndo).toBe(false); // exactly 50 recoverable steps, not 51
  });

  it("restores the oldest surviving snapshot after the cap evicts the true oldest one", () => {
    const { sandbox, commit, restoreLog } = createHarness();
    // commit(0) records "before" = initial (the value that would be
    // evicted first); commit(1)'s "before" = {v:"step-0"} becomes the
    // oldest surviving snapshot once the cap evicts commit(0)'s entry.
    for (let i = 0; i < 51; i++) commit(`step-${i}`);
    for (let i = 0; i < 50; i++) sandbox.EditorHistory.undo();
    expect(restoreLog.at(-1)).toEqual({ v: "step-0" });
  });
});
