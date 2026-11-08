// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BookingSuccess } from "./success";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("copies the displayed meeting details after a successful booking", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <BookingSuccess
      typeName="Знакомство"
      startsAt="2026-03-28T10:00:00.000Z"
      endsAt="2026-03-28T10:30:00.000Z"
      againLabel="Записаться ещё"
      onAgain={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Скопировать детали" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("Знакомство · 28 марта · 10:00 – 10:30 · UTC"),
  );
  expect(await screen.findByRole("status")).toHaveTextContent("Детали скопированы");
});

it("keeps details and retry available when the clipboard is unavailable", async () => {
  const onAgain = vi.fn();
  vi.stubGlobal("navigator", {});
  render(
    <BookingSuccess
      typeName="Знакомство"
      startsAt="2026-03-28T10:00:00.000Z"
      endsAt="2026-03-28T10:30:00.000Z"
      againLabel="Записаться ещё"
      onAgain={onAgain}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Скопировать детали" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скопировать детали");
  expect(screen.getByText("Знакомство · 28 марта · 10:00 – 10:30 · UTC")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Записаться ещё" }));
  expect(onAgain).toHaveBeenCalledOnce();
});

it("reports a rejected clipboard write without claiming it was copied", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(
    <BookingSuccess
      typeName="Знакомство"
      startsAt="2026-03-28T10:00:00.000Z"
      endsAt="2026-03-28T10:30:00.000Z"
      againLabel="Записаться ещё"
      onAgain={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Скопировать детали" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скопировать детали");
  expect(screen.queryByText("Детали скопированы")).not.toBeInTheDocument();
});
