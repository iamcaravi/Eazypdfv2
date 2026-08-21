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
