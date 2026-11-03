import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import OpenAPIBackend from "openapi-backend";
import { parse } from "yaml";
import { expect, test } from "vitest";
import { buildApp } from "./app.js";
import { compareRoutes, collectRoutes } from "./contract-check.js";

const definition = parse(readFileSync(resolve("generated/openapi/openapi.yaml"), "utf8"));

test("the public Fastify routes match the OpenAPI operations", async () => {
  const routes = collectRoutes();
  const app = buildApp({ onRoute: routes.onRoute });
  try {
    await app.ready();
    expect(compareRoutes(routes.entries, definition)).toEqual({
      undocumented: [],
      unimplemented: [],
    });
  } finally {
    await app.close();
  }
});

test("detects real undocumented routes and a documented route without implementation", async () => {
  const routes = collectRoutes();
  const app = buildApp({ onRoute: routes.onRoute });
  app.get("/api/bookings/:id", async () => ({}));
  app.head("/api/extra", async () => {});
  app.get("/frontend", async () => "not part of API");
  try {
    await app.ready();
    const spec = {
      paths: {
        "/api/health": { get: {} },
        "/api/meeting-types": { get: {}, post: {} },
        "/api/meeting-types/{id}": { get: {}, put: {}, delete: {} },
        "/api/bookings": { post: {} },
        "/api/events/upcoming": { get: {} },
        "/api/meeting-types/{id}/availability": { get: {} },
        "/api/meeting-types/{id}/slots": { get: {} },
        "/api/bookings/{id}": { get: {} },
        "/api/missing": { delete: {} },
        "/frontend": { get: {} },
        "/apiary": { get: {} },
      },
    };
    expect(compareRoutes(routes.entries, spec)).toEqual({
      undocumented: ["HEAD /api/extra"],
      unimplemented: ["DELETE /api/missing"],
    });
  } finally {
    await app.close();
  }
});

test("rejects a response that violates the OpenAPI schema", async () => {
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  expect(api.validateResponse({ status: "broken" }, "health", 200).errors).not.toBeNull();
});

test("health HTTP response conforms to the OpenAPI response schema", async () => {
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  const app = buildApp();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const validation = api.validateResponse(await response.json(), "health", response.status);
    expect(validation.errors).toBeNull();
  } finally {
    await app.close();
  }
});

test("meeting type success and validation responses conform to OpenAPI", async () => {
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  const app = buildApp();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const [method, payload, status, operation] of [
      ["GET", undefined, 200, "MeetingTypes_list"],
      [
        "POST",
        { name: "Call", description: "Intro", durationMinutes: 30 },
        201,
        "MeetingTypes_create",
      ],
      ["POST", { name: "", description: "Intro", durationMinutes: 30 }, 400, "MeetingTypes_create"],
    ] as const) {
      const response = await fetch(`${address}/api/meeting-types`, {
        method,
        ...(payload
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
          : {}),
      });
      expect(response.status).toBe(status);
      expect(api.validateResponse(await response.json(), operation, status).errors).toBeNull();
      if (status === 201) expect(response.headers.get("etag")).toBeDefined();
    }
  } finally {
    await app.close();
  }
});

