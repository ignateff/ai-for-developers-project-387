import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { buildApp } from "../app.js";

const NOW = Date.parse("2026-10-30T08:00:00Z");

async function withClient(
  run: (client: Client, app: ReturnType<typeof buildApp>) => Promise<void>,
) {
  const app = buildApp({ now: () => NOW });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "calendar-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
    await run(client, app);
  } finally {
    await client.close();
    await app.close();
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content.find((entry) => entry.type === "text")?.text ?? "";
  return { isError: result.isError === true, body: text ? JSON.parse(text) : undefined };
}

it("lists the calendar tools an agent can call", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["create_booking", "get_availability"]);
    for (const tool of tools) expect(tool.description).toBeTruthy();
  });
});

async function createType(
  app: ReturnType<typeof buildApp>,
  payload: { name: string; description: string; durationMinutes: number },
) {
  const response = await app.inject({ method: "POST", url: "/api/meeting-types", payload });
  return response.json();
}

it("shows the next 14 UTC days of availability for every meeting type", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const { isError, body } = await callTool(client, "get_availability", {});
    expect(isError).toBe(false);
    expect(body.window).toEqual({ startsOn: "2026-10-30", days: 14 });
    expect(body.meetingTypes).toHaveLength(1);
    expect(body.meetingTypes[0]).toMatchObject({
      id: type.id,
      name: "Call",
      description: "Intro",
      durationMinutes: 30,
    });
    expect(body.meetingTypes[0].version).toBeUndefined();
    expect(body.meetingTypes[0].days[0]).toEqual({ date: "2026-10-30", availableCount: 18 });
    expect(body.meetingTypes[0].days[1]).toEqual({ date: "2026-10-31", availableCount: 0 });
  });
});

it("rejects malformed dates and days outside the 14-day UTC window", async () => {
  await withClient(async (client, app) => {
    await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const malformed = await callTool(client, "get_availability", { date: "02.11.2026" });
    expect(malformed.isError).toBe(true);
    expect(malformed.body.code).toBe("INVALID_DATE");
    const far = await callTool(client, "get_availability", { date: "2026-12-01" });
    expect(far.isError).toBe(true);
    expect(far.body.code).toBe("DATE_OUT_OF_RANGE");
  });
});

it("books a free slot for a guest and returns the booking", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const { isError, body } = await callTool(client, "create_booking", {
      meetingTypeId: type.id,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: " Alice ",
      guestEmail: " a@example.com ",
    });
    expect(isError).toBe(false);
    expect(body.id).toEqual(expect.any(String));
    expect(body).toMatchObject({
      meetingTypeId: type.id,
      meetingTypeName: "Call",
      meetingTypeDescription: "Intro",
      meetingTypeDurationMinutes: 30,
      guestName: "Alice",
      guestEmail: "a@example.com",
      startsAt: "2026-11-02T09:00:00.000Z",
      endsAt: "2026-11-02T09:30:00.000Z",
    });
    const slots = await callTool(client, "get_availability", { date: "2026-11-02" });
    expect(slots.body.meetingTypes[0].slots[0]).toMatchObject({ available: false });
  });
});

it("shows the slots of a chosen UTC day for every meeting type", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const { isError, body } = await callTool(client, "get_availability", { date: "2026-11-02" });
    expect(isError).toBe(false);
    expect(body.date).toBe("2026-11-02");
    expect(body.meetingTypes[0].id).toBe(type.id);
    expect(body.meetingTypes[0].slots).toHaveLength(18);
    expect(body.meetingTypes[0].slots[0]).toEqual({
      startsAt: "2026-11-02T09:00:00.000Z",
      endsAt: "2026-11-02T09:30:00.000Z",
      available: true,
    });
  });
});

it("books against the current meeting type version without asking the agent for it", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const update = await app.inject({
      method: "PUT",
      url: `/api/meeting-types/${type.id}`,
      headers: { "if-match": '"1"' },
      payload: { name: "Call", description: "Intro", durationMinutes: 60 },
    });
    expect(update.statusCode).toBe(200);
    const { isError, body } = await callTool(client, "create_booking", {
      meetingTypeId: type.id,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      meetingTypeDurationMinutes: 60,
      startsAt: "2026-11-02T09:00:00.000Z",
      endsAt: "2026-11-02T10:00:00.000Z",
    });
  });
});

it("repeats the same booking attempt without creating a second booking", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const input = {
      meetingTypeId: type.id,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    const first = await callTool(client, "create_booking", input);
    const second = await callTool(client, "create_booking", input);
    expect(first.isError).toBe(false);
    expect(second.body).toEqual(first.body);
    const slots = await callTool(client, "get_availability", { date: "2026-11-02" });
    const free = slots.body.meetingTypes[0].slots.filter(
      (slot: { available: boolean }) => slot.available,
    );
    expect(free).toHaveLength(17);
  });
});

it("reports a taken slot instead of double booking it", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const slot = {
      meetingTypeId: type.id,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    expect((await callTool(client, "create_booking", slot)).isError).toBe(false);
    const conflict = await callTool(client, "create_booking", {
      ...slot,
      guestName: "Bob",
      guestEmail: "b@example.com",
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.body.code).toBe("SLOT_UNAVAILABLE");
    expect(conflict.body.hint).toEqual(expect.any(String));
  });
});

it("rejects an unknown meeting type with the HTTP API error code", async () => {
  await withClient(async (client) => {
    const { isError, body } = await callTool(client, "create_booking", {
      meetingTypeId: "missing",
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    });
    expect(isError).toBe(true);
    expect(body.code).toBe("MEETING_TYPE_CHANGED");
  });
});

it("returns field errors for invalid booking input", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const { isError, body } = await callTool(client, "create_booking", {
      meetingTypeId: type.id,
      startsAt: "2026-11-02 09:00",
      guestName: " ",
      guestEmail: "not-an-email",
    });
    expect(isError).toBe(true);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.details).sort()).toEqual(["guestEmail", "guestName", "startsAt"]);
  });
});

it("reports key reuse when the same email books one slot with different details", async () => {
  await withClient(async (client, app) => {
    const type = await createType(app, { name: "Call", description: "Intro", durationMinutes: 30 });
    const slot = {
      meetingTypeId: type.id,
      startsAt: "2026-11-02T09:00:00.000Z",
      guestName: "Alice",
      guestEmail: "a@example.com",
    };
    expect((await callTool(client, "create_booking", slot)).isError).toBe(false);
    const changed = await callTool(client, "create_booking", { ...slot, guestName: "Alicia" });
    expect(changed.isError).toBe(true);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});
