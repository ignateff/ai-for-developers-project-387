import { Modal } from "@mantine/core";
import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { meetingTypesCreate, meetingTypesList } from "../../../../../generated/sdk/client";

import { validateType } from "./validate-type";
import { TypeFields } from "./type-fields";
import { ManageType, STALE_TYPE_NOTICE, type DeleteOutcome } from "./manage-type";

export function AdminTypesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const dialogSession = useRef(0);
  const [draft, setDraft] = useState({ name: "", description: "", duration: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: ["meeting-types"],
    retry: false,
    queryFn: async () => {
      const response = await meetingTypesList();
      if (response.status !== 200) throw new Error("Could not load meeting types");
      return response.data;
    },
  });
  const create = useMutation({
    mutationFn: async ({
      session: _session,
      ...input
    }: {
      name: string;
      description: string;
      durationMinutes: number;
      session: number;
    }) => {
      const response = await meetingTypesCreate(input);
      if (response.status !== 201) throw new Error("Could not create meeting type");
      return response.data;
    },
    onSuccess: async (_data, input) => {
      if (input.session === dialogSession.current) {
        closeCreator();
        setDraft({ name: "", description: "", duration: "" });
      }
      await queryClient.invalidateQueries({ queryKey: ["meeting-types"] });
    },
  });
  function closeCreator() {
    dialogSession.current++;
    setCreating(false);
  }
  function handleDeleteOutcome(outcome: DeleteOutcome) {
    if (outcome === "missing") setDeleteNotice(STALE_TYPE_NOTICE);
    void list.refetch().finally(() => addButton.current?.focus());
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const {
      cleanName,
      cleanDescription,
      minutes: durationMinutes,
      fields: next,
    } = validateType(draft.name, draft.description, draft.duration);
    setErrors(next);
    if (!Object.keys(next).length)
      create.mutate({
        name: cleanName,
        description: cleanDescription,
        durationMinutes,
        session: dialogSession.current,
      });
  }
  return (
    <section className="container booking" aria-label="Типы встреч">
      <header className="page-header">
        <h1 className="page-title">Типы встреч</h1>
        <p className="page-subtitle">Управляйте доступными форматами встреч</p>
      </header>
      <button
        type="button"
        ref={addButton}
        className="btn btn-accent admin-add"
        onClick={() => {
          dialogSession.current++;
          setErrors({});
          create.reset();
          setCreating(true);
        }}
      >
        Добавить тип встречи
      </button>
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
        <div className="type-empty">
          <p>Пока нет типов встреч</p>
          <p>Добавьте первый тип встречи, чтобы гости могли записаться.</p>
        </div>
      )}
      {deleteNotice && (
        <div role="alert" className="alert">
          {deleteNotice}{" "}
          <button type="button" className="btn btn-subtle" onClick={() => setDeleteNotice("")}>
            Понятно
          </button>
        </div>
      )}
      <div className="type-list">
        {!list.isError &&
          list.data?.map((item) => (
            <article key={item.id} className="card">
              <h2 id={`meeting-type-${item.id}`} className="type-card-name">
                {item.name}
              </h2>
              <p className="type-card-description">{item.description}</p>
              <p className="type-card-duration">{item.durationMinutes} мин.</p>
              <div className="type-card-actions">
                <ManageType
                  type={item}
                  refresh={() => {
                    void list.refetch();
                  }}
                  onDeleteOutcome={handleDeleteOutcome}
                />
              </div>
            </article>
          ))}
        <Modal opened={creating} onClose={closeCreator} title="Создать тип встречи">
          <form onSubmit={submit} noValidate>
            <div className="form-fields">
              <TypeFields
                idPrefix="type"
                labels={{
                  name: "Название",
                  description: "Описание",
                  duration: "Длительность в минутах",
                }}
                draft={draft}
                onChange={setDraft}
                errors={errors}
              />
              {create.isError && (
                <p role="alert" className="alert form-alert">
                  Не удалось создать тип встречи. Попробуйте ещё раз.
                </p>
              )}
              <div>
                <button type="submit" className="btn btn-accent" disabled={create.isPending}>
                  Создать тип
                </button>
                <button type="button" className="btn btn-subtle" onClick={closeCreator}>
                  Отмена
                </button>
              </div>
            </div>
          </form>
        </Modal>
      </div>
    </section>
  );
}
