import { and, eq, gt, lt } from "drizzle-orm";
import type { Storage } from "../database/database.js";
import { bookings, meetingTypes } from "../database/schema.js";
import { calculateSlots, DAY } from "./slots.js";

function getSnapshot(storage: Storage, id: string, start: number) {
  return storage.db.transaction((tx) => {
    const type = tx
      .select()
      .from(meetingTypes)
      .where(and(eq(meetingTypes.id, id), eq(meetingTypes.deleted, false)))
      .get();
    if (!type) return null;
    const intervals = tx
      .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(and(lt(bookings.startsAt, start + 14 * DAY), gt(bookings.endsAt, start)))
      .all();
    return { type, intervals };
  });
}

export function getAvailability(storage: Storage, id: string, start: number, now: number) {
  const snapshot = getSnapshot(storage, id, start);
  if (!snapshot) return null;
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = start + i * DAY;
    return {
      date: new Date(day).toISOString().slice(0, 10),
      availableCount: calculateSlots(
        day,
        snapshot.type.durationMinutes,
        now,
        snapshot.intervals,
      ).filter((slot) => slot.available).length,
    };
  });
  return { version: snapshot.type.version, days };
}

export function getSlots(storage: Storage, id: string, start: number, day: number, now: number) {
  const snapshot = getSnapshot(storage, id, start);
  if (!snapshot) return null;
  return {
    version: snapshot.type.version,
    slots: calculateSlots(day, snapshot.type.durationMinutes, now, snapshot.intervals),
  };
}
