import { expect, test } from "@playwright/test";

test("the browser can load the calendar favicon", async ({ page, request }) => {
  await page.goto("/");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveCount(1);
  const href = await icon.getAttribute("href");
  expect(href).toBeTruthy();

  const response = await request.get(new URL(href!, page.url()).href);
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  expect(
    await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight > 0;
    }, new URL(href!, page.url()).href),
  ).toBe(true);
});
