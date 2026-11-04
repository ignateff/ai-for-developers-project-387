import { expect, test } from "./fixtures";

for (const viewport of [
  { width: 1400, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`footer at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    for (const path of ["/", "/book", "/admin", "/admin/events"]) {
      test(`shows the copyright after the content on ${path}`, async ({ page }) => {
        await page.goto(path);
        // Wait for data-driven pages to finish loading before measuring layout.
        await expect(page.getByText(/^Загрузка/)).toBeHidden();
        await page.evaluate(() => document.fonts.ready);

        const footer = page.getByRole("contentinfo");
        await expect(footer).toHaveText("© 2026 Календарь звонков");
        await expect(footer).toHaveJSProperty("tagName", "FOOTER");
        const mainBox = await page.getByRole("main").boundingBox();
        const footerBox = await footer.boundingBox();
        expect(mainBox).not.toBeNull();
        expect(footerBox).not.toBeNull();
        expect(footerBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height);
        expect(footerBox!.x).toBeGreaterThanOrEqual(0);
        expect(footerBox!.x + footerBox!.width).toBeLessThanOrEqual(viewport.width);

        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        await footer.scrollIntoViewIfNeeded();
        await expect(footer).toBeInViewport();
        await expect(footer.getByText("© 2026 Календарь звонков")).toBeInViewport({ ratio: 1 });
      });
    }

    test("stays at the viewport bottom on a short page", async ({ page }) => {
      await page.route("**/api/events/upcoming", (route) => route.fulfill({ json: [] }));
      await page.goto("/admin/events");
      await expect(page.getByText("Предстоящих событий пока нет")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const footerBox = await page.getByRole("contentinfo").boundingBox();
      expect(footerBox).not.toBeNull();
      expect(Math.abs(footerBox!.y + footerBox!.height - viewport.height)).toBeLessThanOrEqual(1);
    });

    test("follows a long list without covering the last item", async ({ page }) => {
      await page.route("**/api/meeting-types", (route) =>
        route.fulfill({
          json: Array.from({ length: 12 }, (_, index) => ({
            id: `footer-type-${index}`,
            name: `Встреча ${index + 1}`,
            description: "Познакомиться и обсудить задачи",
            durationMinutes: 30,
            version: 1,
          })),
        }),
      );
      await page.goto("/admin");
      const lastCard = page.getByRole("article").last();
      await expect(lastCard.getByRole("heading")).toHaveText("Встреча 12");
      await page.evaluate(() => document.fonts.ready);
      const footer = page.getByRole("contentinfo");
      const footerBox = await footer.boundingBox();
      const lastCardBox = await lastCard.boundingBox();
      expect(footerBox).not.toBeNull();
      expect(lastCardBox).not.toBeNull();
      expect(footerBox!.y).toBeGreaterThan(viewport.height);
      expect(footerBox!.y).toBeGreaterThanOrEqual(lastCardBox!.y + lastCardBox!.height);
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeInViewport();
      await expect(lastCard.getByRole("button", { name: "Удалить", exact: true })).toBeVisible();
    });

    test("is absent from the standalone theme preview", async ({ page }) => {
      await page.goto("/theme-preview");
      await expect(page.getByRole("heading", { name: "Тема календаря" })).toBeVisible();
      await expect(page.getByRole("contentinfo")).toHaveCount(0);
    });
  });
}
