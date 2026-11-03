import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { buildApp } from "../app.js";

it("returns only future bookings in chronological order with the original type and contacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-events-"));
  const path = join(directory, "test.sqlite");
  const now = Date.parse("2026-10-30T10:00:00Z");
  const app = buildApp({ databasePath: path, now: () => now });
  const db = new Database(path);
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Current", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    const secondType = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Second", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    const insert = db.prepare(
      "INSERT INTO bookings (id, meeting_type_id, meeting_type_name, meeting_type_description, meeting_type_duration_minutes, guest_name, guest_email, starts_at, ends_at, created_at, idempotency_key_hash, request_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const [id, start] of [
      ["later", now + 120000],
      ["equal", now],
      ["past", now - 1],
      ["soon", now + 1],
    ] as const)
      insert.run(
        id,
        id === "later" ? secondType.id : type.id,
        id === "later" ? "Second" : "Original",
        "Before edit",
        30,
        `Guest ${id}`,
        `${id}@example.com`,
        start,
        start + 1800000,
        now - 1000,
        `key-${id}`,
        `fp-${id}`,
      );
    db.prepare("UPDATE meeting_types SET name = ?, deleted = 1 WHERE id = ?").run(
      "Changed",
      type.id,
    );
    const response = await app.inject({ method: "GET", url: "/api/events/upcoming" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual([
      {
        id: "soon",
        meetingTypeName: "Original",
        startsAt: "2026-10-30T10:00:00.001Z",
        endsAt: "2026-10-30T10:30:00.001Z",
        guestName: "Guest soon",
        guestEmail: "soon@example.com",
      },
      {
        id: "later",
        meetingTypeName: "Second",
        startsAt: "2026-10-30T10:02:00.000Z",
        endsAt: "2026-10-30T10:32:00.000Z",
        guestName: "Guest later",
        guestEmail: "later@example.com",
      },
    ]);
  } finally {
    db.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
