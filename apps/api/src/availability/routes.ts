import type { FastifyInstance } from "fastify";
import type { Storage } from "../database/database.js";
import { DAY, parseDate, windowStart } from "./slots.js";
import { getAvailability, getSlots } from "./service.js";

export async function availabilityRoutes(
  app: FastifyInstance,
  { storage, now: clock }: { storage: Storage; now?: () => number },
) {
  app.get<{ Params: { id: string } }>(
    "/api/meeting-types/:id/availability",
    async (request, reply) => {
      const now = (clock ?? Date.now)();
      const start = windowStart(now);
      const availability = getAvailability(storage, request.params.id, start, now);
      if (!availability)
        return reply.status(404).send({ code: "NOT_FOUND", message: "Тип встречи не найден" });
      return availability;
    },
  );
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    "/api/meeting-types/:id/slots",
    async (request, reply) => {
      const now = (clock ?? Date.now)();
      const start = windowStart(now);
      const day = parseDate(request.query.date);
      if (day === null)
        return reply
          .status(400)
          .send({ code: "INVALID_DATE", message: "Введите корректную дату UTC" });
      if (day < start || day >= start + 14 * DAY)
        return reply
          .status(400)
          .send({ code: "DATE_OUT_OF_RANGE", message: "Выберите дату в ближайшие 14 дней UTC" });
      const slots = getSlots(storage, request.params.id, start, day, now);
      if (!slots)
        return reply.status(404).send({ code: "NOT_FOUND", message: "Тип встречи не найден" });
      return slots;
    },
  );
}
