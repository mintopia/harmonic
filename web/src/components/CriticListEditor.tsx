import type { EpicVerificationCritic, TaskVerificationCritic } from "../types";
import {
  CRITIC_NO_ISSUE_PLACEHOLDERS,
  DRIVE_PLACEHOLDERS,
  compileCriticPreview,
  compileEpicCriticPreview,
} from "../prompt-preview-model";
import { field } from "../ui";
import { EntryList } from "./EntryList";
import { FieldError, PromptField, fieldLabel } from "./SettingsSection";
import { EMPTY_CRITIC, criticLabel, setCriticField } from "./verification-override-model";

const EMPTY_EPIC_CRITIC: EpicVerificationCritic = { name: "", prompt: "", model: "" };

type SharedProps = {
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  /** Harness id → its discovered model ids, seeding the Model combo. */
  harnessModels: Record<string, string[]>;
  emptyText: string;
};

const runStepLabel = "mb-1.5 flex items-center gap-1.5 text-label font-semibold uppercase text-faint";

/** The "who runs it" band: reviewer harness first, then its model. The model is
 * a combo seeded from the chosen harness's discovered catalog (still free text
 * for a custom id); with no harness override it inherits the task's model. */
function CriticRuntimeFields({
  critic,
  idPrefix,
  harnessModels,
  onChange,
}: {
  critic: Pick<TaskVerificationCritic, "model" | "harness">;
  idPrefix: string;
  harnessModels: Record<string, string[]>;
  onChange: (field: "model" | "harness", value: string) => void;
}) {
  const models = critic.harness ? harnessModels[critic.harness] ?? [] : [];
  const listId = `${idPrefix}-models`;
  return (
    <div className="grid gap-3 rounded-md border border-hairline bg-sunken p-3 sm:grid-cols-2">
      <div>
        <label className={runStepLabel} htmlFor={`${idPrefix}-harness`}>
          <span className="grid size-3.5 place-items-center rounded-sm bg-raised text-[9px] text-muted">1</span>
          Harness
        </label>
        <select
          id={`${idPrefix}-harness`}
          className={field}
          value={critic.harness ?? ""}
          onChange={(e) => onChange("harness", e.target.value)}
        >
          <option value="">Same as Task</option>
          {Object.keys(harnessModels).map((harness) => (
            <option key={harness} value={harness}>
              {harness}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={runStepLabel} htmlFor={`${idPrefix}-model`}>
          <span className="grid size-3.5 place-items-center rounded-sm bg-raised text-[9px] text-muted">2</span>
          Model
        </label>
        <input
          id={`${idPrefix}-model`}
          className={`${field} font-data`}
          list={models.length > 0 ? listId : undefined}
          placeholder={critic.harness ? "" : "inherits the task's model"}
          value={critic.model}
          onChange={(e) => onChange("model", e.target.value)}
        />
        {models.length > 0 && (
          <datalist id={listId}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        )}
      </div>
    </div>
  );
}

function CriticName({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className={fieldLabel} htmlFor={id}>
        Name
      </label>
      <input
        id={id}
        className={field}
        placeholder="Untitled critic"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function CriticRowTitle({ name }: { name: string }) {
  const named = name.trim() !== "";
  return (
    <span className={`text-ink ${named ? "font-semibold" : "italic text-faint"}`}>
      {criticLabel(name)}
    </span>
  );
}

function CriticRunChip({ critic }: { critic: Pick<TaskVerificationCritic, "model" | "harness"> }) {
  return (
    <span className="hidden items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-small text-muted sm:inline-flex">
      <span className="size-1.5 rounded-full bg-tool" aria-hidden="true" />
      {critic.harness ? (
        <>
          <span className="font-semibold">{critic.harness}</span>
          {critic.model && (
            <>
              {" · "}
              <span className="font-data">{critic.model}</span>
            </>
          )}
        </>
      ) : (
        "Same as Task"
      )}
    </span>
  );
}

export function TaskCriticListEditor({
  critics,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
  emptyText,
}: SharedProps & {
  critics: TaskVerificationCritic[];
  onChange: (critics: TaskVerificationCritic[]) => void;
}) {
  return (
    <EntryList
      items={critics}
      onChange={onChange}
      groupLabel="Critics"
      addLabel="+ Add critic"
      emptyText={emptyText}
      itemNoun="critic"
      makeItem={() => EMPTY_CRITIC}
      renderTitle={(critic) => <CriticRowTitle name={critic.name} />}
      renderMeta={(critic) => <CriticRunChip critic={critic} />}
      renderBody={(critic, index, set) => {
        const previews = compileCriticPreview(critic);
        return (
          <>
            <CriticName
              id={`${idPrefix}-name-${index}`}
              value={critic.name}
              onChange={(name) => set(setCriticField(critic, "name", name))}
            />
            <CriticRuntimeFields
              critic={critic}
              idPrefix={`${idPrefix}-${index}`}
              harnessModels={harnessModels}
              onChange={(name, value) => set(setCriticField(critic, name, value))}
            />
            <FieldError message={fieldErrors[`${errorPrefix}.${index}.model`]} />
            <PromptField
              id={`${idPrefix}-issue-prompt-${index}`}
              label="Issue prompt"
              value={critic.issuePrompt}
              onChange={(value) => set(setCriticField(critic, "issuePrompt", value))}
              placeholders={DRIVE_PLACEHOLDERS}
              preview={previews[0]?.text ?? ""}
              error={fieldErrors[`${errorPrefix}.${index}.issuePrompt`]}
              rows={5}
            />
            <PromptField
              id={`${idPrefix}-no-issue-prompt-${index}`}
              label="No-issue prompt"
              value={critic.noIssuePrompt}
              onChange={(value) => set(setCriticField(critic, "noIssuePrompt", value))}
              placeholders={CRITIC_NO_ISSUE_PLACEHOLDERS}
              preview={previews[1]?.text ?? ""}
              error={fieldErrors[`${errorPrefix}.${index}.noIssuePrompt`]}
              rows={5}
            />
          </>
        );
      }}
    />
  );
}

export function EpicCriticListEditor({
  critics,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
  emptyText,
}: SharedProps & {
  critics: EpicVerificationCritic[];
  onChange: (critics: EpicVerificationCritic[]) => void;
}) {
  return (
    <EntryList
      items={critics}
      onChange={onChange}
      groupLabel="Critics"
      addLabel="+ Add critic"
      emptyText={emptyText}
      itemNoun="critic"
      makeItem={() => EMPTY_EPIC_CRITIC}
      renderTitle={(critic) => <CriticRowTitle name={critic.name} />}
      renderMeta={(critic) => <CriticRunChip critic={critic} />}
      renderBody={(critic, index, set) => (
        <>
          <CriticName
            id={`${idPrefix}-name-${index}`}
            value={critic.name}
            onChange={(name) => set({ ...critic, name })}
          />
          <CriticRuntimeFields
            critic={critic}
            idPrefix={`${idPrefix}-${index}`}
            harnessModels={harnessModels}
            onChange={(name, value) => set(setEpicCriticField(critic, name, value))}
          />
          <FieldError message={fieldErrors[`${errorPrefix}.${index}.model`]} />
          <PromptField
            id={`${idPrefix}-prompt-${index}`}
            label="Prompt"
            value={critic.prompt}
            onChange={(prompt) => set({ ...critic, prompt })}
            placeholders={DRIVE_PLACEHOLDERS}
            preview={compileEpicCriticPreview(critic.prompt)}
            error={fieldErrors[`${errorPrefix}.${index}.prompt`]}
            rows={5}
          />
        </>
      )}
    />
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
