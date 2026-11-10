// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventsPage } from "./events";

window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }) as MediaQueryList;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const wrap = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineProvider>
        <EventsPage />
      </MantineProvider>
    </QueryClientProvider>,
  );
it("shows loading, empty state and refreshes the list", async () => {
  let finish!: (response: Response) => void;
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "one",
            meetingTypeName: "Call",
            startsAt: "2026-11-02T09:00:00.000Z",
            endsAt: "2026-11-02T10:00:00.000Z",
            guestName: "Alice",
            guestEmail: "alice@example.com",
            topic: "Первый вопрос\nВторой вопрос",
          },
          {
            id: "two",
            meetingTypeName: "Call",
            startsAt: "2026-11-02T11:00:00.000Z",
            endsAt: "2026-11-02T12:00:00.000Z",
            guestName: "Bob",
            guestEmail: "bob@example.com",
            topic: null,
          },
        ]),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  const { container } = wrap();
  expect(screen.getByText("Загрузка событий…")).toBeInTheDocument();
  finish(new Response("[]", { status: 200 }));
  expect(await screen.findByText("Предстоящих событий пока нет")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
  expect(await screen.findByText("Alice")).toBeInTheDocument();
  expect(screen.getAllByText(/Call ·/)).toHaveLength(2);
  expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  expect(screen.getByText(/Call · 09:00 – 10:00 · UTC/)).toBeInTheDocument();
  const topics = container.querySelectorAll(".event-topic");
  expect(topics).toHaveLength(1);
  expect(topics[0].textContent).toBe("Первый вопрос\nВторой вопрос");
  expect(screen.getByRole("heading", { name: "Bob" })).toBeInTheDocument();
  expect(screen.getByText("bob@example.com")).toBeInTheDocument();
});
it("shows a retryable error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  wrap();
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить события");
  expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
});
