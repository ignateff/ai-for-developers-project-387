import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { DatabaseStartupError } from "../safe-error.js";

export function openDatabase(path: string) {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { timeout: 250 });
  } catch (error) {
    throw new DatabaseStartupError("database_open", error);
  }
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    return { db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw new DatabaseStartupError("database_migration", error);
  }
}

export type Storage = ReturnType<typeof openDatabase>;
