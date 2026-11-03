import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page, title: string) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Добавить тип встречи" }).click();
  await page.getByLabel("Название").fill(title);
  await page.getByLabel("Описание").fill("Проверка потери ответа");
  await page.getByLabel("Длительность в минутах").fill("30");
  await page.getByRole("button", { name: "Создать тип", exact: true }).click();
  await page.getByRole("link", { name: "Гость" }).click();
  await page.getByRole("button", { name: `Выбрать ${title}` }).click();
  await page
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2} · (?:[2-9]|[1-9]\d+) свободно/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /^\d\d:\d\d UTC$/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByLabel("Имя").fill("Recovery guest");
  await page.getByLabel("Email").fill("recovery@example.com");
}

test("retry survives failures before the request and after the saved response", async ({
  page,
  request,
}) => {
  await prepare(page, "Восстановление повтора");
  let calls = 0;
  let key = "";
  await page.route("**/api/bookings", async (route) => {
    calls++;
    const current = route.request().headers()["idempotency-key"];
    if (!key) key = current;
    expect(current).toBe(key);
    if (calls === 1) {
      await route.abort();
      return;
    }
    if (calls === 2) {
      expect((await route.fetch()).status()).toBe(201);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByText(/Повтор может впервые создать запись/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Повторить попытку" }).click();
  await expect(page.getByRole("alert")).toContainText("Результат неизвестен");
  await page.reload();
  await page.getByRole("button", { name: "Повторить попытку" }).click();
  await expect(page.getByRole("heading", { name: "Бронь подтверждена" })).toBeVisible();
  const events = await (await request.get("/api/events/upcoming")).json();
  expect(
    events.filter(
      (item: { meetingTypeName: string }) => item.meetingTypeName === "Восстановление повтора",
    ),
  ).toHaveLength(1);
});

test("forgetting a saved unknown attempt can lead to a second booking", async ({
  page,
  request,
}) => {
  await prepare(page, "Риск второй записи");
  await page.route(
    "**/api/bookings",
    async (route) => {
      expect((await route.fetch()).status()).toBe(201);
      await route.abort();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await page.getByRole("button", { name: "Забыть попытку" }).click();
  await expect(page.getByText(/Новая попытка может создать вторую запись/)).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить забывание" }).click();
  await page.getByRole("button", { name: "Выбрать Риск второй записи" }).click();
  const refreshedSlots = page.waitForResponse(
    (response) => response.url().includes("/slots?") && response.status() === 200,
  );
  await page
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2} · [1-9]\d* свободно/ })
    .first()
    .click();
  await refreshedSlots;
  await page
    .getByRole("button", { name: /^\d\d:\d\d UTC$/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByLabel("Имя").fill("Recovery guest");
  await page.getByLabel("Email").fill("recovery@example.com");
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByRole("heading", { name: "Бронь подтверждена" })).toBeVisible();
  const events = await (await request.get("/api/events/upcoming")).json();
  expect(
    events.filter(
      (item: { meetingTypeName: string }) => item.meetingTypeName === "Риск второй записи",
    ),
  ).toHaveLength(2);
});
