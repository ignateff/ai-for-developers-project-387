import { asc, gt } from "drizzle-orm";
import type { Storage } from "../database/database.js";
import { bookings } from "../database/schema.js";

export function listUpcomingEvents(storage: Storage, now: number) {
  return storage.db
    .select({
      id: bookings.id,
      meetingTypeName: bookings.meetingTypeName,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      guestName: bookings.guestName,
      guestEmail: bookings.guestEmail,
    })
    .from(bookings)
    .where(gt(bookings.startsAt, now))
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .all()
    .map((event) => ({
      ...event,
      startsAt: new Date(event.startsAt).toISOString(),
      endsAt: new Date(event.endsAt).toISOString(),
    }));
}
