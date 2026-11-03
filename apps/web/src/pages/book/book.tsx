import { ArrowRight, Clock3, UserRound } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { meetingTypesList, type MeetingType } from "../../../../../generated/sdk/client";

import { Availability } from "./availability";
import { loadAttempt, type Attempt } from "./attempt";
import { Recovery } from "./recovery";

export function BookPage() {
  const [attempt, setAttempt] = useState<Attempt | null>(loadAttempt);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [selectedType, setSelectedType] = useState<MeetingType | null>(null);
  const list = useQuery({
    queryKey: ["meeting-types"],
    retry: false,
    queryFn: async () => {
      const response = await meetingTypesList();
      if (response.status !== 200) throw new Error("Could not load meeting types");
      return response.data;
    },
  });
  if (attempt)
    return (
      <Recovery
        attempt={attempt}
        onDone={() => {
          setAttempt(null);
          setSelectedType(null);
        }}
      />
    );
  if (selectedType)
    return (
      <Availability
        onUnknown={setAttempt}
        name={guestName}
        email={guestEmail}
        setName={setGuestName}
        setEmail={setGuestEmail}
        type={selectedType}
        onBack={() => {
          setSelectedType(null);
          void list.refetch();
        }}
      />
    );
  return (
    <section className="container booking guest-type-list" aria-label="Типы встреч">
      <header className="card guest-intro">
        <div className="guest-host">
          <span className="guest-avatar">
            <UserRound size={24} />
          </span>
          <span>
            <strong>Host</strong>
            <small>Организатор</small>
          </span>
        </div>
        <h1>Выберите тип встречи</h1>
        <p>Выберите встречу, чтобы открыть календарь и найти удобное время.</p>
      </header>
      {list.isPending && <p className="type-empty">Загрузка типов встреч…</p>}
      {list.isError && (
        <div role="alert" className="alert">
          Не удалось загрузить типы встреч.{" "}
          <button type="button" className="btn btn-subtle" onClick={() => void list.refetch()}>
            Повторить
          </button>
        </div>
      )}
      {!list.isError && list.data?.length === 0 && (
        <p className="type-empty">Пока нет типов встреч</p>
      )}
      <div className="type-list guest-types">
        {!list.isError &&
          list.data?.map((item) => (
            <article key={item.id} className="card guest-type-card">
              <h2 className="type-card-name">{item.name}</h2>
              <p className="type-card-description">{item.description}</p>
              <p className="type-card-duration">
                <Clock3 size={17} /> {item.durationMinutes} мин.{" "}
                <ArrowRight className="guest-arrow" size={20} />
              </p>
              <button
                type="button"
                className="guest-card-button"
                aria-label={`Выбрать ${item.name}`}
                onClick={() => setSelectedType(item)}
              />
            </article>
          ))}
      </div>
    </section>
  );
}
