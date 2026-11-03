export function validateType(name: string, description: string, duration: string) {
  const cleanName = name.trim(),
    cleanDescription = description.trim(),
    minutes = Number(duration);
  const fields: Record<string, string> = {};
  if (!cleanName || [...cleanName].length > 100) fields.name = "Введите название до 100 символов";
  if (!cleanDescription || [...cleanDescription].length > 1000)
    fields.description = "Введите описание до 1000 символов";
  if (!duration.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 2147483647)
    fields.duration = "Введите целое число от 1 до 2147483647";
  return { cleanName, cleanDescription, minutes, fields };
}
