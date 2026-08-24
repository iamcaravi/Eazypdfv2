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

async function dragSelectionOnPage(page, pageIndex, fromFrac, toFrac) {
  const layer = page.locator(`.crop-page[data-page-index="${pageIndex}"] .crop-select-layer`);
  await layer.scrollIntoViewIfNeeded();
  await expect(layer).toBeVisible({ timeout: 15_000 });
  const box = await layer.boundingBox();
  if (!box) throw new Error(`selection layer for page ${pageIndex} has no bounding box`);
  const from = { x: box.x + box.width * fromFrac.x, y: box.y + box.height * fromFrac.y };
  const to = { x: box.x + box.width * toFrac.x, y: box.y + box.height * toFrac.y };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  // Lets the fallback/IntersectionObserver scan settle so currentPageIndex
  // (which "same selection" and "reset current page" both key off) reflects
  // the page we just scrolled to and dragged on.
  await page.waitForTimeout(150);
}

async function scrollToPage(page, pageIndex) {
  // Scrolls the same element dragSelectionOnPage's own scrollIntoViewIfNeeded
  // targets (the selection layer, not the page wrapper) - matches the one
  // navigation path already proven not to hang, and gives the
  // IntersectionObserver/scroll-fallback the same settle time.
  const layer = page.locator(`.crop-page[data-page-index="${pageIndex}"] .crop-select-layer`);
  await layer.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
}

function rectStyleOf(page, pageIndex) {
  return page.locator(`.crop-page[data-page-index="${pageIndex}"] .crop-rect`).evaluate((el) => ({
    hidden: el.hidden,
    left: el.style.left,
    top: el.style.top,
    width: el.style.width,
    height: el.style.height,
  }));
}

test("crop PDF: independent selections on two pages survive navigating away and back", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-pdf");
  await page.locator("#fi").setInputFiles(multiPagePdf);

  await dragSelectionOnPage(page, 0, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 });
  const rectA = await rectStyleOf(page, 0);
  expect(rectA.hidden).toBe(false);

  await dragSelectionOnPage(page, 1, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.7 });
  const rectB = await rectStyleOf(page, 1);
  expect(rectB.hidden).toBe(false);

  // Page 0's own rect element must still reflect selection A - drawing B on
  // page 1 must not have hidden or overwritten it.
  const rectAAfter = await rectStyleOf(page, 0);
  expect(rectAAfter).toEqual(rectA);
  expect(rectAAfter.width).not.toBe(rectB.width);

  const rectBAfter = await rectStyleOf(page, 1);
  expect(rectBAfter).toEqual(rectB);
  expect(errors).toEqual([]);
});

test("crop PDF: three independent page selections all survive repeated navigation", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-pdf");
  await page.locator("#fi").setInputFiles(multiPagePdf);

  await dragSelectionOnPage(page, 0, { x: 0.08, y: 0.08 }, { x: 0.3, y: 0.3 });
  const rectA = await rectStyleOf(page, 0);
  await dragSelectionOnPage(page, 1, { x: 0.15, y: 0.15 }, { x: 0.55, y: 0.5 });
  const rectB = await rectStyleOf(page, 1);
  await dragSelectionOnPage(page, 2, { x: 0.25, y: 0.25 }, { x: 0.85, y: 0.8 });
  const rectC = await rectStyleOf(page, 2);

  // Navigate 1 -> 2 -> 1 -> 3, re-checking each still matches its own rect.
  await scrollToPage(page, 0);
  expect(await rectStyleOf(page, 0)).toEqual(rectA);
  await scrollToPage(page, 1);
  expect(await rectStyleOf(page, 1)).toEqual(rectB);
  await scrollToPage(page, 0);
  expect(await rectStyleOf(page, 0)).toEqual(rectA);
  await scrollToPage(page, 2);
  expect(await rectStyleOf(page, 2)).toEqual(rectC);

  expect(errors).toEqual([]);
});

test("crop PDF: Reset Selection only clears the currently displayed page", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-pdf");
  await page.locator("#fi").setInputFiles(multiPagePdf);

  await dragSelectionOnPage(page, 0, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 });
  const rectA = await rectStyleOf(page, 0);
  await dragSelectionOnPage(page, 1, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.7 });

  // currentPageIndex is now page 1 (last scrolled/dragged on) - Reset
  // Selection must only clear page 1, not page 0.
  await page.locator("#resetCrop").click();
  const rectBAfterReset = await rectStyleOf(page, 1);
  expect(rectBAfterReset.hidden).toBe(true);

  await scrollToPage(page, 0);
  const rectAAfterReset = await rectStyleOf(page, 0);
  expect(rectAAfterReset).toEqual(rectA);
  expect(rectAAfterReset.hidden).toBe(false);
  expect(errors).toEqual([]);
});

test("crop PDF: apply same selection to all pages mirrors one logical crop across every page", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-pdf");
  await page.locator("#fi").setInputFiles(multiPagePdf);

  await dragSelectionOnPage(page, 0, { x: 0.15, y: 0.15 }, { x: 0.6, y: 0.55 });
  const rectSource = await rectStyleOf(page, 0);

  await page.locator('input[name="cropSelectionMode"][value="same"]').check();

  const rect1 = await rectStyleOf(page, 1);
  const rect2 = await rectStyleOf(page, 2);
  expect(rect1).toEqual(rectSource);
  expect(rect2).toEqual(rectSource);

  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="multipage_cropped.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());

  const result = await PDFDocument.load(bytes);
  const boxes = result.getPages().map((p) => p.getCropBox());
  expect(boxes).toHaveLength(3);
  for (const box of boxes) {
    expect(box.width).toBeLessThan(420);
    expect(box.height).toBeLessThan(594);
  }
  // Same logical crop area on equal-size pages must land on the same
  // physical crop box across every page.
  expect(boxes[1].width).toBeCloseTo(boxes[0].width, 1);
  expect(boxes[1].height).toBeCloseTo(boxes[0].height, 1);
  expect(boxes[2].width).toBeCloseTo(boxes[0].width, 1);
  expect(boxes[2].height).toBeCloseTo(boxes[0].height, 1);
  expect(errors).toEqual([]);
});

test("crop PDF: custom per-page selections produce different crop boxes per page in the output", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/crop-pdf");
  await page.locator("#fi").setInputFiles(multiPagePdf);

  await dragSelectionOnPage(page, 0, { x: 0.05, y: 0.05 }, { x: 0.25, y: 0.25 });
  await dragSelectionOnPage(page, 1, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 });
  await dragSelectionOnPage(page, 2, { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.85 });

  await expect(page.locator('input[name="cropScope"][value="all"]')).toBeChecked();
  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="multipage_cropped.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());

  const result = await PDFDocument.load(bytes);
  const boxes = result.getPages().map((p) => p.getCropBox());
  expect(boxes).toHaveLength(3);
  // Each page's own crop box should reflect its own (very different-sized)
  // drawn rectangle, not one global rectangle applied to every page.
  expect(boxes[0].width).toBeLessThan(boxes[1].width);
  expect(boxes[1].width).toBeLessThan(boxes[2].width);
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
