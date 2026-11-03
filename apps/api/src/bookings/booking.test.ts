import { expect, it } from "vitest";
import { buildApp } from "../app.js";

it("creates a booking and safely replays normalized input", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T08:00:00Z") });
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Call", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    const payload = {
      meetingTypeId: type.id,
      meetingTypeVersion: 1,
      startsAt: "2026-10-30T09:00:00.000Z",
      guestName: " Alice ",
      guestEmail: " a@example.com ",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/bookings",
      headers: { "idempotency-key": "attempt-1" },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json()).toMatchObject({
      meetingTypeName: "Call",
      guestName: "Alice",
      guestEmail: "a@example.com",
      startsAt: "2026-10-30T09:00:00.000Z",
      endsAt: "2026-10-30T09:30:00.000Z",
    });
    const retry = await app.inject({
      method: "POST",
      url: "/api/bookings",
      headers: { "idempotency-key": "attempt-1" },
      payload: { ...payload, guestName: "Alice", guestEmail: "a@example.com" },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
  } finally {
    await app.close();
  }
});

it("rejects invalid contacts, invalid slots and reuse with changed data", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T08:00:00Z") });
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Call", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    const payload = {
      meetingTypeId: type.id,
      meetingTypeVersion: 1,
      startsAt: "2026-10-30T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    const send = (data: object, key = "key") =>
      app.inject({
        method: "POST",
        url: "/api/bookings",
        headers: { "idempotency-key": key },
        payload: data,
      });
    const invalid = await send({
      ...payload,
      guestName: " ",
      guestEmail: "wrong",
      startsAt: "2026-02-30T09:00:00Z",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().fields).toHaveProperty("guestName");
    expect(invalid.json().fields).toHaveProperty("guestEmail");
    expect(invalid.json().fields).toHaveProperty("startsAt");
    expect((await app.inject({ method: "POST", url: "/api/bookings", payload })).statusCode).toBe(
      400,
    );
    expect((await send({ ...payload, startsAt: "2026-10-30T09:15:00.000Z" })).json().code).toBe(
      "SLOT_UNAVAILABLE",
    );
    expect((await send({ ...payload, startsAt: "2026-10-31T09:00:00.000Z" })).json().code).toBe(
      "SLOT_UNAVAILABLE",
    );
    expect((await send({ ...payload, meetingTypeVersion: 2 })).json().code).toBe(
      "MEETING_TYPE_CHANGED",
    );
    expect((await send(payload)).statusCode).toBe(201);
    expect((await send({ ...payload, guestName: "Bob" })).json().code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect((await send(payload, "another-key")).json().code).toBe("SLOT_UNAVAILABLE");
    expect(
      (await send({ ...payload, startsAt: "2026-10-30T09:30:00.000Z" }, "adjacent-key")).statusCode,
    ).toBe(201);
  } finally {
    await app.close();
  }
});

