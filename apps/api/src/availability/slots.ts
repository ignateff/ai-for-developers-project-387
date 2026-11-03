const DAY = 86_400_000;
const MINUTE = 60_000;
export type Interval = { startsAt: number; endsAt: number };
export function windowStart(now: number) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
export function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
export function calculateSlots(
  day: number,
  durationMinutes: number,
  now: number,
  bookings: Interval[],
) {
  const weekday = new Date(day).getUTCDay();
  if (weekday === 0 || weekday === 6 || durationMinutes > 540) return [];
  const step = durationMinutes * MINUTE;
  const result: { startsAt: string; endsAt: string; available: boolean }[] = [];
  for (let start = day + 9 * 60 * MINUTE; start + step <= day + 18 * 60 * MINUTE; start += step) {
    if (start <= now) continue;
    const end = start + step;
    result.push({
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      available: !bookings.some((booking) => booking.startsAt < end && booking.endsAt > start),
    });
  }
  return result;
}
export { DAY };
