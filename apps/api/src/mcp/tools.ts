import { createHash } from "node:crypto";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getAvailability, getSlots } from "../availability/service.js";
import { DAY, parseDate, windowStart } from "../availability/slots.js";
import { createBooking } from "../bookings/service.js";
import { parseGuestFields } from "../bookings/validation.js";
import type { Storage } from "../database/database.js";
import { listMeetingTypes } from "../meeting-types/service.js";
import { isDatabaseBusy } from "../safe-error.js";

type Deps = { storage: Storage; now?: () => number };

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(code: string, hint: string, details?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ code, hint, details }) }],
    isError: true,
  };
}

/** Maps database contention to a retryable tool error instead of a protocol failure. */
async function runTool(
  run: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (!isDatabaseBusy(error)) throw error;
    return toolError("DATABASE_BUSY", "The calendar is busy. Retry the same call.");
  }
}

function summarize(type: {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
}) {
  return {
    id: type.id,
    name: type.name,
    description: type.description,
    durationMinutes: type.durationMinutes,
  };
}

export function registerAvailabilityTool(server: McpServer, { storage, now: clock }: Deps) {
  server.registerTool(
    "get_availability",
    {
      description:
        "List upcoming availability for every meeting type. Without a date it returns the next 14 days in UTC with free slot counts; with a date (YYYY-MM-DD) it returns that UTC day's slots for each type. Take meetingTypeId from the response.",
      inputSchema: z.object({
        date: z.string().optional().describe("UTC day as YYYY-MM-DD; omit for a 14-day overview"),
      }),
    },
    async ({ date }): Promise<CallToolResult> =>
      runTool(() => {
        const now = (clock ?? Date.now)();
        const start = windowStart(now);
        const types = listMeetingTypes(storage);
        if (date === undefined)
          return jsonResult({
            window: { startsOn: new Date(start).toISOString().slice(0, 10), days: 14 },
            meetingTypes: types.map((type) => ({
              ...summarize(type),
              days: getAvailability(storage, type.id, start, now)?.days ?? [],
            })),
          });
        const day = parseDate(date);
        if (day === null)
          return toolError("INVALID_DATE", "Use a UTC date formatted as YYYY-MM-DD");
        if (day < start || day >= start + 14 * DAY)
          return toolError("DATE_OUT_OF_RANGE", "Choose a date within the next 14 UTC days");
        return jsonResult({
          date,
          meetingTypes: types.map((type) => ({
            ...summarize(type),
            slots: getSlots(storage, type.id, start, day, now)?.slots ?? [],
          })),
        });
      }),
  );
}

const bookingErrors = {
  key_reused: {
    code: "IDEMPOTENCY_KEY_REUSED",
    hint: "This email already booked this slot with different guest details. Confirm the guest details or choose another slot.",
  },
  type_changed: {
    code: "MEETING_TYPE_CHANGED",
    hint: "The meeting type changed or is unavailable. Call get_availability and choose again.",
  },
  slot_unavailable: {
    code: "SLOT_UNAVAILABLE",
    hint: "The slot is taken. Call get_availability and offer another time.",
  },
} as const;

export function registerBookingTool(server: McpServer, { storage, now: clock }: Deps) {
  server.registerTool(
    "create_booking",
    {
      description:
        "Book a slot for a guest. All four fields are required; invalid or missing values return VALIDATION_ERROR. Uses the current meeting type version, and repeating the same meeting type, slot and email is idempotent. startsAt must be a UTC instant from get_availability.",
      inputSchema: z.object({
        meetingTypeId: z.string().describe("meetingTypeId from get_availability"),
        startsAt: z.string().describe("Slot start in UTC, ISO 8601 with a trailing Z"),
        guestName: z.string(),
        guestEmail: z.string(),
      }),
    },
    async (input): Promise<CallToolResult> =>
      runTool(() => {
        const guest = parseGuestFields(input);
        const fields: Record<string, string> = guest.kind === "invalid" ? { ...guest.fields } : {};
        const meetingTypeId =
          typeof input.meetingTypeId === "string" ? input.meetingTypeId.trim() : "";
        if (!meetingTypeId)
          fields.meetingTypeId = "meetingTypeId from get_availability is required";
        if (guest.kind === "invalid" || Object.keys(fields).length)
          return toolError("VALIDATION_ERROR", "Check the booking fields", fields);
        const type = listMeetingTypes(storage).find((candidate) => candidate.id === meetingTypeId);
        if (!type)
          return toolError(bookingErrors.type_changed.code, bookingErrors.type_changed.hint);
        const key = createHash("sha256")
          .update(
            JSON.stringify([
              type.id,
              new Date(guest.values.start).toISOString(),
              guest.values.email.toLowerCase(),
            ]),
          )
          .digest("hex");
        const result = createBooking(
          storage,
          {
            meetingTypeId: type.id,
            meetingTypeVersion: type.version,
            key,
            start: guest.values.start,
            name: guest.values.name,
            email: guest.values.email,
          },
          { clock },
        );
        if (result.kind === "created") return jsonResult(result.booking);
        return toolError(bookingErrors[result.kind].code, bookingErrors[result.kind].hint);
      }),
  );
}
