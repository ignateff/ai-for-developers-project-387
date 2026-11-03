export function validateMeetingType(value: unknown) {
  const input = value as Record<string, unknown> | null;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  const durationMinutes = input?.durationMinutes;
  const fields: Record<string, string> = {};
  if (!name || [...name].length > 100) fields.name = "Введите название до 100 символов";
  if (!description || [...description].length > 1000)
    fields.description = "Введите описание до 1000 символов";
  if (
    typeof durationMinutes !== "number" ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > 2147483647
  )
    fields.durationMinutes = "Введите целое число от 1 до 2147483647";
  return { name, description, durationMinutes, fields };
}
