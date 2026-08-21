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
