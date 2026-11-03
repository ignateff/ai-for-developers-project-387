import { Modal } from "@mantine/core";
import { validateType } from "./validate-type";
import { useState, type FormEvent } from "react";
import {
  meetingTypeResourceRemove,
  meetingTypeResourceUpdate,
  meetingTypesList,
  type MeetingType,
} from "../../../../../generated/sdk/client";

export function ManageType({ type, refresh }: { type: MeetingType; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const [duration, setDuration] = useState(String(type.durationMinutes));
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [version, setVersion] = useState(type.version);
  const [conflict, setConflict] = useState(false);
  async function refreshVersion() {
    setPending(true);
    try {
      const response = await meetingTypesList();
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
      setError("Не удалось обновить версию. Попробуйте ещё раз.");
    } finally {
      setPending(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const {
      cleanName,
      cleanDescription,
      minutes,
      fields: next,
    } = validateType(name, description, duration);
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
        setEditing(false);
        refresh();
      } else if (response.status === 412 || response.status === 404) {
        setConflict(true);
        setError("Тип встречи изменился или удалён. Обновите версию, сохранив черновик.");
      } else setError("Не удалось сохранить изменения. Попробуйте ещё раз.");
    } catch {
      setError("Не удалось сохранить изменения. Попробуйте ещё раз.");
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    setPending(true);
    setError("");
    try {
      const response = await meetingTypeResourceRemove(type.id, {
        headers: { "If-Match": `"${type.version}"` },
      });
      if (response.status === 204) {
        setConfirm(false);
        refresh();
      } else if (response.status === 412 || response.status === 404) {
        setConfirm(false);
        setError("Тип встречи изменился или удалён. Список обновлён.");
        refresh();
      } else setError("Не удалось удалить тип. Попробуйте ещё раз.");
    } catch {
      setError("Не удалось удалить тип. Попробуйте ещё раз.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="type-manage">
      {!confirm && (
        <>
          <button
            type="button"
            className="btn btn-subtle"
            aria-describedby={`meeting-type-${type.id}`}
            onClick={() => {
              setError("");
              setVersion(type.version);
              setConflict(false);
              setFields({});
              setName(type.name);
              setDescription(type.description);
              setDuration(String(type.durationMinutes));
              setEditing(true);
            }}
          >
            Изменить
          </button>
          <button
            type="button"
            className="btn btn-danger"
            aria-describedby={`meeting-type-${type.id}`}
            onClick={() => setConfirm(true)}
          >
            Удалить
          </button>
        </>
      )}
      <Modal opened={editing} onClose={() => setEditing(false)} title={`Изменить ${type.name}`}>
        <form className="type-manage-form" onSubmit={(event) => void save(event)} noValidate>
          <div className="field">
            <label className="field-label" htmlFor={`edit-name-${type.id}`}>
              Название типа
            </label>
            <input
              id={`edit-name-${type.id}`}
              className="field-input"
              required
              aria-invalid={fields.name ? "true" : undefined}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            {fields.name && <p className="field-error">{fields.name}</p>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`edit-description-${type.id}`}>
              Описание типа
            </label>
            <textarea
              id={`edit-description-${type.id}`}
              className="field-input"
              required
              aria-invalid={fields.description ? "true" : undefined}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
            {fields.description && <p className="field-error">{fields.description}</p>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`edit-duration-${type.id}`}>
              Длительность типа в минутах
            </label>
            <input
              id={`edit-duration-${type.id}`}
              className="field-input"
              type="number"
              required
              aria-invalid={fields.duration ? "true" : undefined}
              value={duration}
              onChange={(event) => setDuration(event.currentTarget.value)}
            />
            {fields.duration && <p className="field-error">{fields.duration}</p>}
          </div>
          <div className="type-manage">
            <button type="submit" className="btn btn-accent" disabled={pending || conflict}>
              Сохранить
            </button>
            <button type="button" className="btn btn-subtle" onClick={() => setEditing(false)}>
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
      {confirm && (
        <div>
          <p className="recovery-text">
            Удалить тип «{type.name}»? Новые записи станут недоступны, существующие сохранятся.
          </p>
          <div className="type-manage type-manage-confirm">
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={() => void remove()}
            >
              Подтвердить удаление
            </button>
            <button type="button" className="btn btn-subtle" onClick={() => setConfirm(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {error && !editing && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
