import { expect, test, type APIRequestContext, type Page } from "./fixtures";

// Визуальные регрессионные проверки по docs/design/calendar-booking.pen.
// Файл должен запускаться первым (префикс 00-): эталоны сняты на пустой базе,
// а Playwright исполняет файлы по алфавиту с одним общим сервером.
// Время сервера и браузера зафиксировано (e2e/fixed-now.ts и fixtures.ts),
// поэтому календарь всегда показывает окно с 27 марта 2026, как в макете.

const DESKTOP = { width: 1400, height: 900 };
const NARROW = { width: 390, height: 844 };

async function createType(request: APIRequestContext, name = "Интервью") {
  const response = await request.post("/api/meeting-types", {
    data: {
      name,
      description: "Познакомиться и обсудить задачи",
      durationMinutes: 30,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; version: number };
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

async function openBooking(page: Page, request: APIRequestContext) {
  await createType(request);
  await page.goto("/book");
  await page.getByRole("button", { name: "Выбрать Интервью" }).first().click();
  await expect(page.getByRole("button", { name: "2026-03-30 · 18 свободно" })).toBeVisible();
}

test("landing page", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Время для важных разговоров" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("landing-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("landing page on a narrow screen", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Время для важных разговоров" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("landing-narrow.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("booking type list, empty state", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/book");
  await expect(page.getByText("Пока нет типов встреч")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("book-empty-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("guest meeting types on desktop and narrow screens", async ({ page, request }) => {
  await createType(request);
  await createType(request, "Консультация");
  await page.setViewportSize(DESKTOP);
  await page.goto("/book");
  await expect(page.getByRole("heading", { name: "Интервью" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Консультация" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("guest-types-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize(NARROW);
  await expect(page).toHaveScreenshot("guest-types-narrow.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("booking calendar without a selected date", async ({ page, request }) => {
  await page.setViewportSize(DESKTOP);
  await openBooking(page, request);
  await settle(page);
  await expect(page).toHaveScreenshot("booking-calendar-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("booking calendar on a narrow screen", async ({ page, request }) => {
  await page.setViewportSize(NARROW);
  await openBooking(page, request);
  await settle(page);
  await expect(page).toHaveScreenshot("booking-calendar-narrow.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("booking slots with a selected date and slot", async ({ page, request }) => {
  await page.setViewportSize(DESKTOP);
  await openBooking(page, request);
  await page.getByRole("button", { name: "2026-03-30 · 18 свободно" }).click();
  const slot = page.getByRole("button", { name: "09:00 UTC" });
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(slot).toHaveAttribute("aria-pressed", "true");
  await settle(page);
  await expect(page).toHaveScreenshot("booking-slots-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("booking confirmation form", async ({ page, request }) => {
  await page.setViewportSize(DESKTOP);
  await openBooking(page, request);
  await page.getByRole("button", { name: "2026-03-30 · 18 свободно" }).click();
  await page.getByRole("button", { name: "09:00 UTC" }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByRole("heading", { name: "Подтверждение записи" })).toBeVisible();
  await expect(page.getByText("После подтверждения сохраните детали записи.")).toBeVisible();
  await expect(page.getByText(/детали.*отправ.*почт/i)).toHaveCount(0);
  await settle(page);
  await expect(page).toHaveScreenshot("booking-form-desktop.png", {
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await page.setViewportSize(NARROW);
  await expect(page).toHaveScreenshot("booking-form-narrow.png", {
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
});

test("booking success", async ({ page, request }) => {
  await page.setViewportSize(DESKTOP);
  await openBooking(page, request);
  await page.getByRole("button", { name: "2026-03-30 · 18 свободно" }).click();
  await page.getByRole("button", { name: "09:00 UTC" }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByLabel("Имя").fill("Анна Смирнова");
  await page.getByLabel("Email").fill("anna@example.com");
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByRole("heading", { name: "Бронь подтверждена" })).toBeVisible();
  await expect(page.getByText("До встречи! Сохраните детали записи самостоятельно.")).toBeVisible();
  await expect(page.getByText(/детали.*отправ.*почт/i)).toHaveCount(0);
  await expect(page.getByText(/Интервью.*09:00.*09:30.*UTC/)).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("booking-success-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize(NARROW);
  await expect(page).toHaveScreenshot("booking-success-narrow.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("upcoming events list", async ({ page }) => {
  // Показывает запись, созданную предыдущим тестом «booking success».
  await page.setViewportSize(DESKTOP);
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Анна Смирнова" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("events-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("upcoming events on a narrow screen", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Анна Смирнова" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("events-narrow.png", {
    fullPage: true,
    animations: "disabled",
  });
});
