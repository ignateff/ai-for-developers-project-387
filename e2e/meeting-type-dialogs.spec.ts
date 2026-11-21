import { expect, test } from "./fixtures";

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

for (const status of [201, 500] as const) {
  test(`owner keeps a reopened creation draft after a late ${status} response`, async ({
    page,
  }, info) => {
    const name = `Создан поздно ${status} повтор ${info.repeatEachIndex}`;
    const gate = deferredSignal();
    const intercepted = deferredSignal();
    await page.route("**/api/meeting-types", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = status === 201 ? await route.fetch() : undefined;
      intercepted.resolve();
      await gate.promise;
      if (response) await route.fulfill({ response });
      else await route.fulfill({ status, json: {} });
    });
    await page.goto("/admin");
    await page.getByRole("button", { name: "Добавить тип встречи" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Название", { exact: true }).fill(name);
    await dialog.getByLabel("Описание", { exact: true }).fill("Описание");
    await dialog.getByLabel("Длительность в минутах").fill("30");
    await dialog.getByRole("button", { name: "Создать тип", exact: true }).click();
    await intercepted.promise;
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Добавить тип встречи" }).click();
    await dialog.getByLabel("Название", { exact: true }).fill("Новый черновик");
    const finished = page
      .waitForResponse(
        (res) => res.request().method() === "POST" && res.url().endsWith("/meeting-types"),
      )
      .then((res) => res.finished());
    gate.resolve();
    await finished;
    if (status === 201)
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Название", { exact: true })).toHaveValue("Новый черновик");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Создать тип", exact: true })).toBeEnabled();
  });
}

for (const outcome of [200, 500, 412, 404, "offline", "refresh-failure"] as const) {
  test(`owner keeps a reopened edit draft after a late ${outcome} response`, async ({
    page,
    request,
  }, info) => {
    const name = `Поздний ответ ${outcome} повтор ${info.repeatEachIndex}`;
    const created = await request.post("/api/meeting-types", {
      data: { name, description: "Исходное описание", durationMinutes: 30 },
    });
    expect(created.status()).toBe(201);
    const type = await created.json();
    const gate = deferredSignal();
    const intercepted = deferredSignal();
    const saved = outcome === 200 || outcome === "refresh-failure";
    let failList = false;
    await page.route("**/api/meeting-types", (route) =>
      failList && route.request().method() === "GET"
        ? route.fulfill({ status: 500, json: {} })
        : route.continue(),
    );
    let saves = 0;
    await page.route(`**/api/meeting-types/${type.id}`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      saves++;
      if (saves !== 1) return route.continue();
      // Persist the successful update before withholding its response from the owner.
      const response = saved ? await route.fetch() : undefined;
      intercepted.resolve();
      await gate.promise;
      if (outcome === "offline") await route.abort("failed");
      else if (response) await route.fulfill({ response });
      else await route.fulfill({ status: Number(outcome), json: {} });
    });
    await page.goto("/admin");
    const card = page.locator("article").filter({
      has: page.getByRole("heading", { name, exact: true }),
    });
    await card.getByRole("button", { name: "Изменить", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Название типа", { exact: true }).fill(`${name} сохранён`);
    await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    await intercepted.promise;
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await card.getByRole("button", { name: "Изменить", exact: true }).click();
    await dialog.getByLabel("Название типа", { exact: true }).fill(`${name} черновик`);
    await dialog.getByLabel("Описание типа").fill("Новый черновик описания");
    await dialog.getByLabel("Длительность типа в минутах").fill("45");
    await expect(dialog.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    const finished =
      outcome === "offline"
        ? page.waitForEvent("requestfailed", {
            predicate: (req) => req.method() === "PUT" && req.url().endsWith(type.id),
          })
        : page
            .waitForResponse(
              (res) => res.request().method() === "PUT" && res.url().endsWith(type.id),
            )
            .then((res) => res.finished());
    failList = outcome === "refresh-failure";
    gate.resolve();
    await finished;
    if (outcome === "refresh-failure") {
      await expect(page.getByRole("alert")).toContainText("Не удалось загрузить типы встреч");
      await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
      failList = false;
    }
    if (outcome === 200)
      await expect(
        page.getByRole("heading", { name: `${name} сохранён`, exact: true }),
      ).toBeVisible();
    // A second save proves the new dialog remains actionable after the old response.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Название типа", { exact: true })).toHaveValue(
      `${name} черновик`,
    );
    await expect(dialog.getByLabel("Описание типа")).toHaveValue("Новый черновик описания");
    await expect(dialog.getByLabel("Длительность типа в минутах")).toHaveValue("45");
    const retried = page.waitForRequest(
      (req) => req.method() === "PUT" && req.url().endsWith(type.id),
    );
    await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await retried).headers()["if-match"]).toBe('"1"');
    if (saved) {
      // The draft retains its selected version, even though the list now has version 2.
      await expect(dialog.getByRole("alert")).toContainText("Обновите версию");
      await dialog.getByRole("button", { name: "Обновить версию" }).click();
      await expect(dialog.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
      await expect(dialog.getByLabel("Название типа", { exact: true })).toHaveValue(
        `${name} черновик`,
      );
      await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: `${name} черновик`, exact: true }),
    ).toBeVisible();
  });
}
