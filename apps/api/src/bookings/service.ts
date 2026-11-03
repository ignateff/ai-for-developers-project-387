import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Storage } from "../database/database.js";
import { bookings, meetingTypes } from "../database/schema.js";
import { calculateSlots, DAY, windowStart } from "../availability/slots.js";

export function createBooking(
  storage: Storage,
  input: {
    meetingTypeId: string;
    meetingTypeVersion: number;
    key: string;
    start: number;
    name: string;
    email: string;
  },
  { clock, onBookingLocked }: { clock?: () => number; onBookingLocked?: () => void },
) {
  const { key, start, name, email } = input;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const canonicalStart = new Date(start).toISOString();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([input.meetingTypeId, input.meetingTypeVersion, canonicalStart, name, email]),
    )
    .digest("hex");
  const typeId = input.meetingTypeId;
  const version = input.meetingTypeVersion;
  return storage.db.transaction(
    (tx) => {
      onBookingLocked?.();
      const existing = tx
        .select()
        .from(bookings)
        .where(eq(bookings.idempotencyKeyHash, keyHash))
        .get();
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) return { kind: "key_reused" as const };
        return { kind: "created" as const, booking: bookingResponse(existing) };
      }
      const type = tx.select().from(meetingTypes).where(eq(meetingTypes.id, typeId)).get();
      if (!type || type.deleted || type.version !== version)
        return { kind: "type_changed" as const };
      const now = (clock ?? Date.now)();
      const day = windowStart(start);
      const window = windowStart(now);
      const matchingSlot =
        day >= window &&
        day < window + 14 * DAY &&
        calculateSlots(day, type.durationMinutes, now, []).some(
          (slot) => slot.startsAt === canonicalStart,
        );
      const end = start + type.durationMinutes * 60_000;
      const overlap = tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(lt(bookings.startsAt, end), gt(bookings.endsAt, start)))
        .get();
      if (!matchingSlot || overlap) return { kind: "slot_unavailable" as const };
      const booking = {
        id: randomUUID(),
        meetingTypeId: type.id,
        meetingTypeName: type.name,
        meetingTypeDescription: type.description,
        meetingTypeDurationMinutes: type.durationMinutes,
        guestName: name,
        guestEmail: email,
        startsAt: start,
        endsAt: end,
        createdAt: now,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
      };
      tx.insert(bookings).values(booking).run();
      return { kind: "created" as const, booking: bookingResponse(booking) };
    },
    { behavior: "immediate" },
  );
}

function bookingResponse(booking: typeof bookings.$inferSelect) {
  return {
    id: booking.id,
    meetingTypeId: booking.meetingTypeId,
    meetingTypeName: booking.meetingTypeName,
    meetingTypeDescription: booking.meetingTypeDescription,
    meetingTypeDurationMinutes: booking.meetingTypeDurationMinutes,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    startsAt: new Date(booking.startsAt).toISOString(),
    endsAt: new Date(booking.endsAt).toISOString(),
    createdAt: new Date(booking.createdAt).toISOString(),
  };
}
