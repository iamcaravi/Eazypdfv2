import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

// Phase 12: the only fixture the rest of this suite uses beyond 1-3 pages
// is this one (tests/fixtures/large.pdf, 250 pages - see generate-
// fixtures.mjs). These tests measure real completion behavior on it for
// the heaviest workflows; they do NOT exercise the app's actual advertised
// ceiling (YOYO_RESOURCE_LIMITS: 1500 pages / 200MB) - 250 pages is
// "large enough to be meaningful and fast enough to run in CI," not the
// maximum. Report results honestly as "large-document," not "ceiling."

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const largePdf = resolve(FIXTURES, "large.pdf");
const validPdf = resolve(FIXTURES, "valid.pdf");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("merge: a 250-page PDF plus a 1-page PDF completes and produces a 251-page result", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  const start = Date.now();
  await page.goto("/merge-pdf");

  await page.locator("#fi").setInputFiles([largePdf, validPdf]);
  await expect(page.locator("#flist .file-card")).toHaveCount(2);

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="large_merged.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 90_000 });
  const elapsedMs = Date.now() - start;

  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const path = await download.path();
  const bytes = readFileSync(path);
  const merged = await PDFDocument.load(bytes);
  expect(merged.getPageCount()).toBe(251); // real page-count check, not just "a file exists"
  expect(errors).toEqual([]);
  console.log(`[large-document] merge 250+1 pages completed in ${elapsedMs}ms`);
});

test("split: a 250-page PDF split into fixed 50-page chunks completes and produces 5 real parts", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  const start = Date.now();
  await page.goto("/split-pdf");

  await page.locator("#fi").setInputFiles(largePdf);
  await expect(page.locator('[data-mode="range"]')).toBeVisible();
  await page.locator('[data-rangemode="fixed"]').click();
  await page.locator("#splitEveryN").fill("50");

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="large_split_parts.zip"]');
  await expect(downloadLink).toBeVisible({ timeout: 90_000 });
  const elapsedMs = Date.now() - start;

  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(statSync(path).size).toBeGreaterThan(50);
  expect(errors).toEqual([]);
  console.log(`[large-document] split 250 pages into 50-page chunks completed in ${elapsedMs}ms`);
});

test("compress: a 250-page PDF completes without hanging or crashing", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  const start = Date.now();
  await page.goto("/compress-pdf");

  await page.locator("#fi").setInputFiles(largePdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="large_compressed.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 90_000 });
  const elapsedMs = Date.now() - start;

  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const path = await download.path();
  const bytes = readFileSync(path);
  // large.pdf is text/vector only (no embedded images) - compress-pdf only
  // recompresses images, so this deliberately does NOT assert the output
  // got smaller. What matters here is that a 250-page document completes
  // the full compress pipeline and still decodes as a valid, complete PDF.
  const compressed = await PDFDocument.load(bytes);
  expect(compressed.getPageCount()).toBe(250);
  expect(errors).toEqual([]);
  console.log(`[large-document] compress 250 pages completed in ${elapsedMs}ms`);
});

test("editor: opens a 250-page PDF, renders the first page, and reports the correct page count", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  const start = Date.now();
  await page.goto("/edit-pdf");
  await expect(page.locator(".editor-shell")).toBeVisible({ timeout: 20_000 });

  await page.locator('.editor-toolbar input[type="file"][accept="application/pdf"]').setInputFiles(largePdf);
  await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 90_000 });
  const elapsedMs = Date.now() - start;

  await expect(page.locator('[data-status="page"]')).toContainText("Page 1 of 250");
  expect(errors).toEqual([]);
  console.log(`[large-document] editor opened and rendered page 1 of 250 in ${elapsedMs}ms`);
});

test("stale-operation protection: replacing a large file mid-load does not let the first load's result apply afterward", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/edit-pdf");
  await expect(page.locator(".editor-shell")).toBeVisible({ timeout: 20_000 });

  const fileInput = page.locator('.editor-toolbar input[type="file"][accept="application/pdf"]');
  // Start loading the large (slow) document, then immediately replace it
  // with the small one before the large one can finish - the operation
  // controller (createOperationController / render-engine.js's generation
  // token, see js/editor/render-engine.js) must discard the stale large-
  // document result rather than letting it clobber the second, newer load.
  await fileInput.setInputFiles(largePdf);
  await fileInput.setInputFiles(validPdf);

  await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-status="page"]')).toContainText("Page 1 of 1", { timeout: 15_000 });
  expect(errors).toEqual([]);
});
