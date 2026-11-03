// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { AppQueryProvider } from "./query-provider";

afterEach(cleanup);

it("provides a query client to the application", async () => {
  function QueryConsumer() {
    const query = useQuery({ queryKey: ["provider-test"], queryFn: async () => "Query ready" });
    return <span>{query.data}</span>;
  }
  render(
    <AppQueryProvider>
      <QueryConsumer />
    </AppQueryProvider>,
  );
  expect(await screen.findByText("Query ready")).toBeTruthy();
});