it("serializes competing requests on independent SQLite connections and permits safe replay", async () => {
  const { fork } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "calendar-race-"));
  const path = join(directory, "db.sqlite");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:00:00Z") });
  const workers: import("node:child_process").ChildProcess[] = [];
  try {
    const makeType = async (name: string, durationMinutes: number) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/meeting-types",
          payload: { name, description: "Intro", durationMinutes },
        })
      ).json();
    const a = await makeType("A", 60),
      b = await makeType("B", 30);
    for (let i = 0; i < 2; i++) {
      const child = fork(
        "apps/api/test-support/booking-worker.ts",
        i === 0 ? [path, join(directory, "release")] : [path],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      workers.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
      });
    }
    const payload = (id: string, startsAt: string) => ({
      meetingTypeId: id,
      meetingTypeVersion: 1,
      startsAt,
      guestName: "Guest",
      guestEmail: "g@example.com",
    });
    const race = async (requests: { payload: object; key: string }[]) =>
      Promise.all(
        workers.map(
          (worker, index) =>
            new Promise<{ status: number; body: { code?: string; id?: string } }>((resolve) => {
              worker.once("message", (message) =>
                resolve(message as { status: number; body: { code?: string; id?: string } }),
              );
              worker.send(requests[index]);
            }),
        ),
      );
    const locked = new Promise<void>((resolve) => workers[0].once("message", () => resolve()));
    workers[0].send({ payload: payload(a.id, "2026-10-30T09:00:00.000Z"), key: "race-a" });
    await locked;
    const competing = new Promise<{ status: number }>((resolve) =>
      workers[1].once("message", (message) => resolve(message as { status: number })),
    );
    workers[1].send({ payload: payload(b.id, "2026-10-30T09:30:00.000Z"), key: "race-b" });
    expect((await competing).status).toBe(503);
    const first = new Promise<{ status: number }>((resolve) =>
      workers[0].once("message", (message) => resolve(message as { status: number })),
    );
    writeFileSync(join(directory, "release"), "release");
    expect((await first).status).toBe(201);
    const retry = new Promise<{ status: number; body: { code: string } }>((resolve) =>
      workers[1].once("message", (message) =>
        resolve(message as { status: number; body: { code: string } }),
      ),
    );
    workers[1].send({ payload: payload(b.id, "2026-10-30T09:30:00.000Z"), key: "race-b" });
    expect(await retry).toMatchObject({ status: 409, body: { code: "SLOT_UNAVAILABLE" } });
    const same = payload(a.id, "2026-10-30T11:00:00.000Z");
    const repeated = await race([
      { payload: same, key: "same-key" },
      { payload: same, key: "same-key" },
    ]);
    const success = repeated.find((response) => response.status === 201);
    expect(success).toBeDefined();
    for (const response of repeated) {
      if (response.status === 503) {
        expect(response.body.code).toBe("DATABASE_BUSY");
      } else {
        expect(response.status).toBe(201);
        expect(response.body).toEqual(success?.body);
      }
    }
    for (const worker of workers) {
      const replayResponse = new Promise<{ status: number; body: object }>((resolve) =>
        worker.once("message", (message) => resolve(message as { status: number; body: object })),
      );
      worker.send({ payload: same, key: "same-key" });
      const replay = await replayResponse;
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(success?.body);
    }
  } finally {
    workers.forEach((worker) => worker.kill());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("replays the same attempt after a concurrent SQLite lock", async () => {
  const { fork } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "calendar-same-race-"));
  const path = join(directory, "db.sqlite");
  const release = join(directory, "release");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:00:00Z") });
  const workers: import("node:child_process").ChildProcess[] = [];
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Call", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    for (let i = 0; i < 2; i++) {
      const worker = fork(
        "apps/api/test-support/booking-worker.ts",
        i === 0 ? [path, release] : [path],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      workers.push(worker);
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve());
        worker.once("error", reject);
      });
    }
    const request = {
      key: "same-key",
      payload: {
        meetingTypeId: type.id,
        meetingTypeVersion: 1,
        startsAt: "2026-10-30T11:00:00.000Z",
        guestName: "Guest",
        guestEmail: "g@example.com",
      },
    };
    const receive = (index: number) =>
      new Promise<{ status: number; body: { id?: string } }>((resolve) =>
        workers[index].once("message", (message) =>
          resolve(message as { status: number; body: { id?: string } }),
        ),
      );
    const locked = receive(0);
    workers[0].send(request);
    await locked;
    const competing = receive(1);
    workers[1].send(request);
    const second = await competing;
    const firstResponse = receive(0);
    writeFileSync(release, "release");
    const first = await firstResponse;
    expect(second).toMatchObject({ status: 503, body: { code: "DATABASE_BUSY" } });
    expect(first.status).toBe(201);
    const replayResponse = receive(1);
    workers[1].send(request);
    const replay = await replayResponse;
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const events = (await app.inject({ method: "GET", url: "/api/events/upcoming" })).json();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(first.body.id);
  } finally {
    workers.forEach((worker) => worker.kill());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("replays the original snapshot even after the type is deleted and the slot has passed", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: Database } = await import("better-sqlite3");
  const directory = mkdtempSync(join(tmpdir(), "calendar-replay-"));
  const path = join(directory, "db.sqlite");
  let now = Date.parse("2026-10-30T08:00:00Z");
  const app = buildApp({ databasePath: path, now: () => now });
  const db = new Database(path);
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Original", description: "Original description", durationMinutes: 30 },
      })
    ).json();
    const payload = {
      meetingTypeId: type.id,
      meetingTypeVersion: 1,
      startsAt: "2026-10-30T09:00:00Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    const send = (key: string) =>
      app.inject({
        method: "POST",
        url: "/api/bookings",
        headers: { "idempotency-key": key },
        payload,
      });
    const first = await send("same-key");
    expect(first.statusCode).toBe(201);
    db.prepare("UPDATE meeting_types SET name = ?, version = 2, deleted = 1 WHERE id = ?").run(
      "Changed",
      type.id,
    );
    now = Date.parse("2026-10-31T12:00:00Z");
    const replay = await send("same-key");
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect((await send("new-key")).json().code).toBe("MEETING_TYPE_CHANGED");
  } finally {
    db.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("safely retries when the request or its successful response is lost", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: Database } = await import("better-sqlite3");
  const dir = mkdtempSync(join(tmpdir(), "calendar-lost-"));
  const path = join(dir, "db.sqlite");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:00:00Z") });
  const db = new Database(path);
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
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    const send = (input = payload) =>
      fetch(`${address}/api/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "lost-response-key" },
        body: JSON.stringify(input),
      });
    // A request that never reaches the server leaves no row; retry creates it.
    expect(db.prepare("select count(*) as count from bookings").get()).toEqual({ count: 0 });
    const first = await send();
    expect(first.status).toBe(201);
    const expected = await first.json(); // Simulates the persisted result whose response is lost.
    const retry = await send();
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(expected);
    const mismatch = await send({ ...payload, guestName: "Bob" });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(db.prepare("select count(*) as count from bookings").get()).toEqual({ count: 1 });
  } finally {
    db.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects email addresses containing consecutive dots", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T08:00:00Z") });
  try {
    for (const guestEmail of ["a..b@example.com", "a@example..com"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bookings",
        headers: { "idempotency-key": "key" },
        payload: {
          meetingTypeId: "id",
          meetingTypeVersion: 1,
          startsAt: "2026-10-30T09:00:00Z",
          guestName: "Guest",
          guestEmail,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().fields).toHaveProperty("guestEmail");
    }
  } finally {
    await app.close();
  }
});
