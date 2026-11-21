// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { BookPage } from "./book";
import { AdminTypesPage } from "./admin-types";

window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  }) as MediaQueryList;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows the empty state and validates the creation form", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Пока нет типов встреч")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Добавить тип встречи" }));
  fireEvent.click(await screen.findByRole("button", { name: "Создать тип" }));
  expect(screen.getByText("Введите название до 100 символов")).toBeInTheDocument();
});

it("does not expose owner management controls to guests", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Пока нет типов встреч")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Создать тип" })).not.toBeInTheDocument();
});

it("shows a retryable error when the list cannot be loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response("[]", { status: 200 })),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить типы встреч");
  expect(screen.queryByText("Пока нет типов встреч")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Пока нет типов встреч")).toBeInTheDocument();
});

it.each([
  [[]],
  [[{ id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 }]],
])("hides cached admin list data after a failed refetch: %j", async (cached) => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["meeting-types"], cached);
  render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить типы встреч");
  expect(screen.queryByText("Пока нет типов встреч")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Call" })).not.toBeInTheDocument();
});

it("hides stale meeting types if refreshing the list after returning fails", async () => {
  let listRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/availability")) {
        return new Response(JSON.stringify({ version: 1, days: [] }), { status: 200 });
      }
      listRequests++;
      if (listRequests === 2) throw new Error("offline");
      return new Response(
        JSON.stringify([
          { id: "one", name: "Call", description: "Intro", durationMinutes: 60, version: 1 },
        ]),
        { status: 200 },
      );
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать Call" }));
  fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить типы встреч");
  expect(screen.queryByRole("button", { name: "Выбрать Call" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByRole("button", { name: "Выбрать Call" })).toBeInTheDocument();
});

it("lets a guest select an available slot but not an occupied one", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.endsWith("/availability")
        ? { version: 1, days: [{ date: "2026-11-02", availableCount: 1 }] }
        : url.includes("/slots?")
          ? {
              version: 1,
              slots: [
                {
                  startsAt: "2026-11-02T09:00:00.000Z",
                  endsAt: "2026-11-02T10:00:00.000Z",
                  available: true,
                },
                {
                  startsAt: "2026-11-02T10:00:00.000Z",
                  endsAt: "2026-11-02T11:00:00.000Z",
                  available: false,
                },
              ],
            }
          : [{ id: "one", name: "Call", description: "Intro", durationMinutes: 60, version: 1 }];
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать Call" }));
  fireEvent.click(await screen.findByRole("button", { name: /2026-11-02/ }));
  expect(await screen.findByRole("button", { name: /10:00.*Занято/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "09:00 UTC" }));
  expect(screen.getByRole("button", { name: "09:00 UTC" })).toHaveAttribute("aria-pressed", "true");
});

it("accepts Unicode code points at the length limits and rejects values above them", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Пока нет типов встреч");
  fireEvent.click(screen.getByRole("button", { name: "Добавить тип встречи" }));
  const name = await screen.findByLabelText(/Название/);
  const description = screen.getByLabelText(/Описание/);
  fireEvent.change(name, { target: { value: "😀".repeat(100) } });
  fireEvent.change(description, { target: { value: "😀".repeat(1000) } });
  fireEvent.change(screen.getByLabelText(/Длительность в минутах/), { target: { value: "30" } });
  fireEvent.click(await screen.findByRole("button", { name: "Создать тип" }));
  expect(screen.queryByText("Введите название до 100 символов")).not.toBeInTheDocument();
  expect(screen.queryByText("Введите описание до 1000 символов")).not.toBeInTheDocument();
  await screen.findByRole("alert");
  fireEvent.change(name, { target: { value: "😀".repeat(101) } });
  fireEvent.change(description, { target: { value: "😀".repeat(1001) } });
  fireEvent.click(await screen.findByRole("button", { name: "Создать тип" }));
  expect(screen.getByText("Введите название до 100 символов")).toBeInTheDocument();
  expect(screen.getByText("Введите описание до 1000 символов")).toBeInTheDocument();
});

