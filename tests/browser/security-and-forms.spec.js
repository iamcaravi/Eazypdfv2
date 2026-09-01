import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Phase 12: real functional coverage for Unlock, Repair, Fill PDF Form,
// and Sign PDF - previously entirely untested beyond build/SEO smoke
// checks (Protect PDF already had coverage from an earlier phase).

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");
const malformedPdf = resolve(FIXTURES, "malformed.pdf");
const formPdf = resolve(FIXTURES, "form.pdf");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("protect then unlock round trip: a PDF encrypted by this app is decrypted back to an unencrypted, byte-readable PDF", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);

  // Step 1: encrypt a real PDF with Protect PDF's standards-compatible
  // AESV2 path to produce a real encrypted fixture rather than
  // hand-constructing one.
  await page.goto("/protect-pdf");
  await page.locator("#fi").setInputFiles(validPdf);
  const password = "phase12-test-pw";
  await page.locator("#protectPw").fill(password);
  await page.locator("#protectPw2").fill(password);
  await page.locator("#go").click();
  const protectedLink = page.locator('a.dl-link[download="valid_protected.pdf"]');
  await expect(protectedLink).toBeVisible({ timeout: 30_000 });
  const protectDownloadPromise = page.waitForEvent("download");
  await protectedLink.click();
  const protectedDownload = await protectDownloadPromise;
  // Saved to a real, stable path rather than used from Playwright's own
  // ephemeral download-artifact location - that path is only guaranteed
  // valid for as long as the Download handle itself is referenced, which
  // this test outlives (it navigates away and re-uploads it afterward).
  const protectedPath = join(mkdtempSync(join(tmpdir(), "yoyopdf-protected-")), "valid_protected.pdf");
  await protectedDownload.saveAs(protectedPath);

  // A real encrypted PDF must not be openable by pdf-lib without a password.
  await expect(PDFDocument.load(readFileSync(protectedPath))).rejects.toThrow();

  // Step 2: feed that real encrypted file into Unlock PDF with the same password.
  await page.goto("/unlock-pdf");
  await page.locator("#fi").setInputFiles(protectedPath);
  await expect(page.locator("#unlockPwField")).toBeVisible({ timeout: 10_000 });
  await page.locator("#unlockPw").fill(password);
  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();

  const unlockedLink = page.locator('a.dl-link[download="valid_protected_unlocked.pdf"]');
  await expect(unlockedLink).toBeVisible({ timeout: 30_000 });
  const unlockDownloadPromise = page.waitForEvent("download");
  await unlockedLink.click();
  const unlockedDownload = await unlockDownloadPromise;
  const unlockedBytes = readFileSync(await unlockedDownload.path());

  // The whole point of Unlock: the result opens with NO password.
  const result = await PDFDocument.load(unlockedBytes);
  expect(result.getPageCount()).toBe(1);
  expect(errors).toEqual([]);
});

test("repair: a structurally valid PDF completes through the resave path", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/repair-pdf");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const downloadLink = page.locator('a.dl-link[download="valid_repaired.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const result = await PDFDocument.load(readFileSync(await download.path()));
  expect(result.getPageCount()).toBe(1);
  expect(errors).toEqual([]);
});

