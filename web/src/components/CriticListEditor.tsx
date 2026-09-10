import type { EpicVerificationCritic, TaskVerificationCritic } from "../types";
import {
  CRITIC_NO_ISSUE_PLACEHOLDERS,
  DRIVE_PLACEHOLDERS,
  compileCriticPreview,
  compileEpicCriticPreview,
} from "../prompt-preview-model";
import { field } from "../ui";
import { FieldError, PromptField, fieldLabel } from "./SettingsSection";
import { EMPTY_CRITIC, setCriticField } from "./verification-override-model";

const EMPTY_EPIC_CRITIC: EpicVerificationCritic = { prompt: "", model: "" };

type SharedProps = {
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  harnesses: string[];
  emptyText: string;
};

function CriticRuntimeFields({
  critic,
  idPrefix,
  onChange,
  harnesses,
}: {
  critic: Pick<TaskVerificationCritic, "model" | "harness">;
  idPrefix: string;
  onChange: (field: "model" | "harness", value: string) => void;
  harnesses: string[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={fieldLabel} htmlFor={`${idPrefix}-model`}>
          Model
        </label>
        <input
          id={`${idPrefix}-model`}
          className={field}
          value={critic.model}
          onChange={(e) => onChange("model", e.target.value)}
        />
      </div>
      <div>
        <label className={fieldLabel} htmlFor={`${idPrefix}-harness`}>
          Harness
        </label>
        <select
          id={`${idPrefix}-harness`}
          className={field}
          value={critic.harness ?? ""}
          onChange={(e) => onChange("harness", e.target.value)}
        >
          <option value="">Same as Task</option>
          {harnesses.map((harness) => (
            <option key={harness} value={harness}>
              {harness}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function TaskCriticListEditor({
  critics,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnesses,
  emptyText,
}: SharedProps & {
  critics: TaskVerificationCritic[];
  onChange: (critics: TaskVerificationCritic[]) => void;
}) {
  const setCritic = (index: number, critic: TaskVerificationCritic) =>
    onChange(critics.map((current, i) => (i === index ? critic : current)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>Critics</span>
        <button
          type="button"
          className="text-small font-semibold text-accent hover:text-accent-hot"
          onClick={() => onChange([...critics, EMPTY_CRITIC])}
        >
          + Add critic
        </button>
      </div>
      {critics.length === 0 ? (
        <p className="text-small text-muted">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {critics.map((critic, index) => {
            const previews = compileCriticPreview(critic);
            return (
              <div
                key={index}
                className="flex flex-col gap-3 rounded-md border border-hairline bg-raised p-4"
              >
                <div className="flex items-center justify-between">
                  <span className={fieldLabel}>Critic {index + 1}</span>
                  <button
                    type="button"
                    className="text-small text-fail hover:opacity-80"
                    onClick={() =>
                      onChange(critics.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
                <PromptField
                  id={`${idPrefix}-issue-prompt-${index}`}
                  label="Issue prompt"
                  value={critic.issuePrompt}
                  onChange={(value) =>
                    setCritic(
                      index,
                      setCriticField(critic, "issuePrompt", value),
                    )
                  }
                  placeholders={DRIVE_PLACEHOLDERS}
                  preview={previews[0]?.text ?? ""}
                  error={fieldErrors[`${errorPrefix}.${index}.issuePrompt`]}
                  rows={5}
                />
                <PromptField
                  id={`${idPrefix}-no-issue-prompt-${index}`}
                  label="No-issue prompt"
                  value={critic.noIssuePrompt}
                  onChange={(value) =>
                    setCritic(
                      index,
                      setCriticField(critic, "noIssuePrompt", value),
                    )
                  }
                  placeholders={CRITIC_NO_ISSUE_PLACEHOLDERS}
                  preview={previews[1]?.text ?? ""}
                  error={fieldErrors[`${errorPrefix}.${index}.noIssuePrompt`]}
                  rows={5}
                />
                <CriticRuntimeFields
                  critic={critic}
                  idPrefix={`${idPrefix}-${index}`}
                  harnesses={harnesses}
                  onChange={(name, value) =>
                    setCritic(index, setCriticField(critic, name, value))
                  }
                />
                <FieldError
                  message={fieldErrors[`${errorPrefix}.${index}.model`]}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function EpicCriticListEditor({
  critics,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnesses,
  emptyText,
}: SharedProps & {
  critics: EpicVerificationCritic[];
  onChange: (critics: EpicVerificationCritic[]) => void;
}) {
  const setCritic = (index: number, critic: EpicVerificationCritic) =>
    onChange(critics.map((current, i) => (i === index ? critic : current)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>Critics</span>
        <button
          type="button"
          className="text-small font-semibold text-accent hover:text-accent-hot"
          onClick={() => onChange([...critics, EMPTY_EPIC_CRITIC])}
        >
          + Add critic
        </button>
      </div>
      {critics.length === 0 ? (
        <p className="text-small text-muted">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {critics.map((critic, index) => (
            <div
              key={index}
              className="flex flex-col gap-3 rounded-md border border-hairline bg-raised p-4"
            >
              <div className="flex items-center justify-between">
                <span className={fieldLabel}>Critic {index + 1}</span>
                <button
                  type="button"
                  className="text-small text-failed"
                  onClick={() =>
                    onChange(critics.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              </div>
              <PromptField
                id={`${idPrefix}-prompt-${index}`}
                label="Prompt"
                value={critic.prompt}
                onChange={(prompt) => setCritic(index, { ...critic, prompt })}
                placeholders={DRIVE_PLACEHOLDERS}
                preview={compileEpicCriticPreview(critic.prompt)}
                error={fieldErrors[`${errorPrefix}.${index}.prompt`]}
                rows={5}
              />
              <CriticRuntimeFields
                critic={critic}
                idPrefix={`${idPrefix}-${index}`}
                harnesses={harnesses}
                onChange={(name, value) =>
                  setCritic(index, setEpicCriticField(critic, name, value))
                }
              />
              <FieldError
                message={fieldErrors[`${errorPrefix}.${index}.model`]}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function setEpicCriticField(
  critic: EpicVerificationCritic,
  field: "model" | "harness",
  value: string,
): EpicVerificationCritic {
  if (field === "harness" && value === "") {
    const { harness: _harness, ...rest } = critic;
    return rest;
  }
  return { ...critic, [field]: value };
}
