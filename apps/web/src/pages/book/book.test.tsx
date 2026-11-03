// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
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
  expect(screen.getByText(/Запись может существовать и не отменяется/)).toHaveTextContent(
    "Новая попытка может создать вторую запись",
  );
  expect(sessionStorage.getItem("calendar-booking-attempt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить забывание" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
  );
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
