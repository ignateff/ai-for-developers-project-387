import { useQuery } from "@tanstack/react-query";
import { Clock3 } from "lucide-react";
import { upcomingEvents } from "../../../../../generated/sdk/client";
import { formatMonthBadge, formatTimeRange } from "../book/format";
import "./events.css";

export function EventsPage() {
  const events = useQuery({
    queryKey: ["upcoming-events"],
    queryFn: async () => {
      const response = await upcomingEvents({ cache: "no-store" });
      if (response.status !== 200) throw new Error("Could not load events");
      return response.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: "always",
  });
  return (
    <section className="container events" aria-label="Предстоящие события">
      <header className="page-header events-header">
        <div>
          <h1 className="page-title">Предстоящие события</h1>
          <p className="page-subtitle">Все запланированные встречи · время в UTC</p>
        </div>
        <button
          type="button"
          className="btn btn-outline events-refresh"
          onClick={() => void events.refetch()}
          disabled={events.isFetching}
        >
          Обновить
        </button>
      </header>
      {events.isPending && (
        <p role="status" className="events-state">
          Загрузка событий…
        </p>
      )}
      {events.isError && (
        <div role="alert" className="alert">
          Не удалось загрузить события.{" "}
          <button type="button" className="btn btn-subtle" onClick={() => void events.refetch()}>
            Повторить
          </button>
        </div>
      )}
      {events.data?.length === 0 && <p className="events-state">Предстоящих событий пока нет</p>}
      <div className="events-list">
        {events.data?.map((event) => {
          const badge = formatMonthBadge(event.startsAt);
          return (
            <article key={event.id} className="card event-card">
              <div className="event-badge" aria-hidden>
                <span className="event-badge-month">{badge.month}</span>
                <span className="event-badge-day">{badge.day}</span>
              </div>
              <div className="event-body">
                <h2 className="event-name">{event.guestName}</h2>
                <p className="event-email">{event.guestEmail}</p>
                <p className="event-meta">
                  <Clock3 size={17} strokeWidth={2} aria-hidden />
                  <span>
                    {event.meetingTypeName} · {formatTimeRange(event.startsAt, event.endsAt)} · UTC
                  </span>
                </p>
              </div>
              <div className="event-status">Подтверждено</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
