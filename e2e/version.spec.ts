import { expect, test } from "@playwright/test";
import { readBuildInfo } from "../apps/web/build-info.ts";

test("logs the frontend version once per page load, not on SPA navigation", async ({ page }) => {
  const messages: { type: string; text: string }[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("Calendar v")) {
      messages.push({ type: message.type(), text: message.text() });
    }
  });
  const { version, revision } = readBuildInfo();
  const expected = { type: "info", text: `Calendar v${version} (${revision}) [dev]` };

  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Основная навигация" });
  await expect(navigation).toBeVisible();
  expect(messages).toEqual([expected]);

  await navigation.getByRole("link", { name: "Записаться", exact: true }).click();
  await expect(page).toHaveURL("/book");
  await expect(navigation.getByRole("link", { name: "Админка", exact: true })).toBeVisible();
  expect(messages).toEqual([expected]);

  await page.reload();
  await expect(navigation).toBeVisible();
  expect(messages).toEqual([expected, expected]);
});
