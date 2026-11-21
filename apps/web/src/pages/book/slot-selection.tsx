import { ArrowRight, CalendarDays, Check } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  AvailabilityResponse,
  SlotsResponse,
  MeetingType,
  Slot,
} from "../../../../../generated/sdk/client";
import { BookingCalendar } from "./calendar";
import { InfoCard } from "./info-card";
import { capitalize, formatDayLabel, formatMinutes, formatTimeRange } from "./format";

export function SlotSelection({
  type,
  date,
  selected,
  selectedSlot,
  freeCount,
  summary,
  slots,
  slotsBlocked,
  outdated,
  conflict,
  onBack,
  onSelectDate,
  onSelectSlot,
  onContinue,
}: {
  type: MeetingType;
  date: string | null;
  selected: string | null;
  selectedSlot: Slot | null;
  freeCount: number | null;
  summary: UseQueryResult<AvailabilityResponse, Error>;
  slots: UseQueryResult<SlotsResponse, Error>;
  slotsBlocked: boolean;
  outdated: boolean;
  conflict: string;
  onBack: () => void;
  onSelectDate: (date: string) => void;
  onSelectSlot: (slot: string) => void;
  onContinue: () => void;
}) {
  return (
    <section className="container booking" aria-label="Выбор даты и времени">
      <header className="page-header">
        <h1 className="page-title">Запись на звонок</h1>
        <p className="page-subtitle">
          Выберите удобную дату и время для звонка. Все даты и время указаны в UTC.
        </p>
      </header>
      {conflict && (
        <p role="alert" className="alert">
          {conflict}
        </p>
      )}
      {outdated && (
        <p role="alert" className="alert">
          Тип встречи изменился или удалён. Вернитесь к выбору актуального типа.
        </p>
      )}
      <div className="booking-grid">
        <InfoCard
          dateLabel={date ? formatDayLabel(date) : null}
          timeLabel={
            selectedSlot ? formatTimeRange(selectedSlot.startsAt, selectedSlot.endsAt) : null
          }
          freeCount={freeCount}
          durationMinutes={type.durationMinutes}
        />
        <section className="card calendar-card" aria-label="Календарь">
          <h2 className="card-title">Календарь</h2>
          <p className="card-subtitle">Выберите день</p>
          {summary.isPending && <p className="calendar-state">Загрузка доступности…</p>}
          {summary.isError && (
            <div role="alert" className="alert calendar-alert">
              Не удалось загрузить доступность.{" "}
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => void summary.refetch()}
              >
                Повторить
              </button>
            </div>
          )}
          {summary.data && (
            <BookingCalendar
              days={summary.data.days}
              selected={date}
              disabled={outdated}
              onSelect={(next) => {
                onSelectDate(next);
              }}
            />
          )}
          <p className="calendar-legend">Доступные дни отмечены количеством слотов</p>
        </section>
        <section className="card slots-card" aria-label="Доступное время">
          <h2 className="card-title">Доступное время</h2>
          <p className="card-subtitle">
            {date
              ? `${capitalize(formatDayLabel(date))} · ${formatMinutes(type.durationMinutes)}`
              : "Выберите дату в календаре"}
          </p>
          <div className="slots-body">
            {!date && (
              <div className="slots-hint">
                <CalendarDays size={20} strokeWidth={2} aria-hidden />
                <p>Выберите дату, чтобы увидеть доступное время.</p>
              </div>
            )}
            {date && (slots.isPending || (slotsBlocked && slots.isFetching)) && (
              <p className="slots-state" role="status">
                {slots.isPending ? "Загрузка слотов…" : "Обновление слотов…"}
              </p>
            )}
            {date && slots.isError && (
              <div role="alert" className="alert">
                Не удалось загрузить слоты.{" "}
                <button
                  type="button"
                  className="btn btn-subtle"
                  onClick={() => void slots.refetch()}
                >
                  Повторить
                </button>
              </div>
            )}
            {date && slots.data?.slots.length === 0 && (
              <p className="slots-state">На эту дату нет доступных слотов</p>
            )}
            {slots.data &&
              slots.data.slots.length > 0 &&
              !slots.data.slots.some((slot) => slot.available) && (
                <p className="slots-state">На эту дату нет свободных слотов</p>
              )}
            {slots.data && slots.data.slots.length > 0 && (
              <div className="slots-grid">
                {slots.data.slots.map((slot) => {
                  const isSelected = selected === slot.startsAt;
                  const className = `slot${isSelected ? " is-selected" : ""}${
                    slot.available ? "" : " is-busy"
                  }`;
                  return (
                    <button
                      key={slot.startsAt}
                      type="button"
                      className={className}
                      disabled={!slot.available || outdated || slotsBlocked}
                      aria-pressed={isSelected}
                      onClick={() => onSelectSlot(slot.startsAt)}
                    >
                      <span className="slot-time">{slot.startsAt.slice(11, 16)}</span>{" "}
                      <span className="slot-tz">UTC</span>
                      {!slot.available && <span className="slot-status">Занято</span>}
                      {isSelected && slot.available && (
                        <Check size={16} strokeWidth={2.5} className="slot-check" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="slots-footer">
            <div className="slots-divider" />
            <div className="slots-actions">
              <button type="button" className="btn btn-outline" onClick={onBack}>
                Назад
              </button>
              <button
                type="button"
                className="btn btn-accent"
                disabled={!selected || outdated || slotsBlocked}
                onClick={() => onContinue()}
              >
                Продолжить
                <ArrowRight size={16} strokeWidth={2} aria-hidden />
              </button>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