test("database failures produce safe documented errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-contract-"));
  const path = join(directory, "test.sqlite");
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  const app = buildApp({ databasePath: path });
  const db = new Database(path);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    db.exec("BEGIN EXCLUSIVE");
    const busyList = await fetch(`${address}/api/meeting-types`);
    expect(busyList.status).toBe(503);
    expect(api.validateResponse(await busyList.json(), "MeetingTypes_list", 503).errors).toBeNull();
    const busy = await fetch(`${address}/api/meeting-types`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }),
    });
    expect(busy.status).toBe(503);
    expect(api.validateResponse(await busy.json(), "MeetingTypes_create", 503).errors).toBeNull();
    for (const [url, operation] of [
      ["/api/meeting-types/id/availability", "Availability_summary"],
      [
        "/api/meeting-types/id/slots?date=" + new Date().toISOString().slice(0, 10),
        "Availability_slots",
      ],
    ] as const) {
      const response = await fetch(`${address}${url}`);
      expect(response.status).toBe(503);
      expect(api.validateResponse(await response.json(), operation, 503).errors).toBeNull();
    }
    for (const [method, operation] of [
      ["GET", "MeetingTypeResource_read"],
      ["PUT", "MeetingTypeResource_update"],
      ["DELETE", "MeetingTypeResource_remove"],
    ] as const) {
      const response = await fetch(`${address}/api/meeting-types/id`, {
        method,
        headers: {
          "if-match": '"1"',
          ...(method === "PUT" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "PUT"
          ? { body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }) }
          : {}),
      });
      expect(response.status).toBe(503);
      expect(api.validateResponse(await response.json(), operation, 503).errors).toBeNull();
    }
    db.exec("ROLLBACK");
    db.exec("DROP TABLE meeting_types");
    for (const [method, operation] of [
      ["GET", "MeetingTypeResource_read"],
      ["PUT", "MeetingTypeResource_update"],
      ["DELETE", "MeetingTypeResource_remove"],
    ] as const) {
      const response = await fetch(`${address}/api/meeting-types/id`, {
        method,
        headers: {
          "if-match": '"1"',
          ...(method === "PUT" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "PUT"
          ? { body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }) }
          : {}),
      });
      expect(response.status).toBe(500);
      expect(api.validateResponse(await response.json(), operation, 500).errors).toBeNull();
    }

    for (const [url, operation] of [
      ["/api/meeting-types/id/availability", "Availability_summary"],
      [
        "/api/meeting-types/id/slots?date=" + new Date().toISOString().slice(0, 10),
        "Availability_slots",
      ],
    ] as const) {
      const response = await fetch(`${address}${url}`);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).not.toContain("meeting_types");
      expect(api.validateResponse(JSON.parse(body), operation, 500).errors).toBeNull();
    }
    for (const [method, operation] of [
      ["GET", "MeetingTypes_list"],
      ["POST", "MeetingTypes_create"],
    ] as const) {
      const response = await fetch(`${address}/api/meeting-types`, {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }),
            }
          : {}),
      });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).not.toContain("meeting_types");
      expect(api.validateResponse(JSON.parse(body), operation, 500).errors).toBeNull();
    }
  } finally {
    db.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("availability success and client errors conform to OpenAPI", async () => {
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  const app = buildApp({ now: () => Date.parse("2026-10-30T08:00:00Z") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await fetch(`${address}/api/meeting-types`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }),
    });
    const { id } = await created.json();
    for (const [url, status, operation] of [
      [`/api/meeting-types/${id}/availability`, 200, "Availability_summary"],
      [`/api/meeting-types/${id}/slots?date=2026-10-30`, 200, "Availability_slots"],
      [`/api/meeting-types/${id}/slots?date=2026-11-13`, 400, "Availability_slots"],
      ["/api/meeting-types/missing/availability", 404, "Availability_summary"],
      ["/api/meeting-types/missing/slots?date=2026-10-30", 404, "Availability_slots"],
    ] as const) {
      const response = await fetch(`${address}${url}`);
      expect(response.status).toBe(status);
      expect(api.validateResponse(await response.json(), operation, status).errors).toBeNull();
    }
  } finally {
    await app.close();
  }
});

