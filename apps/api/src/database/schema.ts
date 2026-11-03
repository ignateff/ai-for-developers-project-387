import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const meetingTypes = sqliteTable(
  "meeting_types",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    version: integer().notNull(),
    createdAt: integer("created_at").notNull(),
    deleted: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    check(
      "meeting_type_duration_positive",
      sql`typeof(${table.durationMinutes}) = 'integer' and ${table.durationMinutes} between 1 and 2147483647`,
    ),
  ],
);

export const bookings = sqliteTable(
  "bookings",
  {
    id: text().primaryKey().notNull(),
    meetingTypeId: text("meeting_type_id")
      .notNull()
      .references(() => meetingTypes.id),
    meetingTypeName: text("meeting_type_name").notNull(),
    meetingTypeDescription: text("meeting_type_description").notNull(),
    meetingTypeDurationMinutes: integer("meeting_type_duration_minutes").notNull(),
    guestName: text("guest_name").notNull(),
    guestEmail: text("guest_email").notNull(),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    createdAt: integer("created_at").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
  },
  (table) => [
    check(
      "booking_duration_positive",
      sql`typeof(${table.meetingTypeDurationMinutes}) = 'integer' and ${table.meetingTypeDurationMinutes} between 1 and 2147483647`,
    ),
    check("booking_end_after_start", sql`${table.endsAt} > ${table.startsAt}`),
    index("bookings_starts_at_idx").on(table.startsAt),
    uniqueIndex("bookings_idempotency_key_hash_idx").on(table.idempotencyKeyHash),
  ],
);
