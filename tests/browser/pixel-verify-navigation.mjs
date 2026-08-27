// One-off PIXEL-LEVEL verification script (not part of the committed
// Playwright suite - depends on ffmpeg being present locally, which the
// regular CI/test suite must not require). Captures REAL video of
// throttled navigations and directly inspects pixel content (not DOM
// state) in every frame.
//
// Two invariants are checked per navigation, because they're two
// different bugs with two different root causes:
//
// 1. HEADER-VISIBLE / BODY-BLANK signature - the original tool-preload
//    bug (see navigation-transition.spec.js): header painted, body
//    still a flat uniform color, before the tool workspace opens.
//
// 2. WRONG-THEME FLASH - the bug this file was rewritten to catch. This
//    site used a cross-document View Transition (@view-transition{
//    navigation:auto} in css/site.css) so tool-opening navigations
//    crossfaded instead of hard-cutting. That API can snapshot the
//    destination document for its ::view-transition-new(root) paint
//    before the destination's external stylesheet (css/site.css) has
//    finished applying - independent of whether data-theme is already
//    correct on <html>, since the snapshot is of what the compositor has
//    actually PAINTED, not of DOM/attribute state. On a throttled
//    connection this produced a real, visible frame (or several) of the
//    browser's default light/unstyled canvas between the outgoing
//    correctly-themed frame and the incoming correctly-themed frame.
//    A DOM assertion like `document.documentElement.dataset.theme` can't
//    see this: the attribute was correct the entire time. Only
//    inspecting actual rendered/painted frames can. The fix removed the
//    @view-transition at-rule entirely; this test proves no such frame
//    exists any more, for both themes, across multiple routes and
//    navigation types.
//
// Usage:
//   node tests/browser/pixel-verify-navigation.mjs            # full matrix, both themes
//   node tests/browser/pixel-verify-navigation.mjs dark        # one theme only
//   node tests/browser/pixel-verify-navigation.mjs dark merge-pdf   # one theme, one route's home->tool case only
//
// Requires the dev server running at http://127.0.0.1:5173 (npm run dev)
// and ffmpeg on PATH.

import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.YOYOPDF_BASE_URL || "http://127.0.0.1:5173";
const OUT_ROOT = path.resolve(process.cwd(), "pixel-verify-out");
rmSync(OUT_ROOT, { recursive: true, force: true });
mkdirSync(OUT_ROOT, { recursive: true });

// toolId values from seo/tools-registry.json / seo/additional-tools.json -
// these are what [data-tool="..."] / [data-open="..."] actually carry,
// NOT the route slug.
const TOOLS = [
  { route: "/merge-pdf", card: "merge" },
  { route: "/compress-pdf", card: "compress" },
  { route: "/pdf-to-word", card: "pdf2word" },
  { route: "/edit-pdf", card: "edit" },
  { route: "/flatten-pdf", card: "flatten" },
];

// Full-frame mean grayscale value (0-255). Real dark surfaces here
// (#050505/#0A0A0A/#101010) average well under 40 even with lime/purple
// accents and light text mixed in; real light surfaces (#FAFAFA/#FFFFFF)
// average well over 200. The bounds below are set with a wide margin
// inside those real values but well short of "obviously the other
// theme," so a genuine wrong-theme frame trips them while normal
// content variation (images, accent colors) never does.
const THEME_BOUNDS = {
  dark: { maxMean: 150, label: "no frame may average this bright (would mean a light/white destination frame)" },
  light: { maxMean: undefined },
};
THEME_BOUNDS.light = { minMean: 90, label: "no frame may average this dark (would mean a dark destination frame)" };

const HEADER_CROP = "1200:30:40:15";
const BODY_CROP = "880:300:200:200";
const SIGNATURE_VARIANCE_THRESHOLD = 15;

const argTheme = process.argv[2];
const argRoute = process.argv[3];
const THEMES_TO_RUN = argTheme ? [argTheme] : ["dark", "light"];

