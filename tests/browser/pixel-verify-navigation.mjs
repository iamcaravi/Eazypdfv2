// One-off PIXEL-LEVEL verification script (not part of the committed
// Playwright suite - depends on ffmpeg being present locally, which the
// regular CI/test suite must not require). Captures a REAL video of a
// throttled tool-opening navigation, extracts every frame, and directly
// inspects pixel content (not DOM state) at a header-region strip and a
// body-region strip in every frame - looking specifically for the exact
// bad-frame signature confirmed in the user's own original screen
// recording: header has real rendered content (high pixel variance -
// text/logo/nav), while the body area is uniform/blank (near-zero
// variance, matching the page's own background). This is the strongest
// available proof: DOM-invariant tests can prove the app's own class/
// state logic is correct, but only pixel inspection of an actual
// rendered video frame can speak to what the compositor really painted.
//
// Usage: node tests/browser/pixel-verify-navigation.mjs <route> <card>
// Example: node tests/browser/pixel-verify-navigation.mjs /merge-pdf merge

import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const route = process.argv[2] || "/merge-pdf";
const card = process.argv[3] || "merge";
const outDir = path.resolve(process.cwd(), "pixel-verify-out");
const framesDir = path.join(outDir, "frames");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// Only the click-triggered navigation under test needs to be throttled -
// the initial setup load of the homepage doesn't, and throttling it too
// just adds unreliable extra time fetching real external CDN scripts
// over whatever network path this environment has, with no bearing on
// what's being verified.
await page.goto("http://127.0.0.1:5173/", { timeout: 60_000 });
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await cdp.send("Network.emulateNetworkConditions", {
  offline: false, latency: 150,
  downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8,
});
await page.click(`[data-tool="${card}"]`);
await page.waitForURL("**/" + route.slice(1) + ".html", { timeout: 30_000 });
await page.locator("#overlay").waitFor({ state: "visible", timeout: 30_000 });
await page.waitForTimeout(300); // settle past reveal for a clean tail

const videoPath = await page.video().path();
await context.close();
await browser.close();

console.log("Video saved:", videoPath);
execSync(`ffmpeg -y -i "${videoPath}" -vsync 0 "${framesDir}/f_%04d.png"`, { stdio: "pipe" });
const frames = readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
console.log(`Extracted ${frames.length} frames.`);

// Header strip: y=10..40 across the full width (logo/nav text lives here).
// Body strip: y=200..500, x=200..1080 (well below the header, where the
// bug's "blank body" was observed - avoids the header itself and any
// fixed-position chrome at the very bottom).
function grayVarianceFor(framePath, crop) {
  const raw = execSync(
    `ffmpeg -y -i "${framePath}" -vf "crop=${crop},format=gray" -f rawvideo -`,
    { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 64 }
  );
  const n = raw.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += raw[i];
  const mean = sum / n;
  let sqDiff = 0;
  for (let i = 0; i < n; i++) { const d = raw[i] - mean; sqDiff += d * d; }
  return sqDiff / n; // variance
}

const HEADER_CROP = "1200:30:40:15";
const BODY_CROP = "880:300:200:200";
const VARIANCE_THRESHOLD = 15; // near-zero for a flat/uniform region; real text/UI content is far higher

const results = [];
for (const f of frames) {
  const fp = path.join(framesDir, f);
  const headerVar = grayVarianceFor(fp, HEADER_CROP);
  const bodyVar = grayVarianceFor(fp, BODY_CROP);
  results.push({ frame: f, headerVar, bodyVar });
}

const badFrames = results.filter((r) => r.headerVar > VARIANCE_THRESHOLD && r.bodyVar < VARIANCE_THRESHOLD);

console.log("\n--- Per-frame variance (header, body) ---");
results.forEach((r) => console.log(`${r.frame}: header=${r.headerVar.toFixed(1)} body=${r.bodyVar.toFixed(1)}${r.headerVar > VARIANCE_THRESHOLD && r.bodyVar < VARIANCE_THRESHOLD ? "  <-- SUSPECT (header content, blank body)" : ""}`));

console.log(`\nTotal frames: ${results.length}`);
console.log(`Suspect bad frames (header rendered, body blank): ${badFrames.length}`);
if (badFrames.length) {
  console.log("SUSPECT FRAMES:", badFrames.map((r) => r.frame).join(", "));
  console.log(`Inspect them directly at: ${framesDir}`);
  process.exitCode = 1;
} else {
  console.log("PASS: no frame in the captured video shows the header-visible/body-blank signature.");
}
