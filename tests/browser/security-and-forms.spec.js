import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

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

  // Step 1: encrypt a real PDF with Protect PDF (this app's own 40-bit
  // RC4 legacy scheme - see pdf-crypto.js) to produce a real encrypted
  // fixture, rather than hand-constructing one.
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
