// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { Layout } from "./layout";

beforeAll(() => {
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: () => {},
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Layout footer", () => {
  it("renders the copyright landmark with the current year", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-27T08:00:00Z"));
    render(
      <BrowserRouter>
        <Layout />
      </BrowserRouter>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(footer.tagName).toBe("FOOTER");
    expect(footer).toHaveTextContent("© 2026 Календарь звонков");
  });

  it("updates the year on the next render after New Year", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    const layout = () => (
      <BrowserRouter>
        <Layout />
      </BrowserRouter>
    );
    const { rerender } = render(layout());
    expect(screen.getByRole("contentinfo")).toHaveTextContent("© 2026 Календарь звонков");

    vi.setSystemTime(new Date(2027, 0, 1));
    rerender(layout());
    expect(screen.getByRole("contentinfo")).toHaveTextContent("© 2027 Календарь звонков");
  });
});

describe("Layout navigation", () => {
  it("renders brand and nav links with their routes", () => {
    render(
      <MantineProvider defaultColorScheme="light">
        <BrowserRouter>
          <Layout />
        </BrowserRouter>
      </MantineProvider>,
    );

    expect(screen.getByText("Calendar")).toBeInTheDocument();

    const nav = screen.getByRole("navigation", {
      name: "Основная навигация",
    });
    const bookLink = screen
      .getAllByRole("link", { name: "Записаться" })
      .find((link) => nav.contains(link));
    expect(bookLink).toHaveAttribute("href", "/book");
  });
});
