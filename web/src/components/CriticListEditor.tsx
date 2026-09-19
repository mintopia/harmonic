import type {
  EpicCriticOverlayEntry,
  EpicVerificationCritic,
  TaskCriticOverlayEntry,
  TaskVerificationCritic,
} from "../types";
import {
  CRITIC_NO_ISSUE_PLACEHOLDERS,
  DRIVE_PLACEHOLDERS,
  compileCriticPreview,
  compileEpicCriticPreview,
} from "../prompt-preview-model";
import { chip, field } from "../ui";
import { EntryList } from "./EntryList";
import { Switch } from "./Switch";
import { FieldError, PromptField, fieldLabel } from "./SettingsSection";
import {
  criticLabel,
  newCritic,
  newEpicCritic,
  setCriticField,
  setEpicCriticField,
  summarizeCritic,
  withMissingGlobals,
} from "./verification-override-model";

const globalChip = `${chip} bg-raised text-muted`;

type SharedProps = {
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  harnessModels: Record<string, string[]>;
  emptyText: string;
};

const runStepLabel = "mb-1.5 flex items-center gap-1.5 text-label font-semibold uppercase text-faint";

function CriticRuntimeFields({
  critic,
  idPrefix,
  harnessModels,
  onChange,
}: {
  critic: Pick<TaskVerificationCritic, "model" | "harness" | "timeoutSeconds">;
  idPrefix: string;
  harnessModels: Record<string, string[]>;
  onChange: (field: "model" | "harness" | "timeoutSeconds", value: string) => void;
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
      <div>
        <label className={runStepLabel} htmlFor={`${idPrefix}-timeout`}>
          <span className="grid size-3.5 place-items-center rounded-sm bg-raised text-[9px] text-muted">3</span>
          Timeout <span className="font-normal normal-case tracking-normal text-muted">s</span>
        </label>
        <input
          id={`${idPrefix}-timeout`}
          type="number"
          min={1}
          className={`${field} tabular-nums`}
          value={critic.timeoutSeconds}
          onChange={(e) => onChange("timeoutSeconds", e.target.value)}
        />
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

/** The editable fields for one task critic, shared by the global editor and a workspace overlay's local rows. */
function TaskCriticFields({
  critic,
  index,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
  set,
}: {
  critic: TaskVerificationCritic;
  index: number;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  harnessModels: Record<string, string[]>;
  set: (critic: TaskVerificationCritic) => void;
}) {
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
}

/** The epic-critic counterpart of {@link TaskCriticFields}: same shared-body
 * role, over the epic critic's single `prompt`. */
function EpicCriticFields({
  critic,
  index,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
  set,
}: {
  critic: EpicVerificationCritic;
  index: number;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  harnessModels: Record<string, string[]>;
  set: (critic: EpicVerificationCritic) => void;
}) {
  return (
    <>
      <CriticName
        id={`${idPrefix}-name-${index}`}
        value={critic.name}
        onChange={(name) => set(setEpicCriticField(critic, "name", name))}
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
        onChange={(prompt) => set(setEpicCriticField(critic, "prompt", prompt))}
        placeholders={DRIVE_PLACEHOLDERS}
        preview={compileEpicCriticPreview(critic.prompt)}
        error={fieldErrors[`${errorPrefix}.${index}.prompt`]}
        rows={5}
      />
    </>
  );
}

/** A locked global critic row's read-only summary, shared by the task and
 * epic overlay editors. */
function LockedCriticSummary({ critic }: { critic: Pick<TaskVerificationCritic, "name" | "harness" | "model"> }) {
  return (
    <div className="space-y-1 text-small text-muted">
      <p>Managed globally — edit it in Global settings.</p>
      <p className="text-ink">{summarizeCritic(critic)}</p>
    </div>
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
      makeItem={newCritic}
      renderTitle={(critic) => <CriticRowTitle name={critic.name} />}
      renderMeta={(critic) => <CriticRunChip critic={critic} />}
      renderBody={(critic, index, set) => (
        <TaskCriticFields
          critic={critic}
          index={index}
          idPrefix={idPrefix}
          errorPrefix={errorPrefix}
          fieldErrors={fieldErrors}
          harnessModels={harnessModels}
          set={set}
        />
      )}
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
      makeItem={newEpicCritic}
      renderTitle={(critic) => <CriticRowTitle name={critic.name} />}
      renderMeta={(critic) => <CriticRunChip critic={critic} />}
      renderBody={(critic, index, set) => (
        <EpicCriticFields
          critic={critic}
          index={index}
          idPrefix={idPrefix}
          errorPrefix={errorPrefix}
          fieldErrors={fieldErrors}
          harnessModels={harnessModels}
          set={set}
        />
      )}
    />
  );
}

/**
 * The Workspace-scope, additive task-critic editor (ADR-0037): global rows
 * locked/reorderable/disable-able, local rows fully editable, in overlay
 * order. Mirrors {@link CommandOverlayEditor}.
 */
export function TaskCriticOverlayEditor({
  overlay,
  globals,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
  emptyText,
}: SharedProps & {
  overlay: TaskCriticOverlayEntry[] | null;
  globals: TaskVerificationCritic[];
  onChange: (overlay: TaskCriticOverlayEntry[]) => void;
}) {
  const globalById = new Map(globals.map((g) => [g.id, g]));
  const rows = withMissingGlobals<TaskCriticOverlayEntry>(
    overlay,
    globals.map((g) => g.id),
  );
  const setEnabled = (index: number, enabled: boolean) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, enabled } : row)));

  return (
    <EntryList
      items={rows}
      onChange={onChange}
      groupLabel="Critics"
      addLabel="+ Add critic"
      emptyText={emptyText}
      itemNoun="critic"
      makeItem={() => ({ kind: "local" as const, enabled: true, critic: newCritic() })}
      isLocked={(entry) => entry.kind === "global"}
      canRemoveLocked={(entry) => entry.kind === "global" && !globalById.has(entry.ref)}
      renderRowControl={(entry, index) => (
        <Switch
          checked={entry.enabled}
          onChange={(enabled) => setEnabled(index, enabled)}
          label={entry.enabled ? `Disable ${idPrefix} critic ${index + 1}` : `Enable ${idPrefix} critic ${index + 1}`}
        />
      )}
      renderTitle={(entry) => {
        const critic = entry.kind === "global" ? globalById.get(entry.ref) : entry.critic;
        const name = critic ? critic.name : "";
        return (
          <span className={entry.enabled ? "" : "opacity-60 line-through"}>
            <CriticRowTitle name={critic ? name : "Removed"} />
          </span>
        );
      }}
      renderMeta={(entry) =>
        entry.kind === "global" ? (
          <span className={globalChip}>Global</span>
        ) : (
          <CriticRunChip critic={entry.critic} />
        )
      }
      renderLockedBody={(entry) => {
        const critic = entry.kind === "global" ? globalById.get(entry.ref) : undefined;
        if (!critic) return <p className="text-small text-muted">This global critic was removed. Remove this row too.</p>;
        return <LockedCriticSummary critic={critic} />;
      }}
      renderBody={(entry, index, set) => {
        if (entry.kind !== "local") return null;
        return (
          <TaskCriticFields
            critic={entry.critic}
            index={index}
            idPrefix={idPrefix}
            errorPrefix={errorPrefix}
            fieldErrors={fieldErrors}
            harnessModels={harnessModels}
            set={(critic) => set({ ...entry, critic })}
          />
        );
      }}
    />
  );
}

