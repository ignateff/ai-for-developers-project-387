// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { loadAttempt, prepareAttempt, sendAttempt } from "./attempt";

const input = {
  meetingTypeId: "type-1",
  meetingTypeVersion: 1,
  startsAt: "2026-11-02T09:00:00.000Z",
  guestName: "Alice",
  guestEmail: "alice@example.com",
};

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("saves before sending and reuses the same attempt after a lost response", async () => {
  const attempt = prepareAttempt(input);
  const savedAtSend: ReturnType<typeof loadAttempt>[] = [];
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => {
    savedAtSend.push(loadAttempt());
    if (fetchMock.mock.calls.length === 1) throw new Error("response lost");
    return Response.json({ id: "booking-1" }, { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await sendAttempt(attempt, "initial")).toEqual({ kind: "unknown" });
  expect(loadAttempt()).toEqual(attempt);
  expect(await sendAttempt(attempt, "retry")).toEqual({
    kind: "success",
    booking: { id: "booking-1" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(savedAtSend).toEqual([attempt, attempt]);
  for (const [, options] of fetchMock.mock.calls) {
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(attempt.key);
    expect(JSON.parse(String(options?.body))).toEqual(input);
  }
  expect(loadAttempt()).toBeNull();
});

it.each([
  ["SLOT_UNAVAILABLE", "slot-unavailable"],
  ["MEETING_TYPE_CHANGED", "type-changed"],
] as const)("classifies %s on the first send and clears the attempt", async (code, kind) => {
  const attempt = prepareAttempt(input);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ code, message: "Conflict" }, { status: 409 })),
  );
  expect(await sendAttempt(attempt, "initial")).toEqual({ kind });
  expect(loadAttempt()).toBeNull();
});

it("preserves an unrecognised initial conflict but treats it as final on retry", async () => {
  const attempt = prepareAttempt(input);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ code: "IDEMPOTENCY_KEY_REUSED", message: "Conflict" }, { status: 409 }),
    ),
  );
  expect(await sendAttempt(attempt, "initial")).toEqual({ kind: "unknown" });
  expect(loadAttempt()).toEqual(attempt);
  expect(await sendAttempt(attempt, "retry")).toEqual({ kind: "rejected", message: "Conflict" });
  expect(loadAttempt()).toBeNull();
});

it("keeps the attempt for server failures and clears it for validation failures", async () => {
  const attempt = prepareAttempt(input);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ message: "Unavailable" }, { status: 503 })),
  );
  expect(await sendAttempt(attempt, "retry")).toEqual({ kind: "unknown" });
  expect(loadAttempt()).toEqual(attempt);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ message: "Invalid", fields: { guestName: "Required" } }, { status: 400 }),
    ),
  );
  expect(await sendAttempt(attempt, "initial")).toEqual({
    kind: "validation",
    message: "Invalid",
    fields: { guestName: "Required" },
  });
  expect(loadAttempt()).toBeNull();
});

it("does not send when the attempt cannot be saved", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(() => prepareAttempt(input)).toThrow("storage unavailable");
  expect(fetchMock).not.toHaveBeenCalled();
});
