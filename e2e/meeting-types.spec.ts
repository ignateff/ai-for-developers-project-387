import { expect, test } from "@playwright/test";

test("owner creates a meeting type that guests can see", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Добавить тип встречи" }).click();
  await page.getByRole("button", { name: "Создать тип", exact: true }).click();
  await expect(page.getByText("Введите название до 100 символов")).toBeVisible();
  await page.getByLabel("Название").focus();
  await expect(page.getByLabel("Название")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Описание")).toBeFocused();
  await page.getByLabel("Название").fill("Знакомство");
  await page.getByLabel("Описание").fill("Первый разговор");
  await page.getByLabel("Длительность в минутах").fill("30");
  await page.getByRole("button", { name: "Создать тип", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Знакомство" })).toBeVisible();
  await page.reload();
  const card = page.locator("article", {
    has: page.getByRole("heading", { name: "Знакомство" }),
  });
  await expect(card.getByText("Первый разговор")).toBeVisible();
  await expect(card.getByText("30 мин.")).toBeVisible();
});

test("guest selects a date and available time in UTC", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Добавить тип встречи" }).click();
  await page.getByLabel("Название").fill("Встреча для записи");
  await page.getByLabel("Описание").fill("Обсуждение");
  await page.getByLabel("Длительность в минутах").fill("60");
  await page.getByRole("button", { name: "Создать тип", exact: true }).click();
  await page.getByRole("link", { name: "Гость" }).click();
  await page.getByRole("button", { name: "Выбрать Встреча для записи" }).click();
  // The 14-day UTC window can span two months; count day buttons across both views.
  const dayButton = page.getByRole("button", { name: /\d{4}-\d{2}-\d{2} · \d+ свободно/ });
  await expect(dayButton.first()).toBeVisible();
  let total = await dayButton.count();
  const monthTitle = page.locator(".calendar-month-title");
  const firstMonth = await monthTitle.innerText();
  const nextMonth = page.getByRole("button", { name: "Следующий месяц" });
  if (await nextMonth.isEnabled()) {
    await nextMonth.click();
    await expect(monthTitle).not.toHaveText(firstMonth);
    total += await dayButton.count();
  }
  expect(total).toBe(14);
  await page
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2} · [1-9]\d* свободно/ })
    .first()
    .click();
  const slot = page.getByRole("button", { name: /^\d\d:\d\d UTC$/ }).first();
  await slot.click();
  await expect(slot).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Часовой пояс: UTC")).toBeVisible();
});

test("guest resolves a conflict without losing contacts and confirms a booking", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/meeting-types", {
    data: { name: "Конфликт", description: "Проверка", durationMinutes: 30 },
  });
  const type = await response.json();
  await page.goto("/book");
  await page.getByRole("button", { name: "Выбрать Конфликт" }).click();
  const dateButton = page
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2} · (?:[2-9]|[1-9]\d+) свободно/ })
    .first();
  const date = (await dateButton.getAttribute("aria-label"))!.slice(0, 10);
  await dateButton.click();
  const firstSlot = page.getByRole("button", { name: /^\d\d:\d\d UTC$/ }).first();
  const time = (await firstSlot.innerText()).slice(0, 5);
  await firstSlot.click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByLabel("Имя").fill("Алиса");
  await page.getByLabel("Email").fill("alice@example.com");
  const other = await request.post("/api/bookings", {
    headers: { "Idempotency-Key": "e2e-conflict-attempt" },
    data: {
      meetingTypeId: type.id,
      meetingTypeVersion: type.version,
      startsAt: `${date}T${time}:00.000Z`,
      guestName: "Другой",
      guestEmail: "other@example.com",
    },
  });
  expect(other.status()).toBe(201);
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByRole("alert")).toContainText("Слот уже недоступен");
  await page
    .getByRole("button", { name: /^\d\d:\d\d UTC$/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByLabel("Имя")).toHaveValue("Алиса");
  await expect(page.getByLabel("Email")).toHaveValue("alice@example.com");
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByRole("heading", { name: "Бронь подтверждена" })).toBeVisible();
  await expect(page.getByText(/· \d\d:\d\d – \d\d:\d\d · UTC/)).toBeVisible();
});

test("owner edits and confirms deletion of a meeting type", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Добавить тип встречи" }).click();
  await page.getByLabel("Название").fill("Управление типом");
  await page.getByLabel("Описание").fill("Исходное описание");
  await page.getByLabel("Длительность в минутах").fill("30");
  await page.getByRole("button", { name: "Создать тип", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Создать тип встречи" })).toHaveCount(0);
  const original = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Управление типом", exact: true }) });
  const edit = original.getByRole("button", { name: "Изменить", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  const editDialog = page.getByRole("dialog", { name: "Изменить Управление типом" });
  await expect(editDialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await editDialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(edit).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByLabel("Название типа").fill("Обновлённый тип");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Обновлённый тип", exact: true })).toBeVisible();
  const updated = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Обновлённый тип", exact: true }) });
  await expect(updated.getByRole("button", { name: "Изменить", exact: true })).toBeFocused();
  await updated.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.getByText(/Новые записи станут недоступны/)).toBeVisible();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Обновлённый тип", exact: true })).toBeVisible();
  await updated.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.getByRole("button", { name: "Подтвердить удаление" }).click();
  await expect(page.getByRole("heading", { name: "Обновлённый тип", exact: true })).toHaveCount(0);
});
