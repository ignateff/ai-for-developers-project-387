import { expect, test } from "@playwright/test";

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
