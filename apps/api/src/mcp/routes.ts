import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance } from "fastify";
import type { Storage } from "../database/database.js";
import { calendarMcpHandler } from "./server.js";

export async function mcpRoutes(
  app: FastifyInstance,
  { storage, now }: { storage: Storage; now?: () => number },
) {
  const node = toNodeHandler(calendarMcpHandler({ storage, now }));
  app.all("/mcp", async (request, reply) => {
    reply.hijack();
    await node(request.raw, reply.raw, request.body);
  });
}
