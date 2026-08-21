import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");
const multiPagePdf = resolve(FIXTURES, "multipage.pdf");
const simplePng = resolve(FIXTURES, "simple.png");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function expectRealDownload(download, expectedName) {
  expect(download.suggestedFilename()).toBe(expectedName);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(statSync(path).size).toBeGreaterThan(50);
}

test("keyboard upload, keyboard removal, accessible reordering, PDF processing, and download", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/merge-pdf");

  const dropzone = page.locator("#dz");
  await expect(dropzone).toBeVisible();
  const chooserPromise = page.waitForEvent("filechooser");
  await dropzone.focus();
  await expect(dropzone).toBeFocused();
  await dropzone.press("Enter");
  const chooser = await chooserPromise;
  await chooser.setFiles([
    { name: "valid.pdf", mimeType: "application/pdf", buffer: readFileSync(validPdf) },
    { name: "multipage.pdf", mimeType: "application/pdf", buffer: readFileSync(multiPagePdf) },
    { name: "remove-me.pdf", mimeType: "application/pdf", buffer: readFileSync(validPdf) },
  ]);

  await expect(page.locator("#flist .file-card")).toHaveCount(3);
  await expect(page.locator('.file-card-order-controls button[aria-label="Move file earlier"]')).toHaveCount(3);

  const remove = page.locator('.file-card-remove[aria-label="Remove remove-me.pdf"]');
  await remove.focus();
  await remove.press("Enter");
  await expect(page.locator("#flist .file-card")).toHaveCount(2);

  const moveLater = page.locator('#flist .file-card').first().getByRole("button", { name: "Move file later" });
  await moveLater.click();
  await expect(page.locator("#flist .file-card-name").first()).toHaveText("multipage.pdf");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="multipage_merged.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  await expectRealDownload(await downloadPromise, "multipage_merged.pdf");
  expect(errors).toEqual([]);
});

test("malicious image input recovers, rapid replacement stays current, and image download fires", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/invert-image-colors");
  const input = page.locator('#fi[type="file"]');

  await input.setInputFiles({
    name: '<img src=x onerror=alert(1)>.png',
    mimeType: "image/png",
    buffer: Buffer.from("not a PNG"),
  });
  await expect(page.locator("#toast")).toContainText("does not match its image extension");
  await expect(page.locator("img[src='x']")).toHaveCount(0);

  const imageBytes = readFileSync(simplePng);
  await input.setInputFiles({ name: "first image.png", mimeType: "image/png", buffer: imageBytes });
  await input.setInputFiles({ name: "第二 image.final.png", mimeType: "image/png", buffer: imageBytes });
  await expect(page.locator("#flist .file-card-name")).toHaveText("第二 image.final.png");
  await expect(page.locator("#imginvertWorkspace")).toBeVisible();

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="第二 image.final_inverted.png"]');
  await expect(downloadLink).toBeVisible({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  await expectRealDownload(await downloadPromise, "第二 image.final_inverted.png");
  expect(errors).toEqual([]);
});

test("legacy Protect PDF guard produces one verified downloadable result", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/protect-pdf");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.getByText(/Legacy compatibility protection: 40-bit RC4/)).toBeVisible();
  await page.locator("#protectPw").fill("phase11-test");
  await page.locator("#protectPw2").fill("phase11-test");

  await page.evaluate(() => {
    document.getElementById("go").click();
    document.getElementById("go").click();
  });
  const downloadLink = page.locator('a.dl-link[download="valid_protected.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 40_000 });
  await expect(page.locator(".result-box")).toHaveCount(1);
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  await expectRealDownload(await downloadPromise, "valid_protected.pdf");
  expect(errors).toEqual([]);
});

test("editor opens a real PDF and exports one atomic edited download", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/edit-pdf");
  await expect(page.locator(".editor-shell")).toBeVisible({ timeout: 20_000 });

  await page.locator('.editor-toolbar input[type="file"][accept="application/pdf"]').setInputFiles(validPdf);
  await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 30_000 });
  const save = page.locator('[data-action="export"]');
  await expect(save).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await save.click();
  await expectRealDownload(await downloadPromise, "valid_edited.pdf");
  await expect(page.locator('[data-status="page"]')).toContainText("Page 1 of 1");
  expect(errors).toEqual([]);
});