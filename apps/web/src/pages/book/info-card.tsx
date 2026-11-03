import { Clock3 } from "lucide-react";
import { formatMinutes, formatSlotCount } from "./format";

/**
 * «Информация о записи» panel: the guest's current selection.
 * All times are shown in UTC, as required by the functional spec.
 */
export function InfoCard({
  dateLabel,
  timeLabel,
  freeCount,
  durationMinutes,
}: {
  dateLabel: string | null;
  timeLabel: string | null;
  /** undefined hides the block, null shows a dash */
  freeCount?: number | null;
  durationMinutes: number | null;
}) {
  return (
    <section className="card info-card" aria-label="Информация о записи">
      <h2 className="card-title">Информация</h2>
      <p className="card-subtitle">Ваш выбор</p>
      <div className="info-blocks">
        <div className="info-block">
          <p className="info-block-label">Выбранная дата</p>
          <p className="info-block-value">{dateLabel ?? "Дата не выбрана"}</p>
        </div>
        <div className="info-block">
          <p className="info-block-label">Выбранное время</p>
          <p className="info-block-value">{timeLabel ?? "Время не выбрано"}</p>
        </div>
        {freeCount !== undefined && (
          <div className="info-block">
            <p className="info-block-label">Свободно</p>
            <p className="info-block-value">
              {freeCount === null ? "—" : formatSlotCount(freeCount)}
            </p>
          </div>
        )}
        <div className="info-block">
          <p className="info-block-label">Длительность</p>
          <p className="info-block-value">
            {durationMinutes === null ? "—" : formatMinutes(durationMinutes)}
          </p>
        </div>
      </div>
      <div className="info-tz">
        <Clock3 size={17} strokeWidth={2} aria-hidden />
        <span>Часовой пояс: UTC</span>
      </div>
    </section>
  );
}
