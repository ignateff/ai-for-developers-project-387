import { CalendarDays, Check } from "lucide-react";
import { useState } from "react";
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
  const [copyStatus, setCopyStatus] = useState<"copied" | "error" | null>(null);
  const details = `${typeName} · ${formatLongDate(startsAt)} · ${formatTimeRange(startsAt, endsAt)} · UTC`;

  async function copyDetails() {
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(details);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <div className="card success-card">
      <div className="success-icon" aria-hidden>
        <Check size={24} strokeWidth={2.5} />
      </div>
      <h2 className="success-title">Бронь подтверждена</h2>
      <p className="success-text">До встречи! Сохраните детали записи самостоятельно.</p>
      <div className="success-details">
        <CalendarDays size={20} strokeWidth={2} aria-hidden />
        <span>{details}</span>
      </div>
      <button
        type="button"
        className="btn btn-outline success-copy"
        onClick={() => void copyDetails()}
      >
        Скопировать детали
      </button>
      {copyStatus === "copied" && (
        <p className="success-copy-feedback" role="status">
          Детали скопированы
        </p>
      )}
      {copyStatus === "error" && (
        <p className="alert success-copy-feedback" role="alert">
          Не удалось скопировать детали. Сохраните их вручную.
        </p>
      )}
      <button type="button" className="btn btn-accent success-again" onClick={onAgain}>
        {againLabel}
      </button>
    </div>
  );
}
