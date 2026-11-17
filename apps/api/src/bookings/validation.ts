import { isValidEmail } from "./email.js";

export type GuestValues = { name: string; email: string; start: number };

type Invalid = { kind: "invalid"; fields: Record<string, string> };

type Valid<T> = { kind: "valid"; values: T };

/** Validates the guest-facing booking fields shared by HTTP and MCP inputs. */
export function parseGuestFields(
  input: Record<string, unknown> | null,
): Invalid | Valid<GuestValues> {
  const name = typeof input?.guestName === "string" ? input.guestName.trim() : "";
  const email = typeof input?.guestEmail === "string" ? input.guestEmail.trim() : "";
  const fields: Record<string, string> = {};
  if (!name || [...name].length > 100) fields.guestName = "Введите имя до 100 символов";
  if (!email || [...email].length > 254 || !isValidEmail(email))
    fields.guestEmail = "Введите корректный email до 254 символов";
  const startsAt = typeof input?.startsAt === "string" ? input.startsAt : "";
  const start = Date.parse(startsAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(startsAt) ||
    !Number.isFinite(start) ||
    new Date(start).toISOString().slice(0, 10) !== startsAt.slice(0, 10)
  )
    fields.startsAt = "Введите корректное время UTC";
  if (Object.keys(fields).length) return { kind: "invalid", fields };
  return { kind: "valid", values: { name, email, start } };
}

type BookingValues = GuestValues & {
  meetingTypeId: string;
  meetingTypeVersion: number;
  key: string;
};

/** Validates an HTTP booking request, including the attempt key and meeting type fields. */
export function parseBookingRequest(
  input: Record<string, unknown> | null,
  keyHeader: unknown,
): Invalid | Valid<BookingValues> {
  const guest = parseGuestFields(input);
  const fields: Record<string, string> = guest.kind === "invalid" ? { ...guest.fields } : {};
  const meetingTypeId = typeof input?.meetingTypeId === "string" ? input.meetingTypeId : "";
  if (!meetingTypeId) fields.meetingTypeId = "Выберите тип встречи";
  const meetingTypeVersion = input?.meetingTypeVersion;
  if (
    typeof meetingTypeVersion !== "number" ||
    !Number.isSafeInteger(meetingTypeVersion) ||
    meetingTypeVersion < 1
  )
    fields.meetingTypeVersion = "Выберите актуальный тип встречи";
  const key = typeof keyHeader === "string" ? keyHeader : "";
  if (!key.trim() || key.length > 200) fields.idempotencyKey = "Укажите ключ попытки";
  if (guest.kind === "invalid" || Object.keys(fields).length) return { kind: "invalid", fields };
  return {
    kind: "valid",
    values: {
      ...guest.values,
      meetingTypeId,
      meetingTypeVersion: meetingTypeVersion as number,
      key,
    },
  };
}
