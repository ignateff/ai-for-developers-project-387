export function errorCategory(error: unknown): string {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if ("code" in error) {
      switch (error.code) {
        case "SQLITE_IOERR":
          return "database_io";
        case "SQLITE_FULL":
          return "database_full";
        case "SQLITE_CORRUPT":
          return "database_corrupt";
        case "EADDRINUSE":
          return "address_in_use";
        case "EACCES":
          return "permission_denied";
      }
    }
    error = error.cause;
  }
  return "unknown";
}

export class DatabaseStartupError extends Error {
  constructor(
    readonly stage: "database_open" | "database_migration",
    cause: unknown,
  ) {
    super("Database startup failed", { cause });
  }
}

/** True when the failure comes from SQLite lock contention anywhere in the cause chain. */
export function isDatabaseBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (
      "code" in error &&
      typeof error.code === "string" &&
      (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))
    )
      return true;
    error = error.cause;
  }
  return false;
}
