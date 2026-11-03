import { CalendarDays, Check } from "lucide-react";
import { formatLongDate, formatTimeRange } from "./format";

/** Success panel shown after a booking is created (or safely retried). */
export function BookingSuccess({
  typeName,
  startsAt,
  endsAt,
  againLabel,
  onAgain,
}: {
  typeName: string;
  startsAt: string;
  endsAt: string;
  againLabel: string;
  onAgain: () => void;
}) {
  return (
    <div className="card success-card">
      <div className="success-icon" aria-hidden>
        <Check size={24} strokeWidth={2.5} />
      </div>
      <h2 className="success-title">Бронь подтверждена</h2>
      <p className="success-text">До встречи! Сохраните детали записи самостоятельно.</p>
      <div className="success-details">
        <CalendarDays size={20} strokeWidth={2} aria-hidden />
        <span>
          {typeName} · {formatLongDate(startsAt)} · {formatTimeRange(startsAt, endsAt)} · UTC
        </span>
      </div>
      <button type="button" className="btn btn-accent success-again" onClick={onAgain}>
        {againLabel}
      </button>
    </div>
  );
}
