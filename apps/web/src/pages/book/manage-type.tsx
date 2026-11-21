import { Modal } from "@mantine/core";
import { validateType } from "./validate-type";
import { TypeFields } from "./type-fields";
import { useRef, useState, type FormEvent } from "react";
import {
  meetingTypeResourceRemove,
  meetingTypeResourceUpdate,
  meetingTypesList,
  type MeetingType,
} from "../../../../../generated/sdk/client";

export type DeleteOutcome = "deleted" | "missing";

export const STALE_TYPE_NOTICE = "Тип встречи изменился или удалён. Список обновлён.";

export function ManageType({
  type,
  refresh,
  onDeleteOutcome,
}: {
  type: MeetingType;
  refresh: () => void;
  onDeleteOutcome: (outcome: DeleteOutcome) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState({
    name: type.name,
    description: type.description,
    duration: String(type.durationMinutes),
  });
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState("");
  const removeButton = useRef<HTMLButtonElement>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [version, setVersion] = useState(type.version);
  const [conflict, setConflict] = useState(false);
  const dialogSession = useRef(0);
  function closeEditor() {
    dialogSession.current++;
    setEditing(false);
  }
  async function refreshVersion() {
    const session = dialogSession.current;
    setPending(true);
    try {
      const response = await meetingTypesList();
      if (session !== dialogSession.current) return;
      if (response.status !== 200) throw new Error("Could not load meeting types");
      const latest = response.data.find((item) => item.id === type.id);
      if (!latest) {
        setError("Тип встречи удалён. Скопируйте введённые данные и закройте окно.");
      } else {
        setVersion(latest.version);
        setConflict(false);
        setError("Версия обновлена. Проверьте данные перед сохранением.");
      }
    } catch {
      if (session === dialogSession.current)
        setError("Не удалось обновить версию. Попробуйте ещё раз.");
    } finally {
      if (session === dialogSession.current) setPending(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const session = dialogSession.current;
    const {
      cleanName,
      cleanDescription,
      minutes,
      fields: next,
    } = validateType(draft.name, draft.description, draft.duration);
    setFields(next);
    if (Object.keys(next).length) return;
    setPending(true);
    setError("");
    try {
      const response = await meetingTypeResourceUpdate(
        type.id,
        { name: cleanName, description: cleanDescription, durationMinutes: minutes },
        { headers: { "If-Match": `"${version}"` } },
      );
      if (response.status === 200) {
        if (session === dialogSession.current) closeEditor();
        refresh();
      } else if (session !== dialogSession.current) return;
      else if (response.status === 412 || response.status === 404) {
        setConflict(true);
        setError("Тип встречи изменился или удалён. Обновите версию, сохранив черновик.");
      } else setError("Не удалось сохранить изменения. Попробуйте ещё раз.");
    } catch {
      if (session === dialogSession.current)
        setError("Не удалось сохранить изменения. Попробуйте ещё раз.");
    } finally {
      if (session === dialogSession.current) setPending(false);
    }
  }
  function closeConfirm() {
    setConfirm(false);
    removeButton.current?.focus();
  }
  async function remove() {
    setDeletePending(true);
    setDeleteError("");
    try {
      const response = await meetingTypeResourceRemove(type.id, {
        headers: { "If-Match": `"${type.version}"` },
      });
      if (response.status === 204) {
        setConfirm(false);
        onDeleteOutcome("deleted");
      } else if (response.status === 412 || response.status === 404) {
        if (response.status === 412) {
          closeConfirm();
          setDeleteNotice(STALE_TYPE_NOTICE);
          refresh();
        } else {
          setConfirm(false);
          onDeleteOutcome("missing");
        }
      } else setDeleteError("Не удалось удалить тип. Попробуйте ещё раз.");
    } catch {
      setDeleteError("Не удалось удалить тип. Попробуйте ещё раз.");
    } finally {
      setDeletePending(false);
    }
  }
  return (
    <div className="type-manage">
      <button
        type="button"
        className="btn btn-subtle"
        aria-describedby={`meeting-type-${type.id}`}
        onClick={() => {
          dialogSession.current++;
          setPending(false);
          setError("");
          setVersion(type.version);
          setConflict(false);
          setFields({});
          setDraft({
            name: type.name,
            description: type.description,
            duration: String(type.durationMinutes),
          });
          setEditing(true);
        }}
      >
        Изменить
      </button>
      <button
        type="button"
        ref={removeButton}
        className="btn btn-danger"
        aria-describedby={`meeting-type-${type.id}`}
        onClick={() => {
          setError("");
          setDeleteError("");
          setDeleteNotice("");
          setConflict(false);
          setConfirm(true);
        }}
      >
        Удалить
      </button>
      <Modal opened={editing} onClose={closeEditor} title={`Изменить ${type.name}`}>
        <form className="type-manage-form" onSubmit={(event) => void save(event)} noValidate>
          <TypeFields
            idPrefix={`edit-${type.id}`}
            labels={{
              name: "Название типа",
              description: "Описание типа",
              duration: "Длительность типа в минутах",
            }}
            draft={draft}
            onChange={setDraft}
            errors={fields}
          />
          <div className="type-manage">
            <button type="submit" className="btn btn-accent" disabled={pending || conflict}>
              Сохранить
            </button>
            <button type="button" className="btn btn-subtle" onClick={closeEditor}>
              Отмена
            </button>
          </div>
        </form>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {conflict && (
          <button
            type="button"
            className="btn btn-subtle"
            disabled={pending}
            onClick={() => void refreshVersion()}
          >
            Обновить версию
          </button>
        )}
      </Modal>
      <Modal
        opened={confirm}
        onClose={() => {
          if (!deletePending) closeConfirm();
        }}
        returnFocus={false}
        title="Удалить тип встречи"
      >
        <p className="recovery-text">
          Удалить тип «{type.name}»? Новые записи станут недоступны, существующие сохранятся.
        </p>
        {deleteError && (
          <p role="alert" className="field-error">
            {deleteError}
          </p>
        )}
        <div className="type-manage">
          <button
            type="button"
            className="btn btn-danger"
            disabled={deletePending}
            onClick={() => void remove()}
          >
            Подтвердить удаление
          </button>
          <button
            type="button"
            className="btn btn-subtle"
            disabled={deletePending}
            onClick={closeConfirm}
          >
            Отмена
          </button>
        </div>
      </Modal>
      {deleteNotice && (
        <p role="alert" className="field-error">
          {deleteNotice}
        </p>
      )}
    </div>
  );
}
