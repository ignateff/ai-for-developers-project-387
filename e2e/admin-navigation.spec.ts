import { expect, test } from "@playwright/test";

test("guest and owner navigate between direct links and preserve booking context", async ({
  page,
  request,
}) => {
  await request.post("/api/meeting-types", {
    data: { name: "Навигация", description: "Проверка", durationMinutes: 30 },
  });
  await page.goto("/book");
  await expect(page.getByRole("button", { name: /Создать|Изменить|Удалить/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Админка" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.reload();
  const card = page.locator("article", {
    has: page.getByRole("heading", { name: "Навигация", exact: true }),
  });
  await expect(card).toBeVisible();
  await card.getByRole("heading").click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("link", { name: "Предстоящие события" }).click();
  await expect(page).toHaveURL(/\/admin\/events$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Предстоящие события" })).toBeVisible();
  await page.goto("/events");
  await expect(page).toHaveURL(/\/admin\/events$/);
  await page.getByRole("link", { name: "Гость" }).click();
  await page.getByRole("button", { name: "Выбрать Навигация" }).click();
  await expect(page.getByRole("link", { name: "Админка" })).toBeHidden();
});

test("admin retains form input on failed create and edit and retries list loading", async ({
  page,
  request,
}) => {
  let failList = true;
  await page.route("**/api/meeting-types", async (route) => {
    if (route.request().method() === "GET" && failList) {
      await route.fulfill({ status: 500, body: "{}" });
    } else if (route.request().method() === "POST") {
      await route.fulfill({ status: 500, body: "{}" });
    } else await route.continue();
  });
  await page.goto("/admin");
  await expect(page.getByRole("alert")).toContainText("Не удалось загрузить");
  failList = false;
  await page.getByRole("button", { name: "Повторить" }).click();
  await page.getByRole("button", { name: "Добавить тип встречи" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Сохранить ввод");
  await page.getByLabel("Описание", { exact: true }).fill("Описание");
  await page.getByLabel("Длительность в минутах").fill("30");
  await page.getByRole("button", { name: "Создать тип", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Не удалось создать");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Сохранить ввод");
  await page.getByRole("dialog").getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await request.post("/api/meeting-types", {
    data: { name: "Ошибка редактирования", description: "Описание", durationMinutes: 30 },
  });
  await page.reload();
  await page.route("**/api/meeting-types/*", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 500, body: "{}" });
    else await route.continue();
  });
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Ошибка редактирования", exact: true }) })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page.getByLabel("Название типа").fill("Новое название");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Не удалось сохранить");
  await expect(page.getByLabel("Название типа")).toHaveValue("Новое название");
});
