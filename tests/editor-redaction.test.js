import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(ROOT, "js/editor/editor-redaction.js"), "utf8");

function loadModule() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.runInContext(source, vm.createContext(sandbox), { filename: "editor-redaction.js" });
  return sandbox.EditorRedaction;
}

describe("editor permanent redaction model", () => {
  it("normalizes page geometry and exposes a workspace-compatible extension", () => {
    const redaction = loadModule();
    const object = {
      id: "secret-1", type: "redaction", page: 2,
      xPct: 10, yPct: 20, wPct: 30, hPct: 12,
      data: { label: "CONFIDENTIAL", reason: "Personal data", color: "#000000", state: "pending" },
    };
    expect(redaction.collect([object])).toEqual([expect.objectContaining({ page: 2, label: "CONFIDENTIAL", state: "pending" })]);
    expect(redaction.toWorkspaceExtension(object)).toEqual({
      kind: "redaction", page: 2,
      rect: { xPct: 10, yPct: 20, wPct: 30, hPct: 12 },
      label: "CONFIDENTIAL", reason: "Personal data",
      appearance: { color: "#000000" }, state: "pending",
    });
  });

  it("burns the full normalized region and optional label into a render surface", () => {
    const redaction = loadModule();
    const calls = [];
    const ctx = {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      fillRect(...args) { calls.push(["rect", ...args]); },
      fillText(...args) { calls.push(["text", ...args]); },
      set fillStyle(value) { calls.push(["fill", value]); },
      set font(value) {}, set textAlign(value) {}, set textBaseline(value) {},
    };
    redaction.paint(ctx, 1000, 500, [{ xPct: 10, yPct: 20, wPct: 30, hPct: 10, color: "#000000", label: "REDACTED" }]);
    expect(calls).toContainEqual(["rect", 100, 100, 300, 50]);
    expect(calls.some((call) => call[0] === "text" && call[1] === "REDACTED")).toBe(true);
  });
});
