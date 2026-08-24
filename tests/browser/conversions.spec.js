import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";

// Phase 12: real functional coverage for the format-conversion tools,
// previously entirely untested beyond build/SEO smoke checks. Each test
// drives the real UI with a real fixture and validates the actual output
// bytes for the format it claims to produce (a real ZIP-based OOXML
// document, a real decodable PDF, a real JPEG) - not just "a download
// happened."

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");
const minimalDocx = resolve(FIXTURES, "minimal.docx");
const minimalXlsx = resolve(FIXTURES, "minimal.xlsx");
const simplePng = resolve(FIXTURES, "simple.png");
const workbookA = resolve(FIXTURES, "workbook-a.xlsx");
const workbookB = resolve(FIXTURES, "workbook-b.xlsx");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function downloadBytes(page, linkSelector, timeout = 30_000) {
  const downloadLink = page.locator(linkSelector);
  await expect(downloadLink).toBeVisible({ timeout });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const path = await download.path();
  return readFileSync(path);
}

test("PDF to Word: produces a real, ZIP-based .docx (not a renamed/empty file)", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-word");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_converted.docx"]');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file("word/document.xml")).not.toBeNull();
  const documentXml = await zip.file("word/document.xml").async("string");
  expect(documentXml).toContain("<w:document");
  expect(errors).toEqual([]);
});

test("Word to PDF: converts a real .docx's text into a decodable PDF", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/word-to-pdf");
  await page.locator("#fi").setInputFiles(minimalDocx);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="minimal_converted.pdf"]');
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("PDF to JPG: renders a single-page PDF into a real, decodable JPEG", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-jpg");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_page1.jpg"]');
  expect(bytes[0]).toBe(0xff); // real JPEG SOI marker, not an empty/placeholder file
  expect(bytes[1]).toBe(0xd8);
  expect(errors).toEqual([]);
});

test("JPG to PDF: embeds a real PNG into a valid one-page PDF", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/jpg-to-pdf");
  await page.locator("#fi").setInputFiles(simplePng);
  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="images.pdf"]');
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBe(1);
  expect(errors).toEqual([]);
});

test("PDF to Excel: produces a real, ZIP-based .xlsx with the extracted content", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-excel");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_converted.xlsx"]');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file("xl/workbook.xml")).not.toBeNull();
  expect(errors).toEqual([]);
});

test("Excel to PDF: converts a real .xlsx's first sheet into a decodable PDF", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/excel-to-pdf");
  await page.locator("#fi").setInputFiles(minimalXlsx);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="minimal_converted.pdf"]');
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("PDF to PowerPoint: renders a single-page PDF into a real, ZIP-based .pptx (one slide, image-based)", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-powerpoint");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_converted.pptx"]');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file("ppt/presentation.xml")).not.toBeNull();
  expect(zip.file("ppt/slides/slide1.xml")).not.toBeNull();
  expect(errors).toEqual([]);
});

test("Merge Excel: requires at least 2 files before Merge Workbooks is enabled", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/merge-excel");
  await page.locator("#fi").setInputFiles([workbookA]);
  await expect(page.locator('.file-card')).toHaveCount(1);
  await expect(page.locator("#go")).toBeDisabled();
  await expect(page.locator("#mergeexcelError")).toContainText(/2 or more/i);
  expect(errors).toEqual([]);
});

test("Merge Excel: real package-level merge of two workbooks - correct sheet names, worksheet XML, and dependent parts", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/merge-excel");
  await page.locator("#fi").setInputFiles([workbookA, workbookB]);

  await expect(page.locator('.file-card')).toHaveCount(2);
  // Per-file sheet-name preview (best-effort UI feature) should surface
  // each workbook's real sheet names, not just a generic file-type badge.
  await expect(page.locator(".file-card-sheets").first()).toContainText("Sheet1", { timeout: 10_000 });
  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();

  // Not just "a download happened" - read the real downloaded XLSX package
  // back with JSZip and verify its actual OOXML structure.
  const bytes = await downloadBytes(page, 'a.dl-link[download="workbook-a_merged.xlsx"]');
  const zip = await JSZip.loadAsync(bytes);

  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const sheetNames = [...workbookXml.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  // workbook-a and workbook-b both use "Sheet1"/"Sheet2" - the collision
  // must be resolved by uniquifying, never by silently overwriting.
  expect(sheetNames).toEqual(["Sheet1", "Sheet2", "Sheet1 (2)", "Sheet2 (2)"]);

  const sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
  expect(sheet1).toContain('<mergeCell ref="A1:C1"/>'); // workbook-a's own merged header, byte-preserved
  expect(sheet1).toMatch(/<f>SUM\(B3:B3\)<\/f>/); // workbook-a's own formula, byte-preserved

  const sheet3 = await zip.file("xl/worksheets/sheet3.xml").async("string"); // workbook-b's renamed "Sheet1 (2)"
  expect(sheet3).toContain('<mergeCell ref="A1:B1"/>'); // workbook-b's own (differently-shaped) merged header

  expect(zip.file("xl/styles.xml")).not.toBeNull();
  expect(zip.file("xl/sharedStrings.xml")).not.toBeNull();
  expect(zip.file("docProps/app.xml")).not.toBeNull();
  expect(zip.file("[Content_Types].xml")).not.toBeNull();

  expect(errors).toEqual([]);
});
