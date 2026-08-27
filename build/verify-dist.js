const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "seo", "tools-registry.json"), "utf8"));
const additional = JSON.parse(fs.readFileSync(path.join(ROOT, "seo", "additional-tools.json"), "utf8"));
const { homepageRuntime, runtimeForTool } = require("./runtime-manifest.js");
const tools = [...registry.tools, ...additional.tools]
  .filter((tool) => tool.status !== "planned");
const toolsByFile = new Map(tools.map((tool) => [tool.file, tool]));

const appPages = ["index.html", ...tools.map((tool) => tool.file)];
const expectedHtmlPages = [...appPages, "404.html"];
const knownRoutes = new Set(["/", ...tools.map((tool) => "/" + tool.file.replace(/\.html$/, ""))]);
const staticDirectories = ["js", "css", "assets"];
const copiedRootFiles = ["_headers", "_redirects", "robots.txt", "sitemap.xml"];
const sriHashes = [
  "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI",
  "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
  "sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt",
  "sha384-Z3REaz79l2IaAZqJsSABtTbhjgOUYyV3p90XNnAPCSHg3EMTz1fouunq9WZRtj3d",
  "sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG",
  "sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz",
  "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw",
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function expectFile(relativePath, reason) {
  const absolutePath = path.join(DIST, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail((reason || "Missing build file") + ": " + relativePath);
  }
}

function walkFiles(directory, relativeBase = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeBase, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function stripQueryAndHash(value) {
  return value.split("#", 1)[0].split("?", 1)[0];
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value);
}

function scriptTags(html) {
  const tags = [];
  const pattern = /<script\s+([^>]*\bsrc="([^"]+)"[^>]*)><\/script>/g;
  let match;
  while ((match = pattern.exec(html))) tags.push({ attributes: match[1], src: match[2] });
  return tags;
}
function verifyHtmlReferences(relativePage) {
  const html = fs.readFileSync(path.join(DIST, relativePage), "utf8");
  const referencePattern = /\b(?:src|href)="([^"]+)"/g;
  let match;
  while ((match = referencePattern.exec(html))) {
    const rawReference = match[1];
    if (isExternalReference(rawReference)) continue;
    const reference = stripQueryAndHash(rawReference);
    if (!reference || knownRoutes.has(reference)) continue;

    const target = reference.startsWith("/")
      ? path.join(DIST, reference.slice(1))
      : path.resolve(path.dirname(path.join(DIST, relativePage)), reference);
    const relativeTarget = path.relative(DIST, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      fail(relativePage + " references a path outside dist: " + rawReference);
    } else if (!fs.existsSync(target)) {
      fail(relativePage + " has an unresolved local reference: " + rawReference);
    }
  }
}

if (!fs.existsSync(DIST)) {
  console.error("dist does not exist. Run vite build before verify:dist.");
  process.exit(1);
}

for (const page of expectedHtmlPages) expectFile(page, "Missing HTML entry");
for (const file of copiedRootFiles) {
  expectFile(file, "Missing deployment control file");
  const source = fs.readFileSync(path.join(ROOT, file));
  const built = fs.existsSync(path.join(DIST, file)) ? fs.readFileSync(path.join(DIST, file)) : null;
  if (built && !source.equals(built)) fail("Build copy drifted from source: " + file);
}

// css/site.css (Phase 12) is intentionally NOT expected as a raw dist/css/
// copy — vite.config.js's copyClassicRuntime() skips it on purpose because
// it's the one css/ file Vite's own HTML processing already fingerprints/
// minifies into dist/assets/ (every page's real <link> tag points there,
// verified separately below). Every other css/*.css file (editor
// stylesheets, only ever loaded via a literal runtime string path Vite's
// static scan can't see) still needs, and gets, the raw copy.
const RAW_COPY_EXCEPTIONS = new Set([path.join("css", "site.css")]);

let copiedRuntimeFileCount = 0;
for (const directory of staticDirectories) {
  for (const relativeFile of walkFiles(path.join(ROOT, directory))) {
    const relativePath = path.join(directory, relativeFile);
    if (RAW_COPY_EXCEPTIONS.has(relativePath)) continue;
    copiedRuntimeFileCount += 1;
    expectFile(relativePath, "Missing copied runtime asset");
  }
}

// The hashed replacement for css/site.css: exactly one file, shared
// identically by every page's <link> tag — not one copy per page, and not
// silently dropped instead of skipped.
const hashedSiteCss = fs.existsSync(path.join(DIST, "assets"))
  ? fs.readdirSync(path.join(DIST, "assets")).filter((name) => /^site-.*\.css$/.test(name))
  : [];
if (hashedSiteCss.length !== 1) {
  fail(`Expected exactly one hashed dist/assets/site-*.css, found ${hashedSiteCss.length}`);
} else {
  const hashedHref = "/assets/" + hashedSiteCss[0];
  // appPages only: 404.html is a genuinely separate, standalone error page
  // (Phase 10) with its own small self-contained <style> block — it was
  // never part of the shared homepage/tool-page style block this
  // extraction moved out, so it correctly keeps neither the link nor the
  // "no inline <style>" expectation the templated pages now have.
  for (const page of appPages) {
    const html = fs.readFileSync(path.join(DIST, page), "utf8");
    if (!html.includes(`href="${hashedHref}"`)) {
      fail(`${page} does not link the shared hashed stylesheet ${hashedHref}`);
    }
    if (html.includes("<style>")) {
      fail(`${page} still has an inline <style> block instead of only the external stylesheet`);
    }
  }
}

for (const page of expectedHtmlPages) verifyHtmlReferences(page);

