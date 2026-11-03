// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, it, vi } from "vitest";
import { BookingForm } from "./booking-form";
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
it("persists the attempt before sending, preserving it when the response is lost", async () => {
  const unknown = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      const saved = JSON.parse(sessionStorage.getItem("calendar-booking-attempt")!);
      expect(saved.key).toBe(new Headers(options?.headers).get("idempotency-key"));
      expect(saved.input).toEqual(JSON.parse(String(options?.body)));
      throw new Error("connection lost");
    }),
  );
  render(
    <MantineProvider>
      <BookingForm
        type={{ id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 }}
        startsAt="2026-11-02T09:00:00.000Z"
        name="Alice"
        email="a@example.com"
        setName={() => {}}
        setEmail={() => {}}
        onBack={() => {}}
        onConflict={() => {}}
        onTypeChanged={() => {}}
        onSuccess={() => {}}
        onUnknown={unknown}
      />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить запись" }));
  await waitFor(() => expect(unknown).toHaveBeenCalledOnce());
  expect(JSON.parse(sessionStorage.getItem("calendar-booking-attempt")!)).toEqual(
    unknown.mock.calls[0][0],
  );
});

it("prevents navigation and edits while a booking is being sent", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  render(
    <MantineProvider>
      <BookingForm
        type={{ id: "one", name: "Call", description: "Intro", durationMinutes: 30, version: 1 }}
        startsAt="2026-11-02T09:00:00.000Z"
        name="Alice"
        email="a@example.com"
        setName={() => {}}
        setEmail={() => {}}
        onBack={() => {}}
        onConflict={() => {}}
        onTypeChanged={() => {}}
        onSuccess={() => {}}
        onUnknown={() => {}}
        onPendingChange={() => {}}
      />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить запись" }));
  expect(screen.getByRole("button", { name: "Изменить время" })).toBeDisabled();
  expect(screen.getByLabelText(/Имя/)).toBeDisabled();
  expect(screen.getByLabelText(/Email/)).toBeDisabled();
});
