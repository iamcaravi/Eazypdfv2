import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("homepage exposes the complete live tool directory without runtime or accessibility errors", async ({ page }) => {
  const errors = captureRuntimeErrors(page);

  await page.goto("/");
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator(".hero-v2 h1")).toBeVisible();
  await expect(page.locator('a[href="/merge-pdf"]')).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("representative generated tool pages load their interactive panels", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  for (const route of ["/merge-pdf", "/compress-pdf", "/protect-pdf"]) {
    await page.goto(route);
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("#panel .panel-body")).toBeVisible();
  }
  expect(errors).toEqual([]);
});