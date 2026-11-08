import { expect, test, type APIRequestContext, type Page } from "./fixtures";

async function completeBooking(page: Page, request: APIRequestContext, name: string) {
  const response = await request.post("/api/meeting-types", {
    data: { name, description: "Проверка", durationMinutes: 30 },
  });
  expect(response.status()).toBe(201);
  await page.goto("/book");
  await page.getByRole("button", { name: `Выбрать ${name}` }).click();
  await page
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2} · [1-9]\d* свободно/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /^\d\d:\d\d UTC$/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByLabel("Имя").fill("Гость");
  await page.getByLabel("Email").fill("guest@example.com");
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByRole("heading", { name: "Бронь подтверждена" })).toBeVisible();
}

test("guest copies booking details and can start another booking", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await completeBooking(page, request, "Копирование встречи");
  await page.getByRole("button", { name: "Скопировать детали" }).click();
  await expect(page.getByRole("status")).toHaveText("Детали скопированы");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^Копирование встречи · \d{1,2} \S+ · \d\d:\d\d – \d\d:\d\d · UTC$/);
  expect(copied).not.toContain("guest@example.com");
  await page.getByRole("button", { name: "Забронировать ещё" }).click();
  await expect(page.getByRole("button", { name: "Выбрать Копирование встречи" })).toBeVisible();
});

test("guest can read details when clipboard access is denied", async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await completeBooking(page, request, "Отказ буфера");
  await page.getByRole("button", { name: "Скопировать детали" }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось скопировать детали");
  await expect(page.getByText(/Отказ буфера · .* UTC/)).toBeVisible();
  await page.getByRole("button", { name: "Забронировать ещё" }).click();
  await expect(page.getByRole("button", { name: "Выбрать Отказ буфера" })).toBeVisible();
});
