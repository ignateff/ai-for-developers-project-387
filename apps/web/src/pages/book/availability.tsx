import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  availabilitySlots,
  availabilitySummary,
  type MeetingType,
  type Booking,
} from "../../../../../generated/sdk/client";
import "./availability.css";
import { BookingForm } from "./booking-form";
import { SlotSelection } from "./slot-selection";
import { InfoCard } from "./info-card";
import { BookingSuccess } from "./success";
import { formatDayLabel, formatTimeRange } from "./format";
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
  setName,
  setEmail,
}: {
  type: MeetingType;
  onUnknown: (attempt: Attempt) => void;
  onBack: () => void;
  name: string;
  email: string;
  setName: (value: string) => void;
  setEmail: (value: string) => void;
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
            setName={setName}
            setEmail={setEmail}
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
    <SlotSelection
      type={type}
      date={date}
      selected={selected}
      selectedSlot={selectedSlot}
      freeCount={freeCount}
      summary={summary}
      slots={slots}
      slotsBlocked={slotsBlocked}
      outdated={outdated}
      conflict={conflict}
      onBack={onBack}
      onSelectDate={(next) => {
        setDate(next);
        setSelected(null);
      }}
      onSelectSlot={setSelected}
      onContinue={() => setFormOpen(true)}
    />
  );
}
