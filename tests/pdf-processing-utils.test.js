import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// js/core/pdf-processing-utils.js is a classic (non-module) browser script:
// it declares helpers as plain top-level functions with no export
// statement, sharing one global scope with every other js/core/js/tools
// file at runtime (see .yoyopdf-autopilot/phase-2.report.md). To unit test
// its pure, DOM-free helpers here without changing that architecture, this
// loads the file's unmodified source into an isolated vm context and reads
// the functions back off it.
let sandbox;

beforeAll(() => {
  const source = readFileSync(resolve(ROOT, "js/core/pdf-processing-utils.js"), "utf8");
  sandbox = vm.createContext({ AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, sandbox, { filename: "pdf-processing-utils.js" });
});

describe("fmtSize", () => {
  it("formats sub-kilobyte sizes as whole bytes", () => {
    expect(sandbox.fmtSize(500)).toBe("500 B");
  });
  it("formats sub-megabyte sizes as KB with one decimal", () => {
    expect(sandbox.fmtSize(2048)).toBe("2.0 KB");
  });
  it("formats sizes at or above 1MB as MB with two decimals", () => {
    expect(sandbox.fmtSize(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

describe("suffixedName", () => {
  it("appends the suffix and extension to the base filename", () => {
    expect(sandbox.suffixedName({ name: "report.pdf" }, "compressed", "pdf")).toBe("report_compressed.pdf");
  });
  it("strips a previously-applied known suffix before adding a new one", () => {
    expect(sandbox.suffixedName({ name: "report_compressed.pdf" }, "rotated", "pdf")).toBe("report_rotated.pdf");
  });
  it("falls back to 'document' when there is no source file", () => {
    expect(sandbox.suffixedName(null, "merged", "pdf")).toBe("document_merged.pdf");
  });
  it("caps an overly long base name so the result can't grow unbounded", () => {
    const longName = "a".repeat(100) + ".pdf";
    const result = sandbox.suffixedName({ name: longName }, "compressed", "pdf");
    expect(result.length).toBeLessThanOrEqual(60 + "_compressed.pdf".length);
  });
});

describe("imgOutputFormat", () => {
  it("keeps PNG as PNG (preserves transparency)", () => {
    expect(sandbox.imgOutputFormat({ type: "image/png" })).toEqual({ mime: "image/png", ext: "png" });
  });
  it("keeps WebP as WebP", () => {
    expect(sandbox.imgOutputFormat({ type: "image/webp" })).toEqual({ mime: "image/webp", ext: "webp" });
  });
  it("falls GIF back to PNG instead of flattening transparency onto JPEG", () => {
    expect(sandbox.imgOutputFormat({ type: "image/gif" })).toEqual({ mime: "image/png", ext: "png" });
  });
  it("converts everything else (e.g. JPEG) to JPEG", () => {
    expect(sandbox.imgOutputFormat({ type: "image/jpeg" })).toEqual({ mime: "image/jpeg", ext: "jpg" });
  });
});

describe("resource validation", () => {
  const pdf = (overrides = {}) => ({
    name: "report.pdf",
    type: "application/pdf",
    size: 1024,
    ...overrides,
  });

  it("accepts a valid file selection", () => {
    expect(sandbox.validateFileSelectionMetadata([pdf()], {
      accept: "application/pdf",
      multiple: false,
    })).toHaveLength(1);
  });

  it("rejects empty, oversized, mismatched, and excessive selections", () => {
    expect(() => sandbox.validateFileSelectionMetadata([pdf({ size: 0 })], {
      accept: "application/pdf",
    })).toThrow(/empty/i);
    expect(() => sandbox.validateFileSelectionMetadata([pdf({ size: 201 * 1024 * 1024 })], {
      accept: "application/pdf",
    })).toThrow(/too large/i);
    expect(() => sandbox.validateFileSelectionMetadata([
      { name: "image.png", type: "image/png", size: 10 },
    ], { accept: "application/pdf" })).toThrow(/supported file type/i);
    expect(() => sandbox.validateFileSelectionMetadata([pdf(), pdf({ name: "two.pdf" })], {
      accept: "application/pdf",
      multiple: false,
    })).toThrow(/one file/i);
  });
});

describe("createOperationController", () => {
  function button() {
    return {
      disabled: false,
      textContent: "Run",
      dataset: {},
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
    };
  }

  it("suppresses duplicate runs and restores button state", async () => {
    const target = button();
    const controller = sandbox.createOperationController(target, {
      busyLabel: "Working...",
      timeoutMs: 0,
    });
    let finish;
    let calls = 0;
    const first = controller.run(() => {
      calls += 1;
      return new Promise(resolve => { finish = resolve; });
    });
    const duplicate = controller.run(() => { calls += 1; });
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(target.disabled).toBe(true);
    expect(target.textContent).toBe("Working...");
    expect(await duplicate).toBeUndefined();
    finish("done");
    await expect(first).resolves.toBe("done");
    expect(target.disabled).toBe(false);
    expect(target.textContent).toBe("Run");
    expect(target["aria-busy"]).toBeUndefined();
  });

  it("invalidates stale work on cancellation", async () => {
    const controller = sandbox.createOperationController(null, { timeoutMs: 0 });
    let finish;
    const running = controller.run(() => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    controller.cancel();
    finish("stale");
    await expect(running).resolves.toBeUndefined();
    expect(controller.busy).toBe(false);
  });
});

describe("file signature validation", () => {
  function binaryFile(name, type, bytes) {
    const data = Uint8Array.from(bytes);
    return {
      name,
      type,
      size: data.length,
      slice(start, end) {
        const part = data.slice(start, end);
        return { arrayBuffer: async () => part.buffer };
      },
    };
  }

  it("accepts real PDF, Office ZIP, and PNG signatures", async () => {
    const files = [
      binaryFile("valid.pdf", "application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
      binaryFile("valid.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", [0x50, 0x4b, 0x03, 0x04]),
      binaryFile("valid.png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ];
    await expect(sandbox.validateFileSelection([files[0]], { accept: "application/pdf" })).resolves.toHaveLength(1);
    await expect(sandbox.validateFileSelection([files[1]], { accept: ".docx" })).resolves.toHaveLength(1);
    await expect(sandbox.validateFileSelection([files[2]], { accept: "image/*" })).resolves.toHaveLength(1);
  });

  it("rejects files whose contents do not match their claimed type", async () => {
    const fakePdf = binaryFile("malicious.pdf", "application/pdf", [0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74]);
    await expect(sandbox.validateFileSelection([fakePdf], { accept: "application/pdf" }))
      .rejects.toThrow(/valid PDF header/i);
  });
});

describe("operation failure recovery", () => {
  it("restores controls after failure and permits a clean retry", async () => {
    const target = {
      disabled: false,
      textContent: "Process",
      dataset: {},
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
    };
    const controller = sandbox.createOperationController(target, { busyLabel: "Working...", timeoutMs: 0 });

    await expect(controller.run(async () => { throw new Error("fixture failure"); }))
      .rejects.toThrow("fixture failure");
    expect(controller.busy).toBe(false);
    expect(target.disabled).toBe(false);
    expect(target.textContent).toBe("Process");

    await expect(controller.run(async () => "recovered")).resolves.toBe("recovered");
    expect(target.disabled).toBe(false);
  });
});