import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildApp } from "../app.js";

async function httpRequest(
  address: string,
  request: { method: string; url: string; payload?: object },
) {
  const response = await fetch(`${address}${request.url}`, {
    method: request.method,
    ...(request.payload
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(request.payload) }
      : {}),
  });
  const body = await response.json();
  return { statusCode: response.status, json: () => body };
}

it("returns a 14-day UTC window and only future whole slots", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T10:00:00.000Z") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await httpRequest(address, {
      method: "POST",
      url: "/api/meeting-types",
      payload: { name: "Call", description: "Intro", durationMinutes: 60 },
    });
    const id = created.json().id;
    const summary = await httpRequest(address, {
      method: "GET",
      url: `/api/meeting-types/${id}/availability`,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().days).toHaveLength(14);
    expect(summary.json().days.slice(0, 3)).toEqual([
      { date: "2026-10-30", availableCount: 7 },
      { date: "2026-10-31", availableCount: 0 },
      { date: "2026-11-01", availableCount: 0 },
    ]);
    expect(summary.json().days[13].date).toBe("2026-11-12");
    const slots = await httpRequest(address, {
      method: "GET",
      url: `/api/meeting-types/${id}/slots?date=2026-10-30`,
    });
    expect(slots.json().slots[0]).toEqual({
      startsAt: "2026-10-30T11:00:00.000Z",
      endsAt: "2026-10-30T12:00:00.000Z",
      available: true,
    });
    expect(slots.json().slots.at(-1).endsAt).toBe("2026-10-30T18:00:00.000Z");
  } finally {
    await app.close();
  }
});

it("reports errors for invalid and out-of-window dates and missing types", async () => {
  const app = buildApp({ now: () => Date.parse("2026-10-30T23:59:59Z") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await httpRequest(address, {
      method: "POST",
      url: "/api/meeting-types",
      payload: { name: "Call", description: "Intro", durationMinutes: 30 },
    });
    const id = created.json().id;
    for (const date of ["2026-10-29", "2026-11-13"]) {
      const response = await httpRequest(address, {
        method: "GET",
        url: `/api/meeting-types/${id}/slots?date=${date}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("DATE_OUT_OF_RANGE");
    }
    for (const date of ["2026-02-30", "invalid", ""]) {
      const response = await httpRequest(address, {
        method: "GET",
        url: `/api/meeting-types/${id}/slots?date=${date}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_DATE");
    }
    for (const path of ["availability", "slots?date=2026-10-30"])
      expect(
        (await httpRequest(address, { method: "GET", url: `/api/meeting-types/missing/${path}` }))
          .statusCode,
      ).toBe(404);
    expect(
      (
        await httpRequest(address, {
          method: "GET",
          url: `/api/meeting-types/${id}/slots?date=2026-11-12`,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});

it("marks partial overlaps across types occupied while allowing adjacent slots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "calendar-slots-"));
  const path = join(dir, "db.sqlite");
  const app = buildApp({ databasePath: path, now: () => Date.parse("2026-10-30T08:59:59Z") });
  const db = new Database(path);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const create = async (name: string, durationMinutes: number) =>
      (
        await httpRequest(address, {
          method: "POST",
          url: "/api/meeting-types",
          payload: { name, description: "Description", durationMinutes },
        })
      ).json().id;
    const first = await create("First", 60);
    const second = await create("Second", 30);
    db.prepare(
      "INSERT INTO bookings (id, meeting_type_id, meeting_type_name, meeting_type_description, meeting_type_duration_minutes, guest_name, guest_email, starts_at, ends_at, created_at, idempotency_key_hash, request_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "booking-1",
      second,
      "Second",
      "Description",
      30,
      "Guest",
      "g@example.com",
      Date.parse("2026-10-30T10:00:00Z"),
      Date.parse("2026-10-30T11:30:00Z"),
      1,
      "hash",
      "fingerprint",
    );
    const response = await httpRequest(address, {
      method: "GET",
      url: `/api/meeting-types/${first}/slots?date=2026-10-30`,
    });
    expect(
      response
        .json()
        .slots.slice(0, 4)
        .map((slot: { available: boolean }) => slot.available),
    ).toEqual([true, false, false, true]);
    const summary = await httpRequest(address, {
      method: "GET",
      url: `/api/meeting-types/${first}/availability`,
    });
    expect(summary.json().days[0].availableCount).toBe(7);
    const long = await create("Long", 541);
    expect(
      (
        await httpRequest(address, {
          method: "GET",
          url: `/api/meeting-types/${long}/slots?date=2026-10-30`,
        })
      ).json().slots,
    ).toEqual([]);
    const wholeDay = await create("Whole day", 540);
    expect(
      (
        await httpRequest(address, {
          method: "GET",
          url: `/api/meeting-types/${wholeDay}/slots?date=2026-10-30`,
        })
      ).json().slots,
    ).toHaveLength(1);
    db.prepare("UPDATE meeting_types SET deleted = 1 WHERE id = ?").run(first);
    expect(
      (
        await httpRequest(address, {
          method: "GET",
          url: `/api/meeting-types/${first}/availability`,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    db.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
