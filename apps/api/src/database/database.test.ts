import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { bookings, meetingTypes } from "./schema.js";

it("applies migrations and preserves meeting types after reopening the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-db-"));
  const path = join(directory, "calendar.sqlite");
  try {
    const first = openDatabase(path);
    first.db
      .insert(meetingTypes)
      .values({
        id: "type-1",
        name: "Call",
        description: "Intro",
        durationMinutes: 30,
        version: 1,
        createdAt: 1000,
        deleted: false,
      })
      .run();
    first.close();
    const second = openDatabase(path);
    expect(second.db.select().from(meetingTypes).all()).toMatchObject([
      { id: "type-1", name: "Call", durationMinutes: 30 },
    ]);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("adds the nullable topic column to existing bookings without backfilling or losing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-db-migration-"));
  const path = join(directory, "calendar.sqlite");
  try {
    const legacyMigration = readFileSync(
      new URL("../../drizzle/0000_long_omega_red.sql", import.meta.url),
      "utf8",
    );
    const db = new Database(path);
    for (const statement of legacyMigration.split("--> statement-breakpoint"))
      if (statement.trim()) db.exec(statement);
    db.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    db.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)').run(
      createHash("sha256").update(legacyMigration).digest("hex"),
      1793446895775,
    );
    db.prepare(
      "INSERT INTO meeting_types (id, name, description, duration_minutes, version, created_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("type-1", "Call", "Intro", 30, 1, 1000, 0);
    db.prepare(
      "INSERT INTO bookings (id, meeting_type_id, meeting_type_name, meeting_type_description, meeting_type_duration_minutes, guest_name, guest_email, starts_at, ends_at, created_at, idempotency_key_hash, request_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "booking-1",
      "type-1",
      "Call",
      "Intro",
      30,
      "Alice",
      "alice@example.com",
      2000,
      3_800_000,
      1000,
      "key-hash",
      "fingerprint",
    );
    expect(
      (db.prepare("PRAGMA table_info(bookings)").all() as { name: string }[]).some(
        (column) => column.name === "topic",
      ),
    ).toBe(false);
    db.close();

    const storage = openDatabase(path);
    try {
      expect(storage.db.select().from(bookings).all()).toMatchObject([
        {
          id: "booking-1",
          meetingTypeName: "Call",
          guestName: "Alice",
          guestEmail: "alice@example.com",
          topic: null,
        },
      ]);
    } finally {
      storage.close();
    }

    const migrated = new Database(path);
    try {
      const columns = migrated.prepare("PRAGMA table_info(bookings)").all() as {
        name: string;
        dflt_value: string | null;
      }[];
      expect(columns.find((column) => column.name === "topic")).toMatchObject({
        dflt_value: null,
      });
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM bookings").get()).toEqual({
        count: 1,
      });
      expect(migrated.prepare("SELECT topic FROM bookings WHERE id = ?").get("booking-1")).toEqual({
        topic: null,
      });
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
