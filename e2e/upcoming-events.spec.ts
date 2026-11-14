import { expect, test } from "./fixtures";

test("owner sees a newly created booking in upcoming events", async ({ page, request }) => {
  const typeResponse = await request.post("/api/meeting-types", {
    data: { name: "Разбор", description: "Встреча", durationMinutes: 30 },
  });
  const type = await typeResponse.json();
  const summary = await (await request.get(`/api/meeting-types/${type.id}/availability`)).json();
  const date = summary.days.find((day: { availableCount: number }) => day.availableCount > 0).date;
  const slots = await (
    await request.get(`/api/meeting-types/${type.id}/slots?date=${date}`)
  ).json();
  const slot = slots.slots.find((item: { available: boolean }) => item.available);
  const booking = await request.post("/api/bookings", {
    headers: { "Idempotency-Key": "event-e2e-attempt" },
    data: {
      meetingTypeId: type.id,
      meetingTypeVersion: type.version,
      startsAt: slot.startsAt,
      guestName: "Мария",
      guestEmail: "maria@example.com",
    },
  });
  expect(booking.status()).toBe(201);
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Предстоящие события" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Мария" })).toBeVisible();
  await expect(page.getByText("maria@example.com")).toBeVisible();
  await expect(page.getByText("Разбор")).toBeVisible();
  await expect(
    page.getByText(`Разбор · ${slot.startsAt.slice(11, 16)} – ${slot.endsAt.slice(11, 16)} · UTC`),
  ).toBeVisible();
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("heading", { name: "Мария" })).toBeVisible();
});

test("owner can retry loading upcoming events after an error", async ({ page }) => {
  const retryResponse = Promise.withResolvers<void>();
  const events = [
    {
      id: "recovered-event",
      meetingTypeName: "Разбор",
      startsAt: "2026-11-03T09:00:00.000Z",
      endsAt: "2026-11-03T09:30:00.000Z",
      guestName: "Анна",
      guestEmail: "anna@example.com",
    },
  ];
  let attempt = 0;
  await page.route("**/api/events/upcoming", async (route) => {
    attempt += 1;
    if (attempt === 2) await retryResponse.promise;
    if (attempt <= 2) {
      await route.fulfill({ status: 500, json: {} });
    } else {
      await route.fulfill({ json: events });
    }
  });

  await page.goto("/admin/events");
  const alert = page.getByRole("alert");
  const retry = alert.getByRole("button", { name: "Повторить", exact: true });
  await expect(alert).toContainText("Не удалось загрузить события");
  try {
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(alert).toBeVisible();
  } finally {
    retryResponse.resolve();
  }

  await expect(retry).toBeEnabled();
  await expect(alert).toBeVisible();
  await retry.click();
  await expect(alert).toBeHidden();
  await expect(page.getByRole("heading", { name: "Анна" })).toBeVisible();
});
