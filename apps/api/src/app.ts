import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import Fastify, { LogController, type onRouteHookHandler } from "fastify";
import fastifyStatic from "@fastify/static";
import { openDatabase } from "./database/database.js";
import { meetingTypeRoutes } from "./meeting-types/routes.js";
import { availabilityRoutes } from "./availability/routes.js";
import { bookingRoutes } from "./bookings/routes.js";
import { eventRoutes } from "./events/routes.js";
import { errorCategory } from "./safe-error.js";

function safeMethod(method: string) {
  return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)
    ? method
    : "OTHER";
}

export function buildApp(
  options: {
    onRoute?: onRouteHookHandler;
    databasePath?: string;
    now?: () => number;
    onBookingLocked?: () => void;
    logStream?: Writable;
  } = {},
) {
  const app = Fastify({
    logger: {
      ...(options.logStream ? { stream: options.logStream } : {}),
      serializers: { err: () => ({ type: "Error", message: "Error details omitted", stack: "" }) },
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    exposeHeadRoutes: false,
  });
  if (options.onRoute) app.addHook("onRoute", options.onRoute);
  const storage = openDatabase(options.databasePath ?? ":memory:");
  app.addHook("onClose", async () => storage.close());
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: safeMethod(request.method),
        route: request.routeOptions.url ?? "unmatched",
        statusCode: reply.statusCode,
      },
      "Request completed",
    );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 400)
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Некорректный запрос" });
    let cause: unknown = error;
    while (cause instanceof Error) {
      if (
        "code" in cause &&
        typeof cause.code === "string" &&
        (cause.code.startsWith("SQLITE_BUSY") || cause.code.startsWith("SQLITE_LOCKED"))
      )
        return reply
          .status(503)
          .send({ code: "DATABASE_BUSY", message: "Сервис временно занят, попробуйте ещё раз" });
      cause = cause.cause;
    }
    request.log.error(
      {
        method: safeMethod(request.method),
        route: request.routeOptions.url ?? "unmatched",
        statusCode: 500,
        errorCategory: errorCategory(error),
      },
      "Unexpected request error",
    );
    void reply.status(500).send({ code: "INTERNAL_ERROR", message: "Не удалось выполнить запрос" });
  });
  app.get("/api/health", async () => ({ status: "ok" }));
  app.register(meetingTypeRoutes, { storage });
  app.register(availabilityRoutes, { storage, now: options.now });
  app.register(eventRoutes, { storage, now: options.now });
  app.register(bookingRoutes, {
    storage,
    now: options.now,
    onBookingLocked: options.onBookingLocked,
  });
  // Serve the built frontend when it exists (production image); dev uses the Vite server instead.
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/"))
        return reply.sendFile("index.html");
      return reply.status(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    });
  }
  return app;
}
