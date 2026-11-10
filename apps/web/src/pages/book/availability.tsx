import { useState } from "react";
import { ArrowRight, CalendarDays, Check } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  availabilitySlots,
  availabilitySummary,
  type MeetingType,
  type Booking,
} from "../../../../../generated/sdk/client";
import "./availability.css";
import { BookingForm } from "./booking-form";
import { BookingCalendar } from "./calendar";
import { InfoCard } from "./info-card";
import { BookingSuccess } from "./success";
import { capitalize, formatDayLabel, formatMinutes, formatTimeRange } from "./format";
import type { Attempt } from "./attempt";

function durationOf(booking: Booking): number {
  const recorded = booking.meetingTypeDurationMinutes;
  if (Number.isFinite(recorded)) return recorded;
  return Math.round((Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60_000);
}

export function Availability({
  type,
  onUnknown,
  onBack,
  name,
  email,
  topic,
  setName,
  setEmail,
  setTopic,
}: {
  type: MeetingType;
  onUnknown: (attempt: Attempt) => void;
  onBack: () => void;
  name: string;
  email: string;
  topic: string;
  setName: (value: string) => void;
  setEmail: (value: string) => void;
  setTopic: (value: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [bookingPending, setBookingPending] = useState(false);
  const [confirmation, setConfirmation] = useState<Booking | null>(null);
  const [conflict, setConflict] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [staleSlots, setStaleSlots] = useState<Record<string, unknown>>({});
  const summary = useQuery({
    queryKey: ["availability", type.id],
    queryFn: async () => {
      const response = await availabilitySummary(type.id);
      if (response.status === 404) throw new Error("TYPE_REMOVED");
      if (response.status !== 200) throw new Error("Could not load availability");
      return response.data;
    },
  });
  const slots = useQuery({
    queryKey: ["slots", type.id, date],
    enabled: date !== null,
    structuralSharing: false,
    retry: false,
    queryFn: async () => {
      const response = await availabilitySlots(type.id, { date: date! });
      if (response.status === 404) throw new Error("TYPE_REMOVED");
      if (response.status !== 200) throw new Error("Could not load slots");
      return response.data;
    },
  });
  const slotsBlocked = Boolean(
    date &&
    Object.hasOwn(staleSlots, date) &&
    (slots.isFetching || slots.isError || slots.data === staleSlots[date]),
  );
  const removed =
    summary.error?.message === "TYPE_REMOVED" || slots.error?.message === "TYPE_REMOVED";
  const outdated = Boolean(
    removed ||
    (summary.data && summary.data.version !== type.version) ||
    (slots.data && slots.data.version !== type.version),
  );
  const selectedSlot = slots.data?.slots.find((slot) => slot.startsAt === selected) ?? null;
  const freeCount = date
    ? (summary.data?.days.find((day) => day.date === date)?.availableCount ?? null)
    : null;
  if (confirmation)
    return (
      <section className="container booking" aria-label="Запись подтверждена">
        <header className="page-header">
          <h1 className="page-title">Запись на звонок</h1>
          <p className="page-subtitle">Детали вашей встречи</p>
        </header>
        <div className="booking-grid booking-grid-details">
          <InfoCard
            dateLabel={formatDayLabel(confirmation.startsAt.slice(0, 10))}
            timeLabel={formatTimeRange(confirmation.startsAt, confirmation.endsAt)}
            durationMinutes={durationOf(confirmation)}
          />
          <BookingSuccess
            typeName={confirmation.meetingTypeName}
            startsAt={confirmation.startsAt}
            endsAt={confirmation.endsAt}
            againLabel="Забронировать ещё"
            onAgain={onBack}
          />
        </div>
      </section>
    );
  if (formOpen && selected)
    return (
      <section className="container booking" aria-label="Подтверждение записи">
        <button
          type="button"
          className="btn btn-subtle booking-back"
          disabled={bookingPending}
          onClick={onBack}
        >
          ← Выбрать другой тип
        </button>
        <header className="page-header">
          <h1 className="page-title">Запись на звонок</h1>
          <p className="page-subtitle">Проверьте детали и оставьте свои данные</p>
        </header>
        {conflict && (
          <p role="alert" className="alert">
            {conflict}
          </p>
        )}
        <div className="booking-grid booking-grid-details">
          <InfoCard
            dateLabel={formatDayLabel(selected.slice(0, 10))}
            timeLabel={
              selectedSlot ? formatTimeRange(selectedSlot.startsAt, selectedSlot.endsAt) : null
            }
            durationMinutes={type.durationMinutes}
          />
          <BookingForm
            type={type}
            onUnknown={onUnknown}
            onPendingChange={setBookingPending}
            startsAt={selected}
            name={name}
            email={email}
            topic={topic}
            setName={setName}
            setEmail={setEmail}
            setTopic={setTopic}
            onBack={() => setFormOpen(false)}
            onSuccess={setConfirmation}
            onTypeChanged={() => {
              setFormOpen(false);
              setSelected(null);
              setConflict("Тип встречи изменился. Выберите актуальный тип заново.");
              void summary.refetch();
            }}
            onConflict={() => {
              setFormOpen(false);
              setSelected(null);
              setConflict("Слот уже недоступен. Выберите другое время.");
              if (date) setStaleSlots((previous) => ({ ...previous, [date]: slots.data }));
              void slots.refetch();
              void summary.refetch();
            }}
          />
        </div>
      </section>
    );
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
                setDate(next);
                setSelected(null);
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
                      onClick={() => setSelected(slot.startsAt)}
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
                onClick={() => setFormOpen(true)}
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
