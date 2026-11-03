import { expect, it } from "vitest";
import { buildApp } from "../app.js";

it("conditionally updates and deletes a type while preserving booking snapshots", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T08:00:00Z") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const payload = { name: "Original", description: "Description", durationMinutes: 30 };
    const send = (path: string, method = "GET", data?: object, match?: string) =>
      fetch(`${address}${path}`, {
        method,
        headers: {
          ...(data ? { "content-type": "application/json" } : {}),
          ...(match ? { "if-match": match } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    const created = await send("/api/meeting-types", "POST", payload);
    const type = await created.json();
    const path = `/api/meeting-types/${type.id}`;
    const fetched = await send(path);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("etag")).toBe('"1"');
    expect((await send(path, "PUT", payload)).status).toBe(428);
    expect((await send(path, "PUT", payload, '"2"')).status).toBe(412);
    const unchanged = await send(path, "PUT", { ...payload, name: " Original " }, '"1"');
    expect(unchanged.headers.get("etag")).toBe('"1"');
    const changed = await send(path, "PUT", { ...payload, name: "Updated" }, '"1"');
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).toBe('"2"');
    expect((await changed.json()).name).toBe("Updated");
    expect((await send(path, "DELETE")).status).toBe(428);
    expect((await send(path, "DELETE", undefined, '"1"')).status).toBe(412);
    expect((await send(path, "DELETE", undefined, '"2"')).status).toBe(204);
    expect((await send(path)).status).toBe(404);
    expect(await (await send("/api/meeting-types")).json()).toEqual([]);
    expect((await send(path, "PUT", payload, '"2"')).status).toBe(404);
  } finally {
    await app.close();
  }
});

it("preserves booked snapshots and rejects stale type selections after update or deletion", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T08:00:00Z") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const post = (path: string, body: object, key?: string) =>
      fetch(`${address}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(body),
      });
    const type = await (
      await post("/api/meeting-types", {
        name: "Original",
        description: "Intro",
        durationMinutes: 30,
      })
    ).json();
    const booking = {
      meetingTypeId: type.id,
      meetingTypeVersion: 1,
      startsAt: "2026-10-30T09:00:00Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    const first = await post("/api/bookings", booking, "same");
    expect(first.status).toBe(201);
    const snapshot = await first.json();
    const updated = await fetch(`${address}/api/meeting-types/${type.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": '"1"' },
      body: JSON.stringify({ name: "Changed", description: "New", durationMinutes: 60 }),
    });
    expect(updated.status).toBe(200);
    expect(await (await post("/api/bookings", booking, "same")).json()).toEqual(snapshot);
    const stale = await post(
      "/api/bookings",
      { ...booking, startsAt: "2026-10-30T10:00:00Z" },
      "new",
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("MEETING_TYPE_CHANGED");
    expect(
      (
        await fetch(`${address}/api/meeting-types/${type.id}`, {
          method: "DELETE",
          headers: { "if-match": '"2"' },
        })
      ).status,
    ).toBe(204);
    expect(await (await post("/api/bookings", booking, "same")).json()).toEqual(snapshot);
    const deleted = await post(
      "/api/bookings",
      { ...booking, meetingTypeVersion: 2, startsAt: "2026-10-30T10:00:00Z" },
      "third",
    );
    expect(deleted.status).toBe(409);
    expect((await deleted.json()).code).toBe("MEETING_TYPE_CHANGED");
  } finally {
    await app.close();
  }
});

it("serializes type update against a booking transaction on independent SQLite connections", async () => {
  const { fork } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "calendar-type-race-"));
  const path = join(directory, "db.sqlite"),
    marker = join(directory, "release");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:00:00Z") });
  const child = fork("apps/api/test-support/booking-worker.ts", [path, marker], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const input = { name: "Original", description: "Intro", durationMinutes: 30 };
    const type = await (
      await fetch(`${address}/api/meeting-types`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    ).json();
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    const locked = new Promise<void>((resolve) => child.once("message", () => resolve()));
    child.send({
      payload: {
        meetingTypeId: type.id,
        meetingTypeVersion: 1,
        startsAt: "2026-10-30T09:00:00Z",
        guestName: "Alice",
        guestEmail: "a@example.com",
      },
      key: "race",
    });
    await locked;
    const update = () =>
      fetch(`${address}/api/meeting-types/${type.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": '"1"' },
        body: JSON.stringify({ ...input, name: "Changed" }),
      });
    expect((await update()).status).toBe(503);
    const completed = new Promise<{ status: number }>((resolve) =>
      child.once("message", (message) => resolve(message as { status: number })),
    );
    writeFileSync(marker, "release");
    expect((await completed).status).toBe(201);
    expect((await update()).status).toBe(200);
    const stale = await fetch(`${address}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "after" },
      body: JSON.stringify({
        meetingTypeId: type.id,
        meetingTypeVersion: 1,
        startsAt: "2026-10-30T10:00:00Z",
        guestName: "Alice",
        guestEmail: "a@example.com",
      }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("MEETING_TYPE_CHANGED");
  } finally {
    child.kill();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