it("keeps contacts when returning to slot selection and confirms the booking", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let data: unknown;
      if (url.endsWith("/availability"))
        data = { version: 1, days: [{ date: "2026-11-02", availableCount: 1 }] };
      else if (url.includes("/slots?"))
        data = {
          version: 1,
          slots: [
            {
              startsAt: "2026-11-02T09:00:00.000Z",
              endsAt: "2026-11-02T10:00:00.000Z",
              available: true,
            },
          ],
        };
      else if (url.endsWith("/bookings")) {
        expect(new Headers(init?.headers).get("idempotency-key")).toBeTruthy();
        data = {
          id: "booking",
          meetingTypeName: "Call",
          startsAt: "2026-11-02T09:00:00.000Z",
          endsAt: "2026-11-02T10:00:00.000Z",
          guestName: "Alice",
          guestEmail: "a@example.com",
        };
      } else
        data = [{ id: "one", name: "Call", description: "Intro", durationMinutes: 60, version: 1 }];
      return new Response(JSON.stringify(data), {
        status: url.endsWith("/bookings") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать Call" }));
  fireEvent.click(await screen.findByRole("button", { name: /2026-11-02/ }));
  fireEvent.click(await screen.findByRole("button", { name: "09:00 UTC" }));
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
  fireEvent.change(screen.getByLabelText(/Имя/), { target: { value: "Alice" } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "a@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Изменить время" }));
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
  expect(screen.getByLabelText(/Имя/)).toHaveValue("Alice");
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить запись" }));
  expect(await screen.findByText("Бронь подтверждена")).toBeInTheDocument();
});

