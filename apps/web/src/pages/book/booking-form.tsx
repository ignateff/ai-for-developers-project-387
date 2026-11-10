import { useRef, useState, type FormEvent } from "react";
import { type Booking, type MeetingType } from "../../../../../generated/sdk/client";
import { isValidEmail } from "./email";
import { prepareAttempt, sendAttempt, type Attempt } from "./attempt";

export function BookingForm({
  type,
  onUnknown,
  onPendingChange,
  startsAt,
  name,
  email,
  setName,
  setEmail,
  onBack,
  onConflict,
  onTypeChanged,
  onSuccess,
}: {
  type: MeetingType;
  onUnknown: (attempt: Attempt) => void;
  onPendingChange?: (pending: boolean) => void;
  startsAt: string;
  name: string;
  email: string;
  setName: (value: string) => void;
  setEmail: (value: string) => void;
  onBack: () => void;
  onConflict: () => void;
  onTypeChanged: () => void;
  onSuccess: (booking: Booking) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  const [topic, setTopic] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const guestName = name.trim(),
      guestEmail = email.trim(),
      guestTopic = topic.trim();
    const next: Record<string, string> = {};
    if (!guestName || [...guestName].length > 100) next.guestName = "Введите имя до 100 символов";
    if (!guestEmail || [...guestEmail].length > 254 || !isValidEmail(guestEmail))
      next.guestEmail = "Введите корректный email до 254 символов";
    if ([...guestTopic].length > 500) next.topic = "Введите тему до 500 символов";
    setErrors(next);
    if (Object.keys(next).length || pendingRef.current) return;
    const input = {
      meetingTypeId: type.id,
      meetingTypeVersion: type.version,
      startsAt,
      guestName,
      guestEmail,
      ...(guestTopic ? { topic: guestTopic } : {}),
    };
    let attempt: Attempt;
    try {
      attempt = prepareAttempt(input);
    } catch {
      setError("Не удалось сохранить попытку в этой вкладке.");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    onPendingChange?.(true);
    setError("");
    try {
      const result = await sendAttempt(attempt, "initial");
      if (result.kind === "success") {
        onSuccess(result.booking);
      } else if (result.kind === "slot-unavailable") {
        onConflict();
      } else if (result.kind === "type-changed") {
        onTypeChanged();
      } else if (result.kind === "validation") {
        setErrors(result.fields);
        setError(result.message);
      } else onUnknown(attempt);
    } catch {
      onUnknown(attempt);
    } finally {
      pendingRef.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  }
  return (
    <section className="card form-card" aria-label="Подтверждение записи">
      <div className="form-card-header">
        <div>
          <h2 className="card-title">Подтверждение записи</h2>
          <p className="card-subtitle">Укажите данные участника встречи</p>
        </div>
        <button
          type="button"
          className="btn btn-outline form-change"
          aria-label="Изменить время"
          disabled={pending}
          onClick={onBack}
        >
          Изменить
        </button>
      </div>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-fields">
          <div className="field">
            <label className="field-label" htmlFor="guest-name">
              Имя
            </label>
            <input
              id="guest-name"
              className="field-input"
              placeholder="Как к вам обращаться"
              disabled={pending}
              required
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              aria-invalid={errors.guestName ? "true" : undefined}
            />
            {errors.guestName && <p className="field-error">{errors.guestName}</p>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="guest-email">
              Email
            </label>
            <input
              id="guest-email"
              className="field-input"
              placeholder="name@example.com"
              type="email"
              disabled={pending}
              required
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              aria-invalid={errors.guestEmail ? "true" : undefined}
            />
            {errors.guestEmail && <p className="field-error">{errors.guestEmail}</p>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="guest-topic">
              Что вы хотите обсудить?
            </label>
            <textarea
              id="guest-topic"
              className="field-input"
              placeholder="Опишите тему, если хотите"
              disabled={pending}
              value={topic}
              onChange={(event) => setTopic(event.currentTarget.value)}
              aria-invalid={errors.topic ? "true" : undefined}
              aria-describedby="guest-topic-warning"
            />
            <p id="guest-topic-warning" className="form-hint">
              Тема будет видна всем, кто открывает список предстоящих событий. Не указывайте
              конфиденциальные данные
            </p>
            {errors.topic && <p className="field-error">{errors.topic}</p>}
          </div>
          {error && (
            <p role="alert" className="alert form-alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-accent form-submit" disabled={pending}>
            Подтвердить запись
          </button>
          <p className="form-hint">После подтверждения сохраните детали записи.</p>
        </div>
      </form>
    </section>
  );
}
