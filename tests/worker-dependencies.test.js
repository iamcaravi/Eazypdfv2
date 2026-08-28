import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const WORKER_FILES = [
  "js/app.js",
  "js/editor/render-engine.js",
  "js/workers/pdf-compress-worker.js",
];

function source(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function sri(path) {
  const bytes = readFileSync(resolve(ROOT, path));
  return "sha384-" + createHash("sha384").update(bytes).digest("base64");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex");
}

describe("worker dependency isolation", () => {
  it("uses only local exact-version dependencies from worker contexts", () => {
    for (const file of WORKER_FILES) {
      expect(source(file), file).not.toMatch(/worker(?:\.min)?\.js[^\n]*https?:|importScripts\(["']https?:/i);
    }

    expect(source("js/app.js")).toContain("assets/vendor/pdfjs/3.11.174/pdf.worker.min.js");
    expect(source("js/editor/render-engine.js")).toContain("assets/vendor/pdfjs/3.11.174/pdf.worker.min.js");
    expect(source("js/workers/pdf-compress-worker.js")).toContain(
      "../../assets/vendor/pdf-lib/1.17.1/pdf-lib.min.js"
    );
  });

  it("pins the copied vendor artifacts to the expected package bytes", () => {
    expect(sri("assets/vendor/pdf-lib/1.17.1/pdf-lib.min.js")).toBe(
      "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI"
    );
    expect(sri("assets/vendor/pdfjs/3.11.174/pdf.worker.min.js")).toBe(
      "sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2"
    );
    expect(sri("assets/vendor/regenerator-runtime/0.14.1/runtime.js")).toBe(
      "sha384-OUN/6TBQWJ0V9kHVpZgUpqrgWENHMWqIBFHq8UEwg41L3EKbh39nX+5wiDPH29A5"
    );
    expect(sri("assets/vendor/pdf-lib-fontkit/1.1.1/fontkit.umd.min.js")).toBe(
      "sha384-2p6U+1mmqF10USehFeRiyG2ESG9FwIqN+jxULn5w9jjQIihSn9Pt13dVCn/Hawjn"
    );
    expect(sha256("assets/vendor/noto-sans-devanagari/3a06b1c521155492df224d33464b3c7b2852d861/NotoSansDevanagari-Regular.ttf")).toBe(
      "c82fb837eed9988ee6a240ce0635fe18f9c5859389206a24dfc348c926f42500"
    );
    expect(sha256("assets/vendor/noto-sans-devanagari/3a06b1c521155492df224d33464b3c7b2852d861/NotoSansDevanagari-Bold.ttf")).toBe(
      "1ebda0d88076fef54dd70b4dc48deb4dadf634cc9c7c325b812facb802ae3c51"
    );
  });

  it("loads Word-to-PDF executable dependencies from same-origin paths allowed by CSP", () => {
    const loader = source("js/core/lazy-loaders.js");
    const converter = source("js/tools/pdf-convert-tools.js");
    expect(loader).toContain('loadScriptOnce("assets/vendor/regenerator-runtime/0.14.1/runtime.js"');
    expect(loader).toContain('loadScriptOnce("assets/vendor/pdf-lib-fontkit/1.1.1/fontkit.umd.min.js"');
    expect(loader).not.toContain("cdn.jsdelivr.net");
    expect(converter).not.toContain("cdn.jsdelivr.net");
  });

  it("preserves the Phase 8 main-thread SRI declarations", () => {
    const html = source("index.html");
    expect(html).toContain(
      'integrity="sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI"'
    );
    expect(html).toContain(
      'integrity="sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e"'
    );
  });
});