/** The epic-critic counterpart of {@link TaskCriticOverlayEditor}. */
export function EpicCriticOverlayEditor({
  overlay,
  globals,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
  emptyText,
}: SharedProps & {
  overlay: EpicCriticOverlayEntry[] | null;
  globals: EpicVerificationCritic[];
  onChange: (overlay: EpicCriticOverlayEntry[]) => void;
}) {
  const globalById = new Map(globals.map((g) => [g.id, g]));
  const rows = withMissingGlobals<EpicCriticOverlayEntry>(
    overlay,
    globals.map((g) => g.id),
  );
  const setEnabled = (index: number, enabled: boolean) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, enabled } : row)));

  return (
    <EntryList
      items={rows}
      onChange={onChange}
      groupLabel="Critics"
      addLabel="+ Add critic"
      emptyText={emptyText}
      itemNoun="critic"
      makeItem={() => ({ kind: "local" as const, enabled: true, critic: newEpicCritic() })}
      isLocked={(entry) => entry.kind === "global"}
      canRemoveLocked={(entry) => entry.kind === "global" && !globalById.has(entry.ref)}
      renderRowControl={(entry, index) => (
        <Switch
          checked={entry.enabled}
          onChange={(enabled) => setEnabled(index, enabled)}
          label={entry.enabled ? `Disable ${idPrefix} critic ${index + 1}` : `Enable ${idPrefix} critic ${index + 1}`}
        />
      )}
      renderTitle={(entry) => {
        const critic = entry.kind === "global" ? globalById.get(entry.ref) : entry.critic;
        return (
          <span className={entry.enabled ? "" : "opacity-60 line-through"}>
            <CriticRowTitle name={critic ? critic.name : "Removed"} />
          </span>
        );
      }}
      renderMeta={(entry) =>
        entry.kind === "global" ? (
          <span className={globalChip}>Global</span>
        ) : (
          <CriticRunChip critic={entry.critic} />
        )
      }
      renderLockedBody={(entry) => {
        const critic = entry.kind === "global" ? globalById.get(entry.ref) : undefined;
        if (!critic) return <p className="text-small text-muted">This global critic was removed. Remove this row too.</p>;
        return <LockedCriticSummary critic={critic} />;
      }}
      renderBody={(entry, index, set) => {
        if (entry.kind !== "local") return null;
        return (
          <EpicCriticFields
            critic={entry.critic}
            index={index}
            idPrefix={idPrefix}
            errorPrefix={errorPrefix}
            fieldErrors={fieldErrors}
            harnessModels={harnessModels}
            set={(critic) => set({ ...entry, critic })}
          />
        );
      }}
    />
  );
}