it("restores an unknown booking attempt, retries the same key and clears it on success", async () => {
  const attempt = {
    key: "secret-key",
    input: {
      meetingTypeId: "one",
      meetingTypeVersion: 1,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    },
  };
  sessionStorage.setItem("calendar-booking-attempt", JSON.stringify(attempt));
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/bookings")) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(attempt.key);
      expect(JSON.parse(String(init?.body))).toEqual(attempt.input);
      return new Response(
        JSON.stringify({
          meetingTypeName: "Call",
          startsAt: attempt.input.startsAt,
          endsAt: "2026-11-02T10:00:00.000Z",
        }),
        { status: 201 },
      );
    }
    return new Response("[]", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  expect(screen.getByText(/повтор может впервые создать запись/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Повторить попытку" }));
  expect(await screen.findByText("Бронь подтверждена")).toBeInTheDocument();
  expect(sessionStorage.getItem("calendar-booking-attempt")).toBeNull();
});

it("keeps an unknown attempt after 503 and requires confirmation before forgetting it", async () => {
  const attempt = {
    key: "secret-key",
    input: {
      meetingTypeId: "one",
      meetingTypeVersion: 1,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    },
  };
  sessionStorage.setItem("calendar-booking-attempt", JSON.stringify(attempt));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/bookings")
        ? new Response(JSON.stringify({ code: "DATABASE_BUSY", message: "busy" }), { status: 503 })
        : new Response("[]", { status: 200 }),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Повторить попытку" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Результат неизвестен");
  expect(sessionStorage.getItem("calendar-booking-attempt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Забыть попытку" }));
  const forgetDialog = await screen.findByRole("dialog", { name: "Забыть попытку" });
  expect(
    within(forgetDialog).getByText(/Запись может существовать и не отменяется/),
  ).toHaveTextContent("Новая попытка может создать вторую запись");
  expect(sessionStorage.getItem("calendar-booking-attempt")).toBeTruthy();
  fireEvent.click(within(forgetDialog).getByRole("button", { name: "Назад" }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Забыть попытку" })).not.toBeInTheDocument(),
  );
  expect(sessionStorage.getItem("calendar-booking-attempt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Забыть попытку" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить забывание" }));
  expect(sessionStorage.getItem("calendar-booking-attempt")).toBeNull();
  expect(await screen.findByText("Пока нет типов встреч")).toBeInTheDocument();
});

it("allows editing and confirming deletion of a meeting type", async () => {
  const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT")
      return new Response(JSON.stringify({ ...type, name: "Updated", version: 2 }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"2"' },
      });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify([type]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  const edit = await screen.findByRole("button", { name: "Изменить" });
  expect(edit).toHaveAccessibleDescription("Call");
  expect(screen.getByRole("button", { name: "Удалить" })).toHaveAccessibleDescription("Call");
  fireEvent.click(edit);
  fireEvent.change(await screen.findByLabelText(/Название типа/), { target: { value: " " } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(screen.getByLabelText(/Название типа/)).toHaveAttribute("aria-invalid", "true");
  fireEvent.change(screen.getByLabelText(/Название типа/), { target: { value: "Updated" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("button", { name: "Изменить" });
  expect(
    fetchMock.mock.calls.some(
      ([, init]) => init?.method === "PUT" && new Headers(init.headers).get("if-match") === '"1"',
    ),
  ).toBe(true);
  const remove = screen.getByRole("button", { name: "Удалить" });
  remove.focus();
  fireEvent.click(remove);
  const dialog = await screen.findByRole("dialog", { name: "Удалить тип встречи" });
  expect(screen.getByRole("heading", { name: "Call" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Изменить" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Удалить" })).toBeVisible();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Удалить тип встречи" })).not.toBeInTheDocument(),
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  await vi.waitFor(() => expect(remove).toHaveFocus());
  fireEvent.click(remove);
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить удаление" }));
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Добавить тип встречи" })).toHaveFocus(),
  );
});

it("keeps the delete confirmation open with an error when deletion fails", async () => {
  const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
  let resolveDelete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE")
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      return new Response(JSON.stringify([type]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));
  const dialog = await screen.findByRole("dialog", { name: "Удалить тип встречи" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Подтвердить удаление" }));
  await vi.waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Отмена" })).toBeDisabled(),
  );
  resolveDelete(new Response(null, { status: 500 }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Не удалось удалить тип");
  expect(screen.getByRole("dialog", { name: "Удалить тип встречи" })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Отмена" })).toBeEnabled();
});

it("shows a dismissible notice when the type is already gone", async () => {
  const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
  let lists = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 404 });
      return new Response(JSON.stringify(++lists === 1 ? [type] : []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить удаление" }));
  const banner = await screen.findByRole("alert");
  expect(banner).toHaveTextContent("Тип встречи изменился или удалён. Список обновлён.");
  expect(screen.queryByRole("heading", { name: "Call" })).not.toBeInTheDocument();
  const add = screen.getByRole("button", { name: "Добавить тип встречи" });
  await vi.waitFor(() => expect(add).toHaveFocus());
  fireEvent.click(within(banner).getByRole("button", { name: "Понятно" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps a version conflict notice in the card after a delete", async () => {
  const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
  let lists = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 412 });
      return new Response(JSON.stringify([{ ...type, version: ++lists === 1 ? 1 : 2 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  const remove = await screen.findByRole("button", { name: "Удалить" });
  remove.focus();
  fireEvent.click(remove);
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить удаление" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Тип встречи изменился или удалён. Список обновлён.",
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Удалить тип встречи" })).not.toBeInTheDocument(),
  );
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Удалить" })).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  expect(screen.queryByText(/Тип встречи изменился или удалён/)).not.toBeInTheDocument();
});

it("refreshes a conflicting version without losing the edit draft", async () => {
  const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
  let lists = 0;
  const versions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        versions.push(new Headers(init.headers).get("if-match") ?? "");
        return versions.length === 1
          ? new Response(null, { status: 412 })
          : new Response(JSON.stringify({ ...type, version: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify([{ ...type, version: ++lists === 1 ? 1 : 2 }]), {
        status: 200,
      });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Изменить" }));
  fireEvent.change(await screen.findByLabelText("Название типа"), { target: { value: "Draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Обновить версию" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Сохранить" })).toBeEnabled());
  expect(screen.getByLabelText("Название типа")).toHaveValue("Draft");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await vi.waitFor(() => expect(versions).toEqual(['"1"', '"2"']));
});

it("refreshes the list without closing a reopened editor or losing its draft", async () => {
  let type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
  let resolveSave!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT")
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      return new Response(JSON.stringify([type]), { status: 200 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider env="test">
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Изменить" }));
  const first = within(await screen.findByRole("dialog"));
  fireEvent.change(first.getByLabelText("Название типа"), { target: { value: "Saved" } });
  fireEvent.click(first.getByRole("button", { name: "Сохранить" }));
  await vi.waitFor(() => expect(resolveSave).toBeDefined());
  fireEvent.click(first.getByRole("button", { name: "Отмена" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
  const second = within(await screen.findByRole("dialog"));
  fireEvent.change(second.getByLabelText("Название типа"), { target: { value: "New draft" } });
  fireEvent.change(second.getByLabelText("Описание типа"), { target: { value: "New intro" } });
  fireEvent.change(second.getByLabelText("Длительность типа в минутах"), {
    target: { value: "45" },
  });
  type = { ...type, name: "Saved", version: 2 };
  resolveSave(new Response(JSON.stringify(type), { status: 200 }));
  expect(await screen.findByRole("heading", { name: "Saved" })).toBeVisible();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(second.getByLabelText("Название типа")).toHaveValue("New draft");
  expect(second.getByLabelText("Описание типа")).toHaveValue("New intro");
  expect(second.getByLabelText("Длительность типа в минутах")).toHaveValue(45);
  expect(second.getByRole("button", { name: "Сохранить" })).toBeEnabled();
});

it.each([500, 412, 404, "offline"])(
  "isolates an earlier save failure (%s) from a reopened editor's pending save",
  async (failure) => {
    const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
    const requests: {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      version: string | null;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT")
          return new Promise<Response>((resolve, reject) => {
            requests.push({
              resolve,
              reject,
              version: new Headers(init.headers).get("if-match"),
            });
          });
        return new Response(JSON.stringify([type]), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider env="test">
          <AdminTypesPage />
        </MantineProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Название типа"), { target: { value: "New draft" } });
    const save = dialog.getByRole("button", { name: "Сохранить" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      if (failure === "offline") requests[0]!.reject(new Error("offline"));
      else requests[0]!.resolve(new Response(null, { status: Number(failure) }));
    });
    expect(save).toBeDisabled();
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Обновить версию" })).not.toBeInTheDocument();
    expect(dialog.getByLabelText("Название типа")).toHaveValue("New draft");
    await act(async () => requests[1]!.resolve(new Response(null, { status: 500 })));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Не удалось сохранить изменения");
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.map((request) => request.version)).toEqual(['"1"', '"1"', '"1"']);
    await act(async () => requests[2]!.resolve(new Response(null, { status: 500 })));
  },
);

it.each([200, 500, "offline"])(
  "ignores a late version refresh (%s) after reopening the editor",
  async (status) => {
    const type = { id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 };
    let resolveRefresh!: (response: Response) => void;
    let rejectRefresh!: (error: Error) => void;
    let lists = 0;
    const versions: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          versions.push(new Headers(init.headers).get("if-match"));
          return new Response(null, { status: versions.length === 1 ? 412 : 500 });
        }
        if (++lists === 2)
          return new Promise<Response>((resolve, reject) => {
            resolveRefresh = resolve;
            rejectRefresh = reject;
          });
        return new Response(JSON.stringify([type]), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider env="test">
          <AdminTypesPage />
        </MantineProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Обновить версию" }));
    await vi.waitFor(() => expect(resolveRefresh).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Название типа"), { target: { value: "New draft" } });
    fireEvent.click(dialog.getByRole("button", { name: "Сохранить" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Не удалось сохранить изменения");
    await act(async () => {
      if (status === "offline") rejectRefresh(new Error("offline"));
      else
        resolveRefresh(
          new Response(JSON.stringify([{ ...type, version: 7 }]), { status: Number(status) }),
        );
    });
    expect(dialog.getByLabelText("Название типа")).toHaveValue("New draft");
    expect(dialog.getByRole("alert")).toHaveTextContent("Не удалось сохранить изменения");
    expect(dialog.queryByRole("button", { name: "Обновить версию" })).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Сохранить" }));
    await vi.waitFor(() => expect(versions).toEqual(['"1"', '"1"', '"1"']));
  },
);

it("does not close a reopened creation dialog when an earlier request succeeds", async () => {
  let resolveCreate!: (response: Response) => void;
  let lists = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      lists++;
      return new Response("[]", { status: 200 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <AdminTypesPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Пока нет типов встреч");
  fireEvent.click(screen.getByRole("button", { name: "Добавить тип встречи" }));
  fireEvent.change(await screen.findByLabelText("Название"), { target: { value: "First" } });
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Description" } });
  fireEvent.change(screen.getByLabelText("Длительность в минутах"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать тип" }));
  await vi.waitFor(() => expect(resolveCreate).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  fireEvent.click(screen.getByRole("button", { name: "Добавить тип встречи" }));
  fireEvent.change(await screen.findByLabelText("Название"), { target: { value: "Second draft" } });
  resolveCreate(new Response(JSON.stringify({ id: "one" }), { status: 201 }));
  await vi.waitFor(() => expect(lists).toBeGreaterThan(1));
  await vi.waitFor(() => expect(screen.getByLabelText("Название")).toHaveValue("Second draft"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it.each([500, "offline"])(
  "keeps a reopened creation dialog independent of a late failure (%s)",
  async (status) => {
    let resolveCreate!: (response: Response) => void;
    let rejectCreate!: (error: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST")
          return new Promise<Response>((resolve, reject) => {
            resolveCreate = resolve;
            rejectCreate = reject;
          });
        return new Response("[]", { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider env="test">
          <AdminTypesPage />
        </MantineProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Пока нет типов встреч");
    fireEvent.click(screen.getByRole("button", { name: "Добавить тип встречи" }));
    fireEvent.change(await screen.findByLabelText("Название"), { target: { value: "First" } });
    fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Description" } });
    fireEvent.change(screen.getByLabelText("Длительность в минутах"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать тип" }));
    await vi.waitFor(() => expect(resolveCreate).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Добавить тип встречи" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Название"), { target: { value: "Second draft" } });
    await act(async () => {
      if (status === "offline") rejectCreate(new Error("offline"));
      else resolveCreate(new Response(null, { status: Number(status) }));
    });
    expect(dialog.getByLabelText("Название")).toHaveValue("Second draft");
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Создать тип" })).toBeEnabled();
  },
);

it("disables changing the meeting type while the booking request is in flight", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/bookings")) return new Promise<Response>(() => {});
      const data = url.endsWith("/availability")
        ? { version: 1, days: [{ date: "2026-11-02", availableCount: 1 }] }
        : url.includes("/slots?")
          ? {
              version: 1,
              slots: [
                {
                  startsAt: "2026-11-02T09:00:00.000Z",
                  endsAt: "2026-11-02T10:00:00.000Z",
                  available: true,
                },
              ],
            }
          : [{ id: "one", name: "Call", description: "Intro", durationMinutes: 60, version: 1 }];
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <BookPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать Call" }));
  fireEvent.click(await screen.findByRole("button", { name: /2026-11-02/ }));
  fireEvent.click(await screen.findByRole("button", { name: "09:00 UTC" }));
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
  fireEvent.change(screen.getByLabelText(/Имя/), { target: { value: "Alice" } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "a@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить запись" }));
  expect(screen.getByRole("button", { name: /Выбрать другой тип/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Изменить время" })).toBeDisabled();
  sessionStorage.clear();
});