// Phase 13: pretheme.js/prelanguage.js/tool-preload.js/lazy-loaders.js are
// synchronous, unversioned, always-present pre-paint scripts moved out of
// index.html's inline <script> blocks - production's CSP (_headers)
// script-src has no 'unsafe-inline'/nonce/hash, which silently blocked
// those as inline blocks (data-theme never set before first paint, and
// loadScriptOnce/ensurePDFLib/etc. never defined at all). They're plain
// <script src> tags on every page but are NOT part of the versioned,
// per-tool RUNTIME_LIBRARIES/RUNTIME_SCRIPTS profile runtime-manifest.js
// governs, so they're checked directly here instead of via that profile.
const PREPAINT_SCRIPTS = ["js/core/pretheme.js", "js/core/prelanguage.js", "js/core/tool-preload.js"];
const LAZY_LOADER_SCRIPT = "js/core/lazy-loaders.js";
const lazyLoaderSource = fs.existsSync(path.join(DIST, LAZY_LOADER_SCRIPT))
  ? fs.readFileSync(path.join(DIST, LAZY_LOADER_SCRIPT), "utf8")
  : null;
if (!lazyLoaderSource) fail("Missing " + LAZY_LOADER_SCRIPT + " in dist");
else if (!/s\.integrity\s*=\s*integrity/.test(lazyLoaderSource) || !/s\.crossOrigin\s*=\s*["']anonymous["']/.test(lazyLoaderSource)) {
  fail(LAZY_LOADER_SCRIPT + " does not preserve SRI/crossOrigin assignment for lazy Phase 8 CDN scripts");
}

for (const page of appPages) {
  const html = fs.readFileSync(path.join(DIST, page), "utf8");
  const runtime = page === "index.html"
    ? homepageRuntime()
    : runtimeForTool(toolsByFile.get(page).toolId);
  const tags = scriptTags(html);
  const localScripts = tags.filter((tag) => !/^https?:\/\//.test(tag.src)).map((tag) => tag.src);
  const externalScripts = tags.filter((tag) => /^https?:\/\//.test(tag.src));

  for (const script of PREPAINT_SCRIPTS) {
    if (!localScripts.includes(script)) fail(page + " is missing the pre-paint script " + script);
  }
  if (!localScripts.includes(LAZY_LOADER_SCRIPT)) fail(page + " is missing " + LAZY_LOADER_SCRIPT);
  const runtimeManagedScripts = localScripts.filter(
    (src) => !PREPAINT_SCRIPTS.includes(src) && src !== LAZY_LOADER_SCRIPT
  );

  if (JSON.stringify(runtimeManagedScripts) !== JSON.stringify(runtime.scripts)) {
    fail(page + " does not match its generated local runtime profile");
  }
  if (JSON.stringify(externalScripts.map((tag) => tag.src)) !== JSON.stringify(runtime.libraries.map((library) => library.src))) {
    fail(page + " does not match its generated external runtime profile");
  }
  for (const hash of sriHashes) {
    if (!html.includes(hash)) fail(page + " is missing Phase 8 SRI hash " + hash);
  }
  for (const library of runtime.libraries) {
    const tag = externalScripts.find((candidate) => candidate.src === library.src);
    if (!tag || !tag.attributes.includes('integrity="' + library.integrity + '"')) {
      fail(page + " is missing the expected eager SRI attribute for " + library.src);
    }
    if (!tag || !tag.attributes.includes('crossorigin="anonymous"')) {
      fail(page + " is missing crossorigin=anonymous for " + library.src);
    }
  }
  if (!html.includes('<meta name="robots" content="index,follow,max-image-preview:large">')) {
    fail(page + " is missing the Phase 9 index directive");
  }
}

const headers = fs.readFileSync(path.join(DIST, "_headers"), "utf8");
for (const requiredPolicy of [
  "Content-Security-Policy:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "Referrer-Policy: strict-origin-when-cross-origin"
]) {
  if (!headers.includes(requiredPolicy)) fail("_headers is missing required policy: " + requiredPolicy);
}

if (fs.existsSync(path.join(DIST, "css", "landing.css"))) {
  fail("Unused legacy css/landing.css must not be copied to the production artifact");
}

const notFoundHtml = fs.readFileSync(path.join(DIST, "404.html"), "utf8");
if (!notFoundHtml.includes('<meta name="robots" content="noindex,follow">')) {
  fail("404.html must remain noindex,follow");
}

const redirects = fs.readFileSync(path.join(DIST, "_redirects"), "utf8");
for (const tool of tools) {
  const route = "/" + tool.file.replace(/\.html$/, "");
  const expectedRule = route + "  /" + tool.file + "  200";
  if (!redirects.includes(expectedRule)) fail("_redirects is missing " + expectedRule);
}
if (!redirects.includes("/*  /404.html  404")) {
  fail("_redirects is missing the terminal 404 rule");
}

expectFile(path.join("js", "workers", "pdf-compress-worker.js"), "Compression worker missing from deploy artifact");
for (const editorFile of walkFiles(path.join(ROOT, "js", "editor"))) {
  expectFile(path.join("js", "editor", editorFile), "Lazy editor script missing from deploy artifact");
}
for (const editorCss of walkFiles(path.join(ROOT, "css")).filter((file) => file.startsWith("editor-") || file === "pdf-viewer.css")) {
  expectFile(path.join("css", editorCss), "Lazy editor stylesheet missing from deploy artifact");
}

if (failures.length) {
  console.error("Production artifact verification failed:");
  for (const message of [...new Set(failures)]) console.error("- " + message);
  process.exit(1);
}

console.log(
  "Production artifact verified: " +
  expectedHtmlPages.length + " HTML entries, " +
  tools.length + " clean tool routes, " +
  copiedRuntimeFileCount + " copied runtime files, and all Phase 8/9 invariants."
);
