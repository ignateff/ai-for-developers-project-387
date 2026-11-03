import { useState } from "react";
import { type Booking } from "../../../../../generated/sdk/client";
import { clearAttempt, sendAttempt, type Attempt } from "./attempt";
import { BookingSuccess } from "./success";

export function Recovery({ attempt, onDone }: { attempt: Attempt; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [message, setMessage] = useState("");
  const [rejected, setRejected] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);
  async function retry() {
    setPending(true);
    setMessage("");
    try {
      const result = await sendAttempt(attempt, "retry");
      if (result.kind === "success") {
        setBooking(result.booking);
      } else if (result.kind === "rejected") {
        setRejected(true);
        setMessage(`${result.message} Начните новую попытку.`);
      } else setMessage("Результат неизвестен. Повторите попытку или осознанно забудьте её.");
    } catch {
      setMessage("Результат неизвестен. Повторите попытку или осознанно забудьте её.");
    } finally {
      setPending(false);
    }
  }
  if (booking)
    return (
      <section className="container booking" aria-label="Запись подтверждена">
        <header className="page-header">
          <h1 className="page-title">Запись на звонок</h1>
          <p className="page-subtitle">Детали вашей встречи</p>
        </header>
        <div className="booking-grid booking-grid-details">
          <BookingSuccess
            typeName={booking.meetingTypeName}
            startsAt={booking.startsAt}
            endsAt={booking.endsAt}
            againLabel="Записаться ещё"
            onAgain={onDone}
          />
        </div>
      </section>
    );
  return (
    <section className="container booking" aria-label="Незавершённая попытка записи">
      <header className="page-header">
        <h1 className="page-title">Запись на звонок</h1>
      </header>
      <div className="card recovery-card">
        <h2 className="card-title">Незавершённая попытка записи</h2>
        <p className="recovery-text">
          Результат неизвестен. Повтор может впервые создать запись, если первый запрос не дошёл.
        </p>
        <p className="recovery-attempt">
          {attempt.input.startsAt} UTC · {attempt.input.guestName} · {attempt.input.guestEmail}
        </p>
        {message && (
          <p role="alert" className="alert recovery-alert">
            {message}
          </p>
        )}
        {!rejected ? (
          <div className="recovery-actions">
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => void retry()}
              disabled={pending}
            >
              Повторить попытку
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={pending}
              onClick={() => setConfirmForget(true)}
            >
              Забыть попытку
            </button>
            {confirmForget && (
              <>
                <p className="recovery-warning">
                  Запись может существовать и не отменяется. Новая попытка может создать вторую
                  запись.
                </p>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={pending}
                  onClick={() => {
                    clearAttempt();
                    onDone();
                  }}
                >
                  Подтвердить забывание
                </button>
                <button
                  type="button"
                  className="btn btn-subtle"
                  onClick={() => setConfirmForget(false)}
                >
                  Назад
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="recovery-actions">
            <button type="button" className="btn btn-accent" onClick={onDone}>
              Начать заново
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
