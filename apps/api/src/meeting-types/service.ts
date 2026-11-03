import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Storage } from "../database/database.js";
import { meetingTypes } from "../database/schema.js";
import type { validateMeetingType } from "./validation.js";

export function updateMeetingType(
  storage: Storage,
  id: string,
  match: string | undefined,
  { name, description, durationMinutes, fields }: ReturnType<typeof validateMeetingType>,
) {
  return storage.db.transaction(
    (tx) => {
      const type = tx
        .select()
        .from(meetingTypes)
        .where(and(eq(meetingTypes.id, id), eq(meetingTypes.deleted, false)))
        .get();
      if (!type) return { kind: "not_found" as const };
      if (!match) return { kind: "version_required" as const };
      if (match !== `"${type.version}"`) return { kind: "version_changed" as const };
      if (Object.keys(fields).length || typeof durationMinutes !== "number")
        return { kind: "invalid" as const };
      const version =
        type.version +
        Number(
          name !== type.name ||
            description !== type.description ||
            durationMinutes !== type.durationMinutes,
        );
      tx.update(meetingTypes)
        .set({ name, description, durationMinutes, version })
        .where(eq(meetingTypes.id, type.id))
        .run();
      return {
        kind: "updated" as const,
        type: { id: type.id, name, description, durationMinutes, version },
      };
    },
    { behavior: "immediate" },
  );
}

export function deleteMeetingType(storage: Storage, id: string, match: string | undefined) {
  return storage.db.transaction(
    (tx) => {
      const type = tx
        .select()
        .from(meetingTypes)
        .where(and(eq(meetingTypes.id, id), eq(meetingTypes.deleted, false)))
        .get();
      if (!type) return "not_found" as const;
      if (!match) return "version_required" as const;
      if (match !== `"${type.version}"`) return "version_changed" as const;
      tx.update(meetingTypes).set({ deleted: true }).where(eq(meetingTypes.id, type.id)).run();
      return "deleted" as const;
    },
    { behavior: "immediate" },
  );
}

export function listMeetingTypes(storage: Storage) {
  return storage.db
    .select({
      id: meetingTypes.id,
      name: meetingTypes.name,
      description: meetingTypes.description,
      durationMinutes: meetingTypes.durationMinutes,
      version: meetingTypes.version,
    })
    .from(meetingTypes)
    .where(eq(meetingTypes.deleted, false))
    .all();
}

export function createMeetingType(
  storage: Storage,
  input: { name: string; description: string; durationMinutes: number },
) {
  const result = { id: randomUUID(), ...input, version: 1 };
  storage.db
    .insert(meetingTypes)
    .values({ ...result, createdAt: Date.now(), deleted: false })
    .run();
  return result;
}

export function getMeetingType(storage: Storage, id: string) {
  return storage.db
    .select()
    .from(meetingTypes)
    .where(and(eq(meetingTypes.id, id), eq(meetingTypes.deleted, false)))
    .get();
}
