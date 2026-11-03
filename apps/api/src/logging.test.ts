import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { buildApp } from "./app.js";

it("logs unexpected booking errors with safe request context only", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const app = buildApp({
    logStream: stream,
    now: () => Date.parse("2026-10-30T08:00:00Z"),
    onBookingLocked: () => {
      throw new Error("secret-error alice@example.com", { cause: new Error("secret-cause") });
    },
  });
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Call", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/bookings?private=secret-query",
      headers: {
        "idempotency-key": "secret-attempt",
        authorization: "secret-token",
        "x-request-id": "secret-request-id",
      },
      payload: {
        meetingTypeId: type.id,
        meetingTypeVersion: 1,
        startsAt: "2026-10-30T09:00:00.000Z",
        guestName: "secret-name",
        guestEmail: "alice@example.com",
      },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Не удалось выполнить запрос",
    });
    await app.inject({ method: "GET", url: "/api/secret-url-path?secret-url-query=1" });
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 50,
        method: "POST",
        route: "/api/bookings",
        statusCode: 500,
        errorCategory: "unknown",
        reqId: expect.any(String),
      }),
    );
    for (const secret of [
      "secret-query",
      "secret-attempt",
      "secret-token",
      "secret-request-id",
      "secret-name",
      "alice@example.com",
      "secret-error",
      "secret-cause",
      "secret-url-path",
      "secret-url-query",
    ])
      expect(output).not.toContain(secret);
  } finally {
    await app.close();
  }
});

it("reports database startup failures without leaking the database path", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./server.ts", import.meta.url))],
    {
      env: { ...process.env, DATABASE_PATH: "/missing-secret-directory/calendar.sqlite" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  expect(code).toBe(1);
  expect(output).not.toContain("missing-secret-directory");
  expect(
    output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toContainEqual(
    expect.objectContaining({
      level: 50,
      event: "startup_failed",
      stage: "database_open",
      errorCategory: "database_open_failed",
    }),
  );
});

it("classifies an unexpected database error without logging its details", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const app = buildApp({
    logStream: stream,
    now: () => Date.parse("2026-10-30T08:00:00Z"),
    onBookingLocked: () => {
      throw Object.assign(new Error("secret details"), { code: "SQLITE_IOERR" });
    },
  });
  try {
    const type = (
      await app.inject({
        method: "POST",
        url: "/api/meeting-types",
        payload: { name: "Call", description: "Intro", durationMinutes: 30 },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/bookings",
      headers: { "idempotency-key": "secret-key" },
      payload: {
        meetingTypeId: type.id,
        meetingTypeVersion: 1,
        startsAt: "2026-10-30T09:00:00.000Z",
        guestName: "Secret",
        guestEmail: "secret@example.com",
      },
    });
    expect(response.statusCode).toBe(500);
    expect(output).toContain('"errorCategory":"database_io"');
    expect(output).not.toContain("secret");
  } finally {
    await app.close();
  }
});

async function startupFailure(env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./server.ts", import.meta.url))],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  expect(code).toBe(1);
  return output;
}

it("distinguishes migration failure without exposing its path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "secret-migration-"));
  try {
    const path = join(directory, "calendar.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE meeting_types (id TEXT)");
    db.close();
    const output = await startupFailure({ DATABASE_PATH: path });
    expect(output).not.toContain("secret-migration");
    expect(JSON.parse(output.trim())).toMatchObject({
      stage: "database_migration",
      errorCategory: "database_migration_failed",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("classifies listen failures without exposing host or database path", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const output = await startupFailure({
      DATABASE_PATH: ":memory:",
      HOST: "127.0.0.1",
      PORT: String(address.port),
    });
    expect(output).not.toContain("127.0.0.1");
    expect(output).not.toContain(String(address.port));
    expect(JSON.parse(output.trim())).toMatchObject({
      stage: "listen",
      errorCategory: "address_in_use",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
