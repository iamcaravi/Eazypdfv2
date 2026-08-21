import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as PDFLib from "pdf-lib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const utilitySource = readFileSync(resolve(ROOT, "js/core/pdf-processing-utils.js"), "utf8");
const exportSource = readFileSync(resolve(ROOT, "js/editor/editor-export.js"), "utf8");
const pngDataUrl = "data:image/png;base64," + readFileSync(resolve(ROOT, "tests/fixtures/simple.png")).toString("base64");

function createHarness(originalBytes, objects) {
  const listeners = new Map();
  const clicks = [];
  const downloads = [];
  const progress = [];
  const button = {
    disabled: false,
    textContent: "Save PDF",
    dataset: {},
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  };
  const sandbox = {
    AbortController,
    Blob,
    console,
    fetch,
    PDFLib,
    setTimeout,
    clearTimeout,
    Uint8Array,
    URL,
    document: {
      querySelector(selector) { return selector === '[data-action="export"]' ? button : null; },
      createElement(tag) {
        if (tag !== "a") throw new Error(`Unexpected element: ${tag}`);
        return { hidden: false, href: "", download: "", click() { clicks.push(this.download); }, remove() {} };
      },
      body: { appendChild() {} },
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      if (event.type === "editor:progressText") progress.push(event.detail.text);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    EditorObjects: { getState: () => structuredClone(objects) },
    RenderEngine: { getOriginalBytes: () => originalBytes.slice(0) },
    downloadBlob(blob, fileName) {
      downloads.push({ blob, fileName });
      return { url: `blob:test-${downloads.length}` };
    },
    loadPdfSafe: bytes => PDFLib.PDFDocument.load(bytes),
    toast() {},
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(utilitySource, context, { filename: "pdf-processing-utils.js" });
  vm.runInContext(exportSource, context, { filename: "editor-export.js" });
  // The classic utility script defines its own global downloadBlob binding;
  // replace that boundary after loading so the test captures the real Blob.
  sandbox.downloadBlob = (blob, fileName) => {
    downloads.push({ blob, fileName });
    return { url: `blob:test-${downloads.length}` };
  };
  sandbox.EditorExport.init();
  sandbox.dispatchEvent(new sandbox.CustomEvent("editor:documentLoaded", {
    detail: { fileName: "résumé.v2.pdf", numPages: 1 },
  }));
  return { sandbox, button, clicks, downloads, progress };
}

let originalBytes;
beforeEach(async () => {
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([300, 400]);
  originalBytes = await doc.save();
});

describe("atomic editor export", () => {
  it("exports text and image objects into one valid edited PDF", async () => {
    const objects = [
      { id: "text-1", type: "text", page: 1, xPct: 10, yPct: 10, wPct: 40, hPct: 10, data: { text: "Hello", fontSize: 14, color: "#222222" } },
      { id: "image-1", type: "image", page: 1, xPct: 20, yPct: 30, wPct: 20, hPct: 20, data: { src: pngDataUrl } },
    ];
    const { sandbox, downloads, clicks, progress, button } = createHarness(originalBytes, objects);

    await sandbox.EditorExport.exportCurrentDocument();

    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe("résumé.v2_edited.pdf");
    const exported = await PDFLib.PDFDocument.load(await downloads[0].blob.arrayBuffer());
    expect(exported.getPageCount()).toBe(1);
    expect(clicks).toEqual(["résumé.v2_edited.pdf"]);
    expect(progress.at(-1)).toBe("Saved résumé.v2_edited.pdf");
    expect(button.disabled).toBe(false);
  });

  it("exports a rounded rectangle via the SVG-path fallback without throwing, and clamps an oversized radius", async () => {
    const objects = [
      { id: "rect-round", type: "rectangle", page: 1, xPct: 10, yPct: 10, wPct: 30, hPct: 20, data: { fill: "#ffcc00", stroke: "#000000", strokeWidth: 2, radius: 12 } },
      // radius (40) far exceeds half the box's own width/height at this
      // page size - drawShapeObject() must clamp it to fit, not hand
      // pdf-lib a self-intersecting arc path that could throw or corrupt
      // the page's content stream.
      { id: "rect-oversized-radius", type: "rectangle", page: 1, xPct: 50, yPct: 10, wPct: 10, hPct: 6, data: { fill: "#00ccff", radius: 40 } },
      { id: "rect-sharp", type: "rectangle", page: 1, xPct: 10, yPct: 60, wPct: 20, hPct: 10, data: { fill: "#cccccc" } },
    ];
    const { sandbox, downloads } = createHarness(originalBytes, objects);

    await sandbox.EditorExport.exportCurrentDocument();

    expect(downloads).toHaveLength(1);
    const exported = await PDFLib.PDFDocument.load(await downloads[0].blob.arrayBuffer());
    expect(exported.getPageCount()).toBe(1);
  });

  it("does not download a partial PDF when any object is unsupported", async () => {
    const objects = [
      { id: "unknown-1", type: "unsupported", page: 1, xPct: 0, yPct: 0, wPct: 10, hPct: 10, data: {} },
    ];
    const { sandbox, downloads, progress, button } = createHarness(originalBytes, objects);

    await sandbox.EditorExport.exportCurrentDocument();

    expect(downloads).toHaveLength(0);
    expect(progress.at(-1)).toMatch(/^Export failed:/);
    expect(button.disabled).toBe(false);
  });

  it("suppresses repeated Save clicks while one export is active", async () => {
    const { sandbox, downloads } = createHarness(originalBytes, []);
    let release;
    let loads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    sandbox.loadPdfSafe = async bytes => {
      loads += 1;
      await gate;
      return PDFLib.PDFDocument.load(bytes);
    };

    const first = sandbox.EditorExport.exportCurrentDocument();
    const duplicate = sandbox.EditorExport.exportCurrentDocument();
    await Promise.resolve();
    expect(loads).toBe(1);
    await expect(duplicate).resolves.toBeUndefined();
    release();
    await first;

    expect(loads).toBe(1);
    expect(downloads).toHaveLength(1);
  });
});