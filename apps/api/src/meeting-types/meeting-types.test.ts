import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { buildApp } from "../app.js";

it("creates normalized meeting types and keeps them across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "calendar-types-"));
  const path = join(dir, "db.sqlite");
  try {
    const app = buildApp({ databasePath: path });
    const created = await app.inject({
      method: "POST",
      url: "/api/meeting-types",
      payload: { name: " Call ", description: " Intro ", durationMinutes: 30 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "Call",
      description: "Intro",
      durationMinutes: 30,
      version: 1,
    });
    await app.close();
    const reopened = buildApp({ databasePath: path });
    const list = await reopened.inject({ method: "GET", url: "/api/meeting-types" });
    expect(list.json()).toEqual([created.json()]);
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects invalid inputs and accepts duplicate names and duration boundaries", async () => {
  const app = buildApp();
  try {
    for (const payload of [
      { name: " ", description: "ok", durationMinutes: 1 },
      { name: "x".repeat(101), description: "ok", durationMinutes: 1 },
      { name: "ok", description: "x".repeat(1001), durationMinutes: 1 },
      { name: "ok", description: "ok", durationMinutes: 0 },
      { name: "ok", description: "ok", durationMinutes: 1.5 },
      { name: "ok", description: "ok", durationMinutes: 2147483648 },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/meeting-types", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("VALIDATION_ERROR");
    }
    for (const durationMinutes of [1, 2147483647]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Same", description: "Description", durationMinutes },
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      expect(response.json().id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((await app.inject({ method: "GET", url: "/api/meeting-types" })).json()).toHaveLength(2);
  } finally {
    await app.close();
  }
});

it("accepts Unicode code points at the length limits and rejects values above them", async () => {
  const app = buildApp();
  try {
    const post = (name: string, description: string) =>
      app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name, description, durationMinutes: 30 },
      });
    expect((await post("😀".repeat(100), "😀".repeat(1000))).statusCode).toBe(201);
    expect((await post("😀".repeat(101), "ok")).statusCode).toBe(400);
    expect((await post("ok", "😀".repeat(1001))).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
