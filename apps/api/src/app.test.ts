import { expect, test } from "vitest";
import { buildApp } from "./app.js";

test("starts the HTTP server and responds to a health request", async () => {
  const app = buildApp();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  } finally {
    await app.close();
  }
});
