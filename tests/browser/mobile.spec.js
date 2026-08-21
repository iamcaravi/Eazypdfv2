import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs only under the "mobile" Playwright project (see playwright.config.js
// testMatch scoping) - a real touch-emulated, narrow-viewport device, not
// just a resized desktop window, so hover-dependent interactions genuinely
// aren't available here the way they are in workflows.spec.js.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("mobile nav: hamburger opens the menu, and a menu item navigates to its tool", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/");

  const hamburger = page.locator("#hamburgerBtn");
  await expect(hamburger).toBeVisible();

  await hamburger.click();
  const mobileMenu = page.locator("#mobileMenu");
  await expect(mobileMenu).toHaveClass(/open/);

  // "split" also appears a second time inside the collapsed "All PDF
  // Tools" mega-expansion (#mobileMega) - .first() is the direct top-level
  // shortcut button, the one a user taps without expanding that section.
  await mobileMenu.locator('[data-open="split"]').first().click();
  // dev-server.py serves the real cross-document navigation openTool()
  // performs as split-pdf.html directly - the clean, extensionless /split-
  // pdf URL is a production-only rewrite (_redirects, Netlify), not
  // something the local dev server also performs on in-app navigation.
  await expect(page).toHaveURL(/\/split-pdf(\.html)?$/);
  await expect(page.locator("#dz")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile upload uses the file-picker fallback (no drag-and-drop), processes, and downloads a real file", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/flatten-pdf");

  // No drag-and-drop on a touch device - the same hidden <input type="file">
  // under the dropzone is what a real mobile browser's "Choose File" tap
  // opens, and it's exactly what setInputFiles drives here too.
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#flist .file-card")).toHaveCount(1);

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="valid_flattened.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("valid_flattened.pdf");
  const path = await download.path();
  expect(statSync(path).size).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test("mobile dialogs: the Support panel opens over the mobile viewport and its close control works", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/");

  await page.locator("#hamburgerBtn").click();
  await page.locator('#mobileMenu [data-open="donate"]').click();

  const panel = page.locator("#panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Support YOYOPDF", { exact: false })).toBeVisible();

  // The panel's own open motion (GSAP/CSS) keeps its bounding box moving
  // for a brief moment after becoming visible, which fails Playwright's
  // stricter-than-a-real-tap "stable for two frames" actionability check.
  // waitForTimeout lets that settle; force:true then covers any residual
  // sub-pixel motion, same as a real tap would land on this element fine
  // either way - this test's job is verifying the close *works*, not
  // asserting on the open animation itself.
  await page.waitForTimeout(400);
  await panel.locator(".panel-close").click({ force: true });
  await expect(page.locator("#overlay")).not.toHaveClass(/open/);
  expect(errors).toEqual([]);
});
