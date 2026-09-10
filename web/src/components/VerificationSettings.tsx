import { useState, type ReactNode } from "react";
import type {
  AppConfig,
  EpicVerificationCritic,
  TaskVerificationCritic,
  VerificationCommand,
  Workspace,
} from "../types";
import { EPIC_RESOLVE_PLACEHOLDERS, compileEpicResolvePreview } from "../prompt-preview-model";
import { CommandListEditor } from "./CommandListEditor";
import { EpicCriticListEditor, TaskCriticListEditor } from "./CriticListEditor";
import { InheritField } from "./InheritField";
import { PromptField } from "./SettingsSection";
import { Tabs } from "./Tabs";
import { summarizeCommands } from "./verification-override-model";

type EditorProps = {
  commands: VerificationCommand[];
  onCommands: (commands: VerificationCommand[]) => void;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
};

const SCOPE_TABS = [
  { id: "task", label: "Task" },
  { id: "epic", label: "Epic" },
] as const;

function criticCount(critics: readonly unknown[]): string {
  return critics.length === 0
    ? "No critics"
    : `${critics.length} critic${critics.length === 1 ? "" : "s"}`;
}

function CountPill({ n, label }: { n: number; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-small tabular-nums ${
        n === 0 ? "text-faint ring-1 ring-inset ring-hairline" : "bg-raised text-muted"
      }`}
    >
      {n} {label}
      {n === 1 ? "" : "s"}
    </span>
  );
}

/** One verification stage under a scope tab. The title carries real hierarchy
 * (Title role, not the field-label micro-caps the flat layout used), a one-line
 * hint states when the stage runs, and the count pills read the stage's weight
 * at a glance. Stages are hairline-separated within a tab. */
function StageBlock({
  title,
  hint,
  counts,
  children,
}: {
  title: string;
  hint: string;
  counts?: { commands: number; critics: number };
  children: ReactNode;
}) {
  return (
    <section className="border-t border-hairline pt-5 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-title font-semibold tracking-tight text-ink">{title}</h3>
        <span className="text-small text-faint">{hint}</span>
        {counts && (
          <span className="ml-auto flex gap-1.5">
            <CountPill n={counts.commands} label="command" />
            <CountPill n={counts.critics} label="critic" />
          </span>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TaskStage({
  commands,
  onCommands,
  critics,
  onCritics,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnesses,
}: EditorProps & {
  critics: TaskVerificationCritic[];
  onCritics: (critics: TaskVerificationCritic[]) => void;
  harnesses: string[];
}) {
  return (
    <div className="flex flex-col gap-5">
      <CommandListEditor
        commands={commands}
        onChange={onCommands}
        idPrefix={idPrefix}
        errorPrefix={`${errorPrefix}.commands`}
        fieldErrors={fieldErrors}
        emptyText="No commands run at this stage."
      />
      <TaskCriticListEditor
        critics={critics}
        onChange={onCritics}
        idPrefix={idPrefix}
        errorPrefix={`${errorPrefix}.critics`}
        fieldErrors={fieldErrors}
        harnesses={harnesses}
        emptyText="No critics run after commands pass."
      />
    </div>
  );
}

function EpicStage({
  commands,
  onCommands,
  critics,
  onCritics,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnesses,
}: EditorProps & {
  critics: EpicVerificationCritic[];
  onCritics: (critics: EpicVerificationCritic[]) => void;
  harnesses: string[];
}) {
  return (
    <div className="flex flex-col gap-5">
      <CommandListEditor
        commands={commands}
        onChange={onCommands}
        idPrefix={idPrefix}
        errorPrefix={`${errorPrefix}.commands`}
        fieldErrors={fieldErrors}
        emptyText="No commands run at this stage."
      />
      <EpicCriticListEditor
        critics={critics}
        onChange={onCritics}
        idPrefix={idPrefix}
        errorPrefix={`${errorPrefix}.critics`}
        fieldErrors={fieldErrors}
        harnesses={harnesses}
        emptyText="No critics run after commands pass."
      />
    </div>
  );
}

export function GlobalVerificationSettings({
  config,
  setConfig,
  fieldErrors,
}: {
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
  fieldErrors: Record<string, string>;
}) {
  const [scope, setScope] = useState<"task" | "epic">("task");
  const harnesses = Object.keys(config.harnesses);
  const setTaskStage = (
    stage: "preMerge" | "postMerge",
    next: AppConfig["verify"]["task"]["preMerge"],
  ) =>
    setConfig({
      ...config,
      verify: {
        ...config.verify,
        task: { ...config.verify.task, [stage]: next },
      },
    });
  const setEpicStage = (preMerge: AppConfig["verify"]["epic"]["preMerge"]) =>
    setConfig({
      ...config,
      verify: { ...config.verify, epic: { ...config.verify.epic, preMerge } },
    });

  return (
    <div>
      <Tabs
        tabs={SCOPE_TABS}
        active={scope}
        onChange={(id) => setScope(id as "task" | "epic")}
        label="Verification scope"
      />
      <div className="mt-5 flex flex-col gap-5">
        {scope === "task" ? (
          <>
            <StageBlock
              title="Pre-merge"
              hint="runs in the worktree before the task merges"
              counts={{
                commands: config.verify.task.preMerge.commands.length,
                critics: config.verify.task.preMerge.critics.length,
              }}
            >
              <TaskStage
                commands={config.verify.task.preMerge.commands}
                onCommands={(commands) =>
                  setTaskStage("preMerge", { ...config.verify.task.preMerge, commands })
                }
                critics={config.verify.task.preMerge.critics}
                onCritics={(critics) =>
                  setTaskStage("preMerge", { ...config.verify.task.preMerge, critics })
                }
                idPrefix="settings-task-pre-merge"
                errorPrefix="verify.task.preMerge"
                fieldErrors={fieldErrors}
                harnesses={harnesses}
              />
            </StageBlock>
            <StageBlock
              title="Post-merge"
              hint="runs on the base after the merge commit; a failure reverts it"
              counts={{
                commands: config.verify.task.postMerge.commands.length,
                critics: config.verify.task.postMerge.critics.length,
              }}
            >
              <TaskStage
                commands={config.verify.task.postMerge.commands}
                onCommands={(commands) =>
                  setTaskStage("postMerge", { ...config.verify.task.postMerge, commands })
                }
                critics={config.verify.task.postMerge.critics}
                onCritics={(critics) =>
                  setTaskStage("postMerge", { ...config.verify.task.postMerge, critics })
                }
                idPrefix="settings-task-post-merge"
                errorPrefix="verify.task.postMerge"
                fieldErrors={fieldErrors}
                harnesses={harnesses}
              />
            </StageBlock>
          </>
        ) : (
          <>
            <StageBlock
              title="Pre-merge"
              hint="runs on the integration branch before the epic merges"
              counts={{
                commands: config.verify.epic.preMerge.commands.length,
                critics: config.verify.epic.preMerge.critics.length,
              }}
            >
              <EpicStage
                commands={config.verify.epic.preMerge.commands}
                onCommands={(commands) =>
                  setEpicStage({ ...config.verify.epic.preMerge, commands })
                }
                critics={config.verify.epic.preMerge.critics}
                onCritics={(critics) =>
                  setEpicStage({ ...config.verify.epic.preMerge, critics })
                }
                idPrefix="settings-epic-pre-merge"
                errorPrefix="verify.epic.preMerge"
                fieldErrors={fieldErrors}
                harnesses={harnesses}
              />
            </StageBlock>
            <StageBlock
              title="Resolve prompt"
              hint="sent to the agent that fixes a failing epic verification"
            >
              <PromptField
                id="settings-epic-resolve-prompt"
                value={config.verify.epic.resolvePrompt}
                onChange={(resolvePrompt) =>
                  setConfig({
                    ...config,
                    verify: {
                      ...config.verify,
                      epic: { ...config.verify.epic, resolvePrompt },
                    },
                  })
                }
                placeholders={EPIC_RESOLVE_PLACEHOLDERS}
                preview={compileEpicResolvePreview(config.verify.epic.resolvePrompt)}
                error={fieldErrors["verify.epic.resolvePrompt"]}
                rows={5}
              />
            </StageBlock>
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceTaskStage({
  workspace,
  config,
  setWorkspace,
  commandsKey,
  criticsKey,
  stage,
  fieldErrors,
}: {
  workspace: Workspace;
  config: AppConfig;
  setWorkspace: (workspace: Workspace) => void;
  commandsKey: "taskPreMergeCommands" | "taskPostMergeCommands";
  criticsKey: "taskPreMergeCritics" | "taskPostMergeCritics";
  stage: "preMerge" | "postMerge";
  fieldErrors: Record<string, string>;
}) {
  const idPrefix = `workspace-task-${stage === "preMerge" ? "pre" : "post"}-merge`;
  return (
    <div className="flex flex-col gap-5">
      <InheritField
        label="Commands"
        value={workspace[commandsKey]}
        inherited={config.verify.task[stage].commands}
        format={summarizeCommands}
        onChange={(commands) =>
          setWorkspace({ ...workspace, [commandsKey]: commands })
        }
      >
        {({ value, onChange }) => (
          <CommandListEditor
            commands={value}
            onChange={onChange}
            idPrefix={idPrefix}
            errorPrefix={commandsKey}
            fieldErrors={fieldErrors}
            emptyText="No commands run at this stage."
          />
        )}
      </InheritField>
      <InheritField
        label="Critics"
        value={workspace[criticsKey]}
        inherited={config.verify.task[stage].critics}
        format={criticCount}
        onChange={(critics) =>
          setWorkspace({ ...workspace, [criticsKey]: critics })
        }
      >
        {({ value, onChange }) => (
          <TaskCriticListEditor
            critics={value}
            onChange={onChange}
            idPrefix={idPrefix}
            errorPrefix={criticsKey}
            fieldErrors={fieldErrors}
            harnesses={Object.keys(config.harnesses)}
            emptyText="No critics run after commands pass."
          />
        )}
      </InheritField>
    </div>
  );
}

function WorkspaceEpicStage({
  workspace,
  config,
  setWorkspace,
  fieldErrors,
}: {
  workspace: Workspace;
  config: AppConfig;
  setWorkspace: (workspace: Workspace) => void;
  fieldErrors: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-5">
      <InheritField
        label="Commands"
        value={workspace.epicPreMergeCommands}
        inherited={config.verify.epic.preMerge.commands}
        format={summarizeCommands}
        onChange={(epicPreMergeCommands) =>
          setWorkspace({ ...workspace, epicPreMergeCommands })
        }
      >
        {({ value, onChange }) => (
          <CommandListEditor
            commands={value}
            onChange={onChange}
            idPrefix="workspace-epic-pre-merge"
            errorPrefix="epicPreMergeCommands"
            fieldErrors={fieldErrors}
            emptyText="No commands run at this stage."
          />
        )}
      </InheritField>
      <InheritField
        label="Critics"
        value={workspace.epicPreMergeCritics}
        inherited={config.verify.epic.preMerge.critics}
        format={criticCount}
        onChange={(epicPreMergeCritics) =>
          setWorkspace({ ...workspace, epicPreMergeCritics })
        }
      >
        {({ value, onChange }) => (
          <EpicCriticListEditor
            critics={value}
            onChange={onChange}
            idPrefix="workspace-epic-pre-merge"
            errorPrefix="epicPreMergeCritics"
            fieldErrors={fieldErrors}
            harnesses={Object.keys(config.harnesses)}
            emptyText="No critics run after commands pass."
          />
        )}
      </InheritField>
    </div>
  );
}

export function WorkspaceVerificationSettings({
  workspace,
  config,
  setWorkspace,
  fieldErrors,
}: {
  workspace: Workspace;
  config: AppConfig;
  setWorkspace: (workspace: Workspace) => void;
  fieldErrors: Record<string, string>;
}) {
  const [scope, setScope] = useState<"task" | "epic">("task");
  return (
    <div>
      <Tabs
        tabs={SCOPE_TABS}
        active={scope}
        onChange={(id) => setScope(id as "task" | "epic")}
        label="Verification scope"
      />
      <div className="mt-5 flex flex-col gap-5">
        {scope === "task" ? (
          <>
            <StageBlock title="Pre-merge" hint="runs in the worktree before the task merges">
              <WorkspaceTaskStage
                workspace={workspace}
                config={config}
                setWorkspace={setWorkspace}
                commandsKey="taskPreMergeCommands"
                criticsKey="taskPreMergeCritics"
                stage="preMerge"
                fieldErrors={fieldErrors}
              />
            </StageBlock>
            <StageBlock
              title="Post-merge"
              hint="runs on the base after the merge commit; a failure reverts it"
            >
              <WorkspaceTaskStage
                workspace={workspace}
                config={config}
                setWorkspace={setWorkspace}
                commandsKey="taskPostMergeCommands"
                criticsKey="taskPostMergeCritics"
                stage="postMerge"
                fieldErrors={fieldErrors}
              />
            </StageBlock>
          </>
        ) : (
          <StageBlock
            title="Pre-merge"
            hint="runs on the integration branch before the epic merges"
          >
            <WorkspaceEpicStage
              workspace={workspace}
              config={config}
              setWorkspace={setWorkspace}
              fieldErrors={fieldErrors}
            />
          </StageBlock>
        )}
      </div>
    </div>
  );
}
