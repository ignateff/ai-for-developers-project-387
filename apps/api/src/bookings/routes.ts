import type { FastifyInstance } from "fastify";
import type { Storage } from "../database/database.js";
import { createBooking } from "./service.js";
import { parseBookingRequest } from "./validation.js";
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
    const parsed = parseBookingRequest(
      request.body as Record<string, unknown> | null,
      request.headers["idempotency-key"],
    );
    if (parsed.kind === "invalid")
      return reply
        .status(400)
        .send({ code: "VALIDATION_ERROR", message: "Проверьте поля", fields: parsed.fields });
    const result = createBooking(storage, parsed.values, { clock, onBookingLocked });
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