function grayStatsFor(framePath, crop) {
  const raw = execSync(
    `ffmpeg -y -i "${framePath}" -vf "${crop ? "crop=" + crop + "," : ""}format=gray" -f rawvideo -`,
    { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 64 }
  );
  const n = raw.length;
  if (n === 0) return { mean: 0, variance: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += raw[i];
  const mean = sum / n;
  let sqDiff = 0;
  for (let i = 0; i < n; i++) { const d = raw[i] - mean; sqDiff += d * d; }
  return { mean, variance: sqDiff / n };
}

async function recordScenario(name, theme, run) {
  const scenarioDir = path.join(OUT_ROOT, name.replace(/[^a-z0-9-]+/gi, "_"));
  const framesDir = path.join(scenarioDir, "frames");
  mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: scenarioDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  // Runs before any of the page's own scripts, including index.html's
  // pre-paint theme <script> - sets the SAME localStorage key that
  // script reads (yoyopdf-theme), so every page load in this scenario
  // (including a hard reload) starts already committed to `theme`.
  await page.addInitScript((t) => { window.localStorage.setItem("yoyopdf-theme", t); }, theme);
  const cdp = await context.newCDPSession(page);

  await run({ page, context, cdp });

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  execSync(`ffmpeg -y -i "${videoPath}" -vsync 0 "${framesDir}/f_%04d.png"`, { stdio: "pipe" });
  const frames = readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();

  const bounds = THEME_BOUNDS[theme];
  const results = frames.map((f) => {
    const fp = path.join(framesDir, f);
    const full = grayStatsFor(fp, null);
    const header = grayStatsFor(fp, HEADER_CROP);
    const body = grayStatsFor(fp, BODY_CROP);
    return { frame: f, fullMean: full.mean, headerVar: header.variance, bodyVar: body.variance };
  });

  const wrongThemeFrames = results.filter((r) =>
    (bounds.maxMean !== undefined && r.fullMean > bounds.maxMean) ||
    (bounds.minMean !== undefined && r.fullMean < bounds.minMean)
  );
  const blankBodyFrames = results.filter((r) =>
    r.headerVar > SIGNATURE_VARIANCE_THRESHOLD && r.bodyVar < SIGNATURE_VARIANCE_THRESHOLD
  );

  return { name, theme, frameCount: results.length, wrongThemeFrames, blankBodyFrames, framesDir };
}

function scenariosFor(theme) {
  const routes = argRoute ? TOOLS.filter((t) => t.route === "/" + argRoute.replace(/^\//, "")) : TOOLS;
  const scenarios = [];

  for (const { route, card } of routes) {
    scenarios.push([
      `${theme}-home-to-${card}`,
      theme,
      async ({ page, cdp }) => {
        await page.goto(BASE_URL + "/");
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, latency: 150,
          downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8,
        });
        await page.click(`[data-tool="${card}"]`);
        await page.waitForURL("**/" + route.slice(1) + ".html", { timeout: 30_000 });
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(300);
      },
    ]);
  }

  if (!argRoute) {
    scenarios.push([
      `${theme}-tool-to-tool-merge-to-compress`,
      theme,
      async ({ page, cdp }) => {
        await page.goto(BASE_URL + "/merge-pdf");
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, latency: 150,
          downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8,
        });
        await page.click('[data-open="compress"]');
        await page.waitForURL("**/compress-pdf.html", { timeout: 30_000 });
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(300);
      },
    ]);

    scenarios.push([
      `${theme}-back-forward-home-merge`,
      theme,
      async ({ page, cdp }) => {
        await page.goto(BASE_URL + "/");
        await page.click('[data-tool="merge"]');
        await page.waitForURL("**/merge-pdf.html", { timeout: 30_000 });
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, latency: 150,
          downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8,
        });
        await page.goBack();
        await page.waitForTimeout(300);
        await page.goForward();
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(300);
      },
    ]);

    scenarios.push([
      `${theme}-hard-reload-merge`,
      theme,
      async ({ page, cdp }) => {
        await page.goto(BASE_URL + "/merge-pdf");
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, latency: 150,
          downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8,
        });
        await page.reload();
        await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(300);
      },
    ]);
  }

  return scenarios;
}

const allResults = [];
for (const theme of THEMES_TO_RUN) {
  for (const [name, t, run] of scenariosFor(theme)) {
    process.stdout.write(`Running ${name}... `);
    const result = await recordScenario(name, t, run);
    console.log(`${result.frameCount} frames captured.`);
    allResults.push(result);
  }
}

console.log("\n--- Results ---");
let failed = false;
for (const r of allResults) {
  const bounds = THEME_BOUNDS[r.theme];
  if (r.wrongThemeFrames.length) {
    failed = true;
    console.log(`FAIL [${r.name}] ${r.wrongThemeFrames.length}/${r.frameCount} frame(s) violated the ${r.theme} brightness bound (${bounds.label}):`);
    for (const f of r.wrongThemeFrames) console.log(`    ${f.frame}: mean=${f.fullMean.toFixed(1)}`);
    console.log(`    Frames at: ${r.framesDir}`);
  }
  if (r.blankBodyFrames.length) {
    failed = true;
    console.log(`FAIL [${r.name}] ${r.blankBodyFrames.length}/${r.frameCount} frame(s) showed the header-rendered/body-blank signature:`);
    for (const f of r.blankBodyFrames) console.log(`    ${f.frame}: header=${f.headerVar.toFixed(1)} body=${f.bodyVar.toFixed(1)}`);
    console.log(`    Frames at: ${r.framesDir}`);
  }
  if (!r.wrongThemeFrames.length && !r.blankBodyFrames.length) {
    console.log(`PASS [${r.name}] (${r.frameCount} frames, theme=${r.theme}) - no wrong-theme frame, no blank-body frame.`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`\nAll ${allResults.length} scenario(s) passed.`);
}
