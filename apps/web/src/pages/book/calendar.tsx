import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AvailabilityDay } from "../../../../../generated/sdk/client";
import { formatMonthTitle, parseUtcDate, toIsoDate } from "./format";

const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DAY_MS = 86_400_000;

function buildWeeks(year: number, month: number): Date[][] {
  const firstOfMonth = Date.UTC(year, month, 1);
  const offset = (new Date(firstOfMonth).getUTCDay() + 6) % 7; // week starts on Monday
  let cursor = firstOfMonth - offset * DAY_MS;
  const weeks: Date[][] = [];
  for (let row = 0; row < 6; row++) {
    const week: Date[] = [];
    for (let day = 0; day < 7; day++) {
      week.push(new Date(cursor));
      cursor += DAY_MS;
    }
    weeks.push(week);
    if (new Date(cursor).getUTCMonth() !== month) break;
  }
  return weeks;
}

export function BookingCalendar({
  days,
  selected,
  disabled,
  onSelect,
}: {
  days: AvailabilityDay[];
  selected: string | null;
  disabled?: boolean;
  onSelect: (date: string) => void;
}) {
  const first = days[0]?.date ?? toIsoDate(new Date());
  const last = days[days.length - 1]?.date ?? first;
  const [month, setMonth] = useState(() => {
    const date = parseUtcDate(first);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
  });
  const byDate = new Map(days.map((day) => [day.date, day]));
  const monthIndex = month.year * 12 + month.month;
  const firstDate = parseUtcDate(first);
  const lastDate = parseUtcDate(last);
  const canPrev = monthIndex > firstDate.getUTCFullYear() * 12 + firstDate.getUTCMonth();
  const canNext = monthIndex < lastDate.getUTCFullYear() * 12 + lastDate.getUTCMonth();
  function shift(delta: number) {
    setMonth((current) => {
      const date = new Date(Date.UTC(current.year, current.month + delta, 1));
      return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
    });
  }
  return (
    <div className="calendar">
      <div className="calendar-month">
        <p className="calendar-month-title">{formatMonthTitle(month.year, month.month)}</p>
        <div className="calendar-nav">
          <button
            type="button"
            className="calendar-nav-btn"
            aria-label="Предыдущий месяц"
            disabled={!canPrev}
            onClick={() => shift(-1)}
          >
            <ChevronLeft size={16} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="calendar-nav-btn"
            aria-label="Следующий месяц"
            disabled={!canNext}
            onClick={() => shift(1)}
          >
            <ChevronRight size={16} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>
      <div className="calendar-weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="calendar-weekday">
            {label}
          </span>
        ))}
      </div>
      <div className="calendar-grid">
        {buildWeeks(month.year, month.month).map((week, index) => (
          <div key={index} className="calendar-week">
            {week.map((date) => {
              const iso = toIsoDate(date);
              const info = byDate.get(iso);
              // Days outside the displayed month stay inactive, like in the design,
              // even when they belong to the booking window of an adjacent month.
              if (!info || date.getUTCMonth() !== month.month)
                return (
                  <span key={iso} className="calendar-day is-outside" aria-hidden>
                    <span className="calendar-day-number">{date.getUTCDate()}</span>
                  </span>
                );
              const isSelected = selected === iso;
              const isAvailable = info.availableCount > 0;
              const className = `calendar-day${isSelected ? " is-selected" : ""}${
                isAvailable ? " is-available" : " is-empty"
              }`;
              return (
                <button
                  key={iso}
                  type="button"
                  className={className}
                  aria-label={`${iso} · ${info.availableCount} свободно`}
                  aria-pressed={isSelected}
                  disabled={!isAvailable || Boolean(disabled)}
                  onClick={() => onSelect(iso)}
                >
                  <span className="calendar-day-number">{date.getUTCDate()}</span>
                  {isAvailable && (
                    <span className="calendar-day-count">{info.availableCount} св.</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