test("booking responses and required no-store header match OpenAPI", async () => {
  const directory = mkdtempSync(join(tmpdir(), "booking-contract-"));
  const path = join(directory, "db.sqlite");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:00:00Z") });
  const db = new Database(path);
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const typeResponse = await fetch(`${address}/api/meeting-types`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }),
    });
    const type = await typeResponse.json();
    const payload = {
      meetingTypeId: type.id,
      meetingTypeVersion: 1,
      startsAt: "2026-10-30T09:00:00.000Z",
      guestName: "Guest",
      guestEmail: "g@example.com",
    };
    const send = (data: object, key: string) =>
      fetch(`${address}/api/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(data),
      });
    async function validate(response: Response, status: number, code?: string) {
      expect(response.status).toBe(status);
      const body = await response.text();
      const parsed = JSON.parse(body);
      expect(api.validateResponse(parsed, "createBooking", status).errors).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).not.toContain("secret-key");
      if (code) expect(parsed.code).toBe(code);
      return body;
    }
    await validate(await send({ ...payload, guestEmail: "bad" }, "bad"), 400);
    await validate(await send(payload, "secret-key"), 201);
    await validate(await send(payload, "different-key"), 409, "SLOT_UNAVAILABLE");
    await validate(
      await send({ ...payload, meetingTypeVersion: 2 }, "changed-type"),
      409,
      "MEETING_TYPE_CHANGED",
    );
    await validate(
      await send({ ...payload, guestName: "Another" }, "secret-key"),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    db.exec("BEGIN IMMEDIATE");
    await validate(await send({ ...payload, startsAt: "2026-10-30T10:00:00.000Z" }, "busy"), 503);
    db.exec("ROLLBACK");
    db.exec("DROP TABLE bookings");
    const failure = await send(payload, "error");
    expect(await validate(failure, 500)).not.toContain("bookings");
  } finally {
    db.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upcoming events responses conform to OpenAPI and avoid caching contacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "events-contract-"));
  const path = join(directory, "db.sqlite");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:00:00Z") });
  const db = new Database(path);
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const type = await (
      await fetch(`${address}/api/meeting-types`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Call", description: "Intro", durationMinutes: 30 }),
      })
    ).json();
    const booked = await fetch(`${address}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-key" },
      body: JSON.stringify({
        meetingTypeId: type.id,
        meetingTypeVersion: 1,
        startsAt: "2026-10-30T09:00:00Z",
        guestName: "Guest",
        guestEmail: "guest@example.com",
      }),
    });
    expect(booked.status).toBe(201);
    async function validate(status: number) {
      const response = await fetch(`${address}/api/events/upcoming`);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(api.validateResponse(body, "upcomingEvents", status).errors).toBeNull();
      return body;
    }
    expect(await validate(200)).toMatchObject([
      { guestName: "Guest", guestEmail: "guest@example.com" },
    ]);
    db.exec("BEGIN EXCLUSIVE");
    await validate(503);
    db.exec("ROLLBACK");
    db.exec("DROP TABLE bookings");
    const failure = await validate(500);
    expect(JSON.stringify(failure)).not.toContain("bookings");
  } finally {
    db.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("meeting type management responses conform to OpenAPI over HTTP", async () => {
  const api = new OpenAPIBackend({ definition, strict: true });
  await api.init();
  const app = buildApp();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const input = { name: "Call", description: "Intro", durationMinutes: 30 };
    const created = await fetch(`${address}/api/meeting-types`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const { id } = await created.json();
    const send = async (
      method: string,
      path: string,
      status: number,
      match?: string,
      body?: object,
    ) => {
      const response = await fetch(`${address}/api/meeting-types/${path}`, {
        method,
        headers: {
          ...(match ? { "if-match": match } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(status);
      const operation =
        method === "GET"
          ? "MeetingTypeResource_read"
          : method === "PUT"
            ? "MeetingTypeResource_update"
            : "MeetingTypeResource_remove";
      const data =
        status === 204 ? (expect(await response.text()).toBe(""), null) : await response.json();
      expect(api.validateResponse(data, operation, status).errors).toBeNull();
    };
    await send("GET", id, 200);
    await send("GET", "missing", 404);
    await send("PUT", id, 428, undefined, input);
    await send("PUT", id, 412, '"9"', input);
    await send("PUT", id, 400, '"1"', { ...input, name: "" });
    await send("PUT", "missing", 404, '"1"', input);
    await send("PUT", id, 200, '"1"', { ...input, name: "Changed" });
    await send("DELETE", id, 428);
    await send("DELETE", id, 412, '"1"');
    await send("DELETE", "missing", 404, '"2"');
    await send("DELETE", id, 204, '"2"');
  } finally {
    await app.close();
  }
});