test("repair: a genuinely unparseable file gets an honest failure message, not a hang or crash", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/repair-pdf");
  await page.locator("#fi").setInputFiles(malformedPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  await expect(page.getByText("This file is too damaged to repair.", { exact: false })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("fill PDF form: detects a real AcroForm text field, fills it, and the exported PDF has that value", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/fill-pdf-form");
  await page.locator("#fi").setInputFiles(formPdf);

  const fieldInput = page.locator('.fillform-field-overlay[data-fname="TestField"]');
  await expect(fieldInput).toBeVisible({ timeout: 15_000 });
  await fieldInput.fill("Phase 12 test value");

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="form_filled.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());

  const result = await PDFDocument.load(bytes);
  const field = result.getForm().getTextField("TestField");
  expect(field.getText()).toBe("Phase 12 test value");
  expect(errors).toEqual([]);
});

test("sign PDF: a typed signature is applied and the exported PDF still has one page", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/sign-pdf");
  await page.locator("#fi").setInputFiles(validPdf);

  await page.locator("#addSigBtn").click();
  await page.locator('[data-method="type"]').click();
  await page.locator("#typeSigInput").fill("Phase Twelve");
  await page.locator("#useTypeSig").click();

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="valid_signed.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const result = await PDFDocument.load(readFileSync(await download.path()));
  expect(result.getPageCount()).toBe(1);
  expect(errors).toEqual([]);
});

test("Edit PDF permanent redaction removes affected page objects and preserves unaffected pages", async ({ page }) => {
  test.setTimeout(90_000);
  const fixtureDoc = await PDFDocument.create();
  const font = await fixtureDoc.embedFont(StandardFonts.Helvetica);
  for (const [secret, visible] of [["SECRET-ALPHA", "VISIBLE-ONE"], ["SECRET-BETA", "VISIBLE-TWO"]]) {
    const pdfPage = fixtureDoc.addPage([400, 300]);
    pdfPage.drawText(secret, { x: 40, y: 220, size: 20, font, color: rgb(0, 0, 0) });
    pdfPage.drawText(visible, { x: 40, y: 80, size: 20, font, color: rgb(0, 0, 0) });
  }
  const untouched = fixtureDoc.addPage([400, 300]);
  untouched.drawText("UNAFFECTED-SEARCHABLE", { x: 40, y: 150, size: 20, font, color: rgb(0, 0, 0) });
  const sourceBytes = await fixtureDoc.save();
  const sourcePath = join(mkdtempSync(join(tmpdir(), "yoyopdf-redaction-")), "redaction-source.pdf");
  writeFileSync(sourcePath, sourceBytes);

  await page.goto("/edit-pdf");
  await expect(page.locator(".editor-shell")).toBeVisible({ timeout: 20_000 });
  await page.locator('.editor-toolbar input[type="file"][accept="application/pdf"]').setInputFiles(sourcePath);
  await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    for (const pageNumber of [1, 2]) window.EditorObjects.addObject({
      type: "redaction", page: pageNumber, xPct: 8, yPct: 17, wPct: 55, hPct: 13,
      data: { label: "REDACTED", reason: "test", color: "#000000", state: "pending" },
    });
  });
  page.once("dialog", dialog => dialog.accept());
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="export"]').click();
  const download = await downloadPromise;
  const outputBytes = readFileSync(await download.path());

  const inspection = await page.evaluate(async ({ source, output }) => {
    async function inspect(bytes) {
      const doc = await window.loadPdfJsSafe({ data: new Uint8Array(bytes) });
      const pages = [];
      try {
        for (let number = 1; number <= doc.numPages; number++) {
          const pdfPage = await doc.getPage(number);
          const text = (await pdfPage.getTextContent()).items.map(item => item.str).join(" ");
          const viewport = pdfPage.getViewport({ scale: 1 });
          const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
          const ctx = canvas.getContext("2d"); await pdfPage.render({ canvasContext: ctx, viewport }).promise;
          const redactionPixel = number < 3 ? Array.from(ctx.getImageData(60, 60, 1, 1).data) : null;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let nonWhitePixels = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) nonWhitePixels += 1;
          pages.push({ text, redactionPixel, nonWhitePixels });
        }
      } finally { await doc.destroy(); }
      return pages;
    }
    return { source: await inspect(source), output: await inspect(output) };
  }, { source: Array.from(sourceBytes), output: Array.from(outputBytes) });

  expect(inspection.source[0].text).toContain("SECRET-ALPHA");
  expect(inspection.source[1].text).toContain("SECRET-BETA");
  expect(inspection.output[0].text).not.toContain("SECRET-ALPHA");
  expect(inspection.output[1].text).not.toContain("SECRET-BETA");
  expect(inspection.output[2].text).not.toContain("UNAFFECTED-SEARCHABLE");
  expect(inspection.output[2].nonWhitePixels).toBeGreaterThan(100);
  expect(inspection.output[0].redactionPixel.slice(0, 3).every(channel => channel < 20)).toBe(true);
  expect(inspection.output[1].redactionPixel.slice(0, 3).every(channel => channel < 20)).toBe(true);
  expect(readFileSync(sourcePath)).toEqual(Buffer.from(sourceBytes));
});
