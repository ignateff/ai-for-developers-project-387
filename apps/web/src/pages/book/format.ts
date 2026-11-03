const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const MONTHS_NOMINATIVE = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];
const MONTHS_SHORT_UPPER = [
  "ЯНВ",
  "ФЕВ",
  "МАР",
  "АПР",
  "МАЙ",
  "ИЮН",
  "ИЮЛ",
  "АВГ",
  "СЕН",
  "ОКТ",
  "НОЯ",
  "ДЕК",
];
const WEEKDAYS = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

export function parseUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** «суббота, 28 марта» — all calendar math stays in UTC. */
export function formatDayLabel(iso: string): string {
  const date = parseUtcDate(iso);
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]}`;
}

/** «март 2026» */
export function formatMonthTitle(year: number, month: number): string {
  return `${MONTHS_NOMINATIVE[month]} ${year}`;
}

export function formatMonthBadge(iso: string): { month: string; day: string } {
  const date = parseUtcDate(iso.slice(0, 10));
  return { month: MONTHS_SHORT_UPPER[date.getUTCMonth()], day: String(date.getUTCDate()) };
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function formatMinutes(minutes: number): string {
  return `${minutes} ${plural(minutes, "минута", "минуты", "минут")}`;
}

export function formatSlotCount(count: number): string {
  return `${count} ${plural(count, "слот", "слота", "слотов")}`;
}

export function formatTimeRange(startsAt: string, endsAt: string): string {
  return `${startsAt.slice(11, 16)} – ${endsAt.slice(11, 16)}`;
}

export function formatLongDate(iso: string): string {
  const date = parseUtcDate(iso.slice(0, 10));
  return `${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]}`;
}
