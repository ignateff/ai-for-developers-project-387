// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { MainPage } from "./main";

const steps = ["Выберите дату", "Найдите время", "Подтвердите запись"];

beforeAll(() => {
  // jsdom has no matchMedia; Mantine components observe color scheme media queries.
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

describe("MainPage", () => {
  it("renders the hero heading", () => {
    render(
      <MantineProvider defaultColorScheme="light">
        <BrowserRouter>
          <MainPage />
        </BrowserRouter>
      </MantineProvider>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Время для важных разговоров",
    );
  });

  it("links the call to action to the booking page", () => {
    render(
      <MantineProvider defaultColorScheme="light">
        <BrowserRouter>
          <MainPage />
        </BrowserRouter>
      </MantineProvider>,
    );

    const cta = screen.getByRole("link", { name: "Записаться на звонок" });
    expect(cta).toHaveAttribute("href", "/book");
  });

  it("describes how booking works in three steps", () => {
    render(
      <MantineProvider defaultColorScheme="light">
        <BrowserRouter>
          <MainPage />
        </BrowserRouter>
      </MantineProvider>,
    );

    expect(screen.getByRole("heading", { name: "Как это работает" })).toBeInTheDocument();
    const list = screen.getByRole("list");
    const items = screen.getAllByRole("listitem");
    expect(list).toBeInTheDocument();
    expect(items).toHaveLength(3);
    for (const [index, step] of steps.entries()) {
      expect(items[index]).toHaveTextContent(step);
    }
  });
});
