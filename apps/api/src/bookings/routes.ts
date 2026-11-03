import type { FastifyInstance } from "fastify";
import type { Storage } from "../database/database.js";
import { isValidEmail } from "./email.js";
import { createBooking } from "./service.js";

export async function bookingRoutes(
  app: FastifyInstance,
  {
    storage,
    now: clock,
    onBookingLocked,
  }: { storage: Storage; now?: () => number; onBookingLocked?: () => void },
) {
  app.post("/api/bookings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const input = request.body as Record<string, unknown> | null;
    const key = request.headers["idempotency-key"];
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
    if (typeof input?.meetingTypeId !== "string" || !input.meetingTypeId)
      fields.meetingTypeId = "Выберите тип встречи";
    if (
      typeof input?.meetingTypeVersion !== "number" ||
      !Number.isSafeInteger(input.meetingTypeVersion) ||
      input.meetingTypeVersion < 1
    )
      fields.meetingTypeVersion = "Выберите актуальный тип встречи";
    if (typeof key !== "string" || !key.trim() || key.length > 200)
      fields.idempotencyKey = "Укажите ключ попытки";
    if (
      Object.keys(fields).length ||
      typeof key !== "string" ||
      typeof input?.meetingTypeId !== "string" ||
      typeof input.meetingTypeVersion !== "number"
    )
      return reply
        .status(400)
        .send({ code: "VALIDATION_ERROR", message: "Проверьте поля", fields });
    const result = createBooking(
      storage,
      {
        meetingTypeId: input.meetingTypeId,
        meetingTypeVersion: input.meetingTypeVersion,
        key,
        start,
        name,
        email,
      },
      { clock, onBookingLocked },
    );
    if (result.kind === "created") return reply.status(201).send(result.booking);
    const errors = {
      key_reused: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Ключ уже использован с другими данными",
      },
      type_changed: {
        code: "MEETING_TYPE_CHANGED",
        message: "Тип встречи изменился или недоступен. Выберите тип заново",
      },
      slot_unavailable: {
        code: "SLOT_UNAVAILABLE",
        message: "Слот недоступен, выберите другое время",
      },
    };
    return reply.status(409).send(errors[result.kind]);
  });
}
