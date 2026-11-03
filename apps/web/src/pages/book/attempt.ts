import {
  createBooking,
  type Booking,
  type BookingInput,
} from "../../../../../generated/sdk/client";

export type Attempt = { key: string; input: BookingInput };
const storageKey = "calendar-booking-attempt";
export function loadAttempt(): Attempt | null {
  try {
    const value = sessionStorage.getItem(storageKey);
    return value ? (JSON.parse(value) as Attempt) : null;
  } catch {
    return null;
  }
}
export function prepareAttempt(input: BookingInput): Attempt {
  const attempt = { input, key: crypto.randomUUID() };
  sessionStorage.setItem(storageKey, JSON.stringify(attempt));
  return attempt;
}
export function clearAttempt() {
  sessionStorage.removeItem(storageKey);
}

type AttemptResult =
  | { kind: "success"; booking: Booking }
  | { kind: "slot-unavailable" }
  | { kind: "type-changed" }
  | { kind: "validation"; message: string; fields: Record<string, string> }
  | { kind: "rejected"; message: string }
  | { kind: "unknown" };

export async function sendAttempt(
  attempt: Attempt,
  mode: "initial" | "retry",
): Promise<AttemptResult> {
  try {
    const response = await createBooking(attempt.input, {
      headers: { "Idempotency-Key": attempt.key },
    });
    if (response.status === 201) {
      clearAttempt();
      return { kind: "success", booking: response.data };
    }
    if (mode === "retry" && (response.status === 400 || response.status === 409)) {
      clearAttempt();
      return { kind: "rejected", message: response.data.message };
    }
    if (mode === "initial" && response.status === 409) {
      if (response.data.code === "SLOT_UNAVAILABLE") {
        clearAttempt();
        return { kind: "slot-unavailable" };
      }
      if (response.data.code === "MEETING_TYPE_CHANGED") {
        clearAttempt();
        return { kind: "type-changed" };
      }
    }
    if (mode === "initial" && response.status === 400) {
      clearAttempt();
      return {
        kind: "validation",
        message: response.data.message,
        fields: response.data.fields ?? {},
      };
    }
  } catch {
    // A failed request or cleanup leaves the attempt's outcome uncertain.
  }
  return { kind: "unknown" };
}
