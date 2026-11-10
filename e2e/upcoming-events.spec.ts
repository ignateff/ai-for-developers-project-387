import { expect, test, type APIRequestContext } from "./fixtures";

async function createType(request: APIRequestContext, name: string) {
  const response = await request.post("/api/meeting-types", {
    data: { name, description: "Встреча", durationMinutes: 30 },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; version: number };
}

async function firstSlot(request: APIRequestContext, typeId: string) {
  const summary = await (await request.get(`/api/meeting-types/${typeId}/availability`)).json();
  const date = summary.days.find((day: { availableCount: number }) => day.availableCount > 0).date;
  const slots = await (await request.get(`/api/meeting-types/${typeId}/slots?date=${date}`)).json();
  const slot = slots.slots.find((item: { available: boolean }) => item.available);
  return { date, slot };
}

test("guest creates a booking with a topic and sees it on its upcoming event card", async ({
  page,
  request,
}) => {
  const type = await createType(request, "Разбор с темой");
  const { date, slot } = await firstSlot(request, type.id);
  const topic =
    "Первый вопрос\nВторой вопрос: оченьдлинноесловобезпробеловкотороенедолжновызыватьгоризонтальнуюпрокрутку";

  await page.goto("/book");
  await page.getByRole("button", { name: "Выбрать Разбор с темой" }).last().click();
  await page.getByRole("button", { name: new RegExp(`^${date} · \\d+ свободно$`) }).click();
  await page.getByRole("button", { name: `${slot.startsAt.slice(11, 16)} UTC` }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByLabel("Имя").fill("Мария");
  await page.getByLabel("Email").fill("maria@example.com");
  await page.getByLabel("Что вы хотите обсудить?").fill(topic);
  await page.getByRole("button", { name: "Подтвердить запись" }).click();
  await expect(page.getByRole("heading", { name: "Бронь подтверждена" })).toBeVisible();

  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Предстоящие события" })).toBeVisible();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Мария" }) });
  await expect(card.getByText(/Первый вопрос\s+Второй вопрос/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("owner sees a booking without a topic on its upcoming event card without a topic row", async ({
  page,
  request,
}) => {
  const type = await createType(request, "Разбор без темы");
  const { slot } = await firstSlot(request, type.id);
  const booking = await request.post("/api/bookings", {
    headers: { "Idempotency-Key": "event-e2e-without-topic" },
    data: {
      meetingTypeId: type.id,
      meetingTypeVersion: type.version,
      startsAt: slot.startsAt,
      guestName: "Мария без темы",
      guestEmail: "maria-without-topic@example.com",
    },
  });
  expect(booking.status()).toBe(201);
  expect((await booking.json()).topic).toBeNull();

  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Предстоящие события" })).toBeVisible();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Мария без темы" }) });
  await expect(card.getByText("maria-without-topic@example.com")).toBeVisible();
  await expect(card).toContainText("Разбор без темы");
  await expect(card.locator(".event-topic")).toHaveCount(0);
});
