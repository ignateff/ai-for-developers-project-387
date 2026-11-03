import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { meetingTypes } from "./schema.js";

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
