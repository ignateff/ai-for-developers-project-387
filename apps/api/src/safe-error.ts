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
