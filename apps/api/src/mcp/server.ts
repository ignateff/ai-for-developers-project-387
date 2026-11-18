import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Storage } from "../database/database.js";
import { registerAvailabilityTool, registerBookingTool } from "./tools.js";

type Deps = { storage: Storage; now?: () => number };

function createCalendarServer(deps: Deps) {
  const server = new McpServer({ name: "calendar", version: "1.0.0" });
  registerAvailabilityTool(server, deps);
  registerBookingTool(server, deps);
  return server;
}

export function calendarMcpHandler(deps: Deps) {
  return createMcpHandler(() => createCalendarServer(deps));
}
