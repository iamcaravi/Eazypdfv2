import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headers = readFileSync(resolve(ROOT, "_headers"), "utf8");
const netlify = readFileSync(resolve(ROOT, "netlify.toml"), "utf8");
const vite = readFileSync(resolve(ROOT, "vite.config.js"), "utf8");

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function policy(name) {
  const match = headers.match(new RegExp("^\\s*" + name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + ":\\s*(.+)$", "mi"));
  return match ? match[1].trim() : "";
}

describe("production deployment security", () => {
  it("ships a restrictive content security policy for the current browser architecture", () => {
    const csp = policy("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    // Phase 12: tightened from 'self' 'unsafe-inline' https://cdnjs... once
    // every onclick="..."/inline handler in the app was converted to
    // addEventListener (see panel.js/pdf-processing-utils.js) - 'unsafe-
    // inline' on script-src specifically defeats CSP's XSS protection
    // (an injected <script> tag would run identically to a legitimate
    // one), so removing it is a real hardening, not a cosmetic change.
    expect(csp).toContain("script-src 'self' https://cdnjs.cloudflare.com");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/(?:^|;)\s*(?:default|script|worker)-src[^;]*\s\*(?:\s|;|$)/);
  });

  it("ships defense-in-depth browser response headers", () => {
    expect(policy("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(policy("X-Content-Type-Options")).toBe("nosniff");
    expect(policy("X-Frame-Options")).toBe("DENY");
    expect(policy("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(policy("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(policy("Permissions-Policy")).toContain("camera=()");
  });

  it("deploys only the verified dist artifact from a clean dependency install", () => {
    expect(netlify).toContain('command = "npm ci && npm run build"');
    expect(netlify).toContain('publish = "dist"');
    expect(netlify).toContain('NODE_VERSION = "20"');
    expect(vite).toContain('"_headers"');
    expect(vite).toContain('"_redirects"');
  });

  it("does not retain or reference the proven-unused legacy landing stylesheet", () => {
    expect(existsSync(resolve(ROOT, "css/landing.css"))).toBe(false);
    for (const file of readdirSync(ROOT).filter((name) => name.endsWith(".html"))) {
      expect(readFileSync(resolve(ROOT, file), "utf8"), file).not.toContain("css/landing.css");
    }
  });

  it("has no inline event-handler attributes anywhere (script-src has no 'unsafe-inline' to allow them)", () => {
    const INLINE_HANDLER_RE = /\son[a-z]+\s*=\s*["']/i;
    // Strips // and /* */ comments first so a comment merely discussing
    // the old onclick="..." pattern (e.g. this Phase 12 fix's own commit-
    // message-style code comments) doesn't self-trigger the check. Not a
    // perfect JS tokenizer (a "//" inside a real string literal would also
    // get cut), but every file here is this repo's own source, so a false
    // negative from that edge case is not a realistic risk in practice.
    function stripComments(src) {
      return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    }
    const htmlFiles = readdirSync(ROOT).filter((name) => name.endsWith(".html"));
    for (const file of htmlFiles) {
      const content = readFileSync(resolve(ROOT, file), "utf8");
      expect(stripComments(content), file).not.toMatch(INLINE_HANDLER_RE);
    }
    const jsFiles = walkFiles(resolve(ROOT, "js")).filter((f) => f.endsWith(".js"));
    for (const file of jsFiles) {
      const content = readFileSync(file, "utf8");
      // Only real attribute-shaped hits count - excludes doc-export-
      // builders.js/pptx-export.js's OOXML XML attributes (e.g. `sz="..."`,
      // `algName="..."`) and aria-/data-controls-style false positives,
      // which a naive /on\w+=/ pattern would also match.
      expect(stripComments(content), file).not.toMatch(INLINE_HANDLER_RE);
    }
  });
});