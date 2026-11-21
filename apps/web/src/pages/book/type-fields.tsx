export type TypeDraft = { name: string; description: string; duration: string };

export function TypeFields({
  idPrefix,
  labels,
  draft,
  onChange,
  errors,
}: {
  idPrefix: string;
  labels: TypeDraft;
  draft: TypeDraft;
  onChange: (draft: TypeDraft) => void;
  errors: Record<string, string>;
}) {
  return (
    <>
      {(["name", "description", "duration"] as const).map((field) => {
        const props = {
          id: `${idPrefix}-${field}`,
          className: "field-input",
          value: draft[field],
          onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onChange({ ...draft, [field]: event.currentTarget.value }),
          "aria-invalid": errors[field] ? ("true" as const) : undefined,
          required: true,
        };
        return (
          <div className="field" key={field}>
            <label className="field-label" htmlFor={props.id}>
              {labels[field]}
            </label>
            {field === "description" ? (
              <textarea {...props} />
            ) : (
              <input {...props} type={field === "duration" ? "number" : "text"} />
            )}
            {errors[field] && <p className="field-error">{errors[field]}</p>}
          </div>
        );
      })}
    </>
  );
}
import type { ChangeEvent } from "react";
