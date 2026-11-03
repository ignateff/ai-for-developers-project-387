import type { FastifyInstance } from "fastify";
import type { Storage } from "../database/database.js";
import { validateMeetingType } from "./validation.js";
import {
  listMeetingTypes,
  createMeetingType,
  getMeetingType,
  updateMeetingType,
  deleteMeetingType,
} from "./service.js";

export async function meetingTypeRoutes(app: FastifyInstance, { storage }: { storage: Storage }) {
  app.get("/api/meeting-types", async () => listMeetingTypes(storage));
  app.post("/api/meeting-types", async (request, reply) => {
    const { name, description, durationMinutes, fields } = validateMeetingType(request.body);
    if (Object.keys(fields).length || typeof durationMinutes !== "number")
      return reply
        .status(400)
        .send({ code: "VALIDATION_ERROR", message: "Проверьте поля", fields });
    const result = createMeetingType(storage, { name, description, durationMinutes });
    return reply.status(201).header("ETag", '"1"').send(result);
  });
  app.get<{ Params: { id: string } }>("/api/meeting-types/:id", async (request, reply) => {
    const type = getMeetingType(storage, request.params.id);
    if (!type)
      return reply.status(404).send({ code: "NOT_FOUND", message: "Тип встречи не найден" });
    const { id, name, description, durationMinutes, version } = type;
    return reply
      .header("ETag", `"${version}"`)
      .send({ id, name, description, durationMinutes, version });
  });
  app.put<{ Params: { id: string } }>("/api/meeting-types/:id", async (request, reply) => {
    const { name, description, durationMinutes, fields } = validateMeetingType(request.body);
    const match = request.headers["if-match"];
    const result = updateMeetingType(storage, request.params.id, match, {
      name,
      description,
      durationMinutes,
      fields,
    });
    if (result.kind === "updated")
      return reply.header("ETag", `"${result.type.version}"`).send(result.type);
    const errors = {
      invalid: [400, "VALIDATION_ERROR", "Проверьте поля"],
      not_found: [404, "NOT_FOUND", "Тип встречи не найден"],
      version_changed: [412, "PRECONDITION_FAILED", "Тип встречи изменился"],
      version_required: [428, "PRECONDITION_REQUIRED", "Укажите версию типа"],
    } as const;
    const [status, code, message] = errors[result.kind];
    return reply
      .status(status)
      .send({ code, message, ...(result.kind === "invalid" ? { fields } : {}) });
  });
  app.delete<{ Params: { id: string } }>("/api/meeting-types/:id", async (request, reply) => {
    const match = request.headers["if-match"];
    const result = deleteMeetingType(storage, request.params.id, match);
    if (result === "deleted") return reply.status(204).send();
    const errors = {
      not_found: [404, "NOT_FOUND", "Тип встречи не найден"],
      version_changed: [412, "PRECONDITION_FAILED", "Тип встречи изменился"],
      version_required: [428, "PRECONDITION_REQUIRED", "Укажите версию типа"],
    } as const;
    const [status, code, message] = errors[result];
    return reply.status(status).send({ code, message });
  });
}
