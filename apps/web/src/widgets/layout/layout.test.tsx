// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

afterEach(cleanup);

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
