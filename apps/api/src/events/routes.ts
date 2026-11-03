import type { FastifyInstance } from "fastify";
import type { Storage } from "../database/database.js";
import { listUpcomingEvents } from "./service.js";

export async function eventRoutes(
  app: FastifyInstance,
  { storage, now: clock }: { storage: Storage; now?: () => number },
) {
  app.get("/api/events/upcoming", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const now = (clock ?? Date.now)();
    return listUpcomingEvents(storage, now);
  });
}
