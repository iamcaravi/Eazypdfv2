import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

// Phase 12 (continuation): real coverage for the 3 tools left uncovered
// last pass specifically because they need a pointer-drag gesture, not
// just a click - Crop PDF, Crop Image, and Organize PDF. Crop PDF/Crop
// Image both drive a live pointerdown/pointermove/pointerup sequence
// against their real selection-layer element (page.mouse, not a synthetic
// drag helper) and then verify the *exported* file actually got smaller,
// not just that a download happened - a #go click with no drawn
// selection would "complete" too (both tools' updateGoState() only
// requires a file, not a drawn rect) but would silently test nothing
// about cropping. Organize doesn't need a drag to exercise its real
// multi-page assembly path (buildPdfFromMultiDoc), so it's covered with a
// plain upload + export instead of simulating a page-thumbnail drag.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf"); // 420x594pt, 1 page
const multiPagePdf = resolve(FIXTURES, "multipage.pdf"); // 3 pages
const sizablePng = resolve(FIXTURES, "sizable.png"); // 200x150 real PNG

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function dragSelection(page, layerLocator) {
  const box = await layerLocator.boundingBox();
  if (!box) throw new Error("selection layer has no bounding box - not visible/rendered yet");
  const from = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.15 };
  const to = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.75 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A few intermediate steps: the tool's pointermove handler computes the
  // rect from wherever the pointer currently is, and a single jump can
  // land before the layer has attached its listener on some renders.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

test("crop PDF: a real drag on the page selection layer produces a genuinely smaller cropped page", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-pdf");
  await page.locator("#fi").setInputFiles(validPdf);

  const layer = page.locator('.crop-page[data-page-index="0"] .crop-select-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await dragSelection(page, layer);
  // Confirms the drag actually registered a selection rect (normRect set,
  // .crop-rect unhidden) rather than silently no-opping - #go itself is
  // enabled by file presence alone (updateGoState() doesn't check for a
  // drawn rect), so asserting only on #go's enabled state would pass even
  // if the drag never landed.
  // Confirms the drag actually registered a selection rect (normRect set,
  // .crop-rect unhidden) rather than silently no-opping - #go itself is
  // enabled by file presence alone (updateGoState() doesn't check for a
  // drawn rect), so asserting only on #go's enabled state would pass even
  // if the drag never landed.
  await expect(page.locator('.crop-page[data-page-index="0"] .crop-rect')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();

  const downloadLink = page.locator('a.dl-link[download="valid_cropped.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());

  const result = await PDFDocument.load(bytes);
  const resultPage = result.getPage(0);
  // getSize()/getWidth()/getHeight() report the MediaBox, not the
  // CropBox pdf-lib's own setCropBox() call actually wrote (confirmed by
  // inspecting a real export: MediaBox stays 420x594 while CropBox
  // correctly shrinks) - getCropBox() is the API that reflects what this
  // tool actually changed.
  const cropBox = resultPage.getCropBox();
  const mediaBox = resultPage.getMediaBox();
  expect(mediaBox.width).toBe(420); // sanity: MediaBox is untouched by design
  expect(mediaBox.height).toBe(594);
  // The fixture's real page is 420x594pt - a genuine ~60%-of-page drag
  // must have actually reduced the crop box, not left the full page.
  expect(cropBox.width).toBeLessThan(420);
  expect(cropBox.height).toBeLessThan(594);
  expect(errors).toEqual([]);
});

test("crop image: a real drag on the selection layer produces genuinely smaller output dimensions", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-image");
  await page.locator("#fi").setInputFiles(sizablePng);

  const layer = page.locator("#imgcropSelectLayer");
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await dragSelection(page, layer);
  await expect(page.locator("#go")).toBeEnabled({ timeout: 10_000 });
  await page.locator("#go").click();

  const downloadLink = page.locator('a.dl-link[download="sizable_cropped.png"]');
  await expect(downloadLink).toBeVisible({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());

  // PNG IHDR chunk: bytes 16-19 = width, 20-23 = height, big-endian.
  // sizable.png's real dimensions are 200x150 - a genuine ~60%-of-image
  // drag must measurably shrink both, not just round-trip the original.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(width).toBeLessThan(200);
  expect(height).toBeLessThan(150);
  expect(errors).toEqual([]);
});

test("organize PDF: a multi-page file completes through the real multi-file assembly path with its page count intact", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/organize-pdf");
  await page.locator("#fi").setInputFiles(multiPagePdf);
  await expect(page.locator("#go")).toBeVisible({ timeout: 15_000 });
  await page.locator("#go").click();

  const downloadLink = page.locator('a.dl-link[download="multipage_organized.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const result = await PDFDocument.load(readFileSync(await download.path()));
  expect(result.getPageCount()).toBe(3);
  expect(errors).toEqual([]);
});
