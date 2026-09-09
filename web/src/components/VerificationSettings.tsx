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
import { summarizeCommands } from "./verification-override-model";

type EditorProps = {
  commands: VerificationCommand[];
  onCommands: (commands: VerificationCommand[]) => void;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
};

function criticCount(critics: readonly unknown[]): string {
  return critics.length === 0
    ? "No critics"
    : `${critics.length} critic${critics.length === 1 ? "" : "s"}`;
}

function StageHeading({ children }: { children: string }) {
  return <h3 className="text-label font-semibold text-ink">{children}</h3>;
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
    <div className="flex flex-col gap-8">
      <div>
        <StageHeading>Task pre-merge</StageHeading>
        <div className="mt-4">
          <TaskStage
            commands={config.verify.task.preMerge.commands}
            onCommands={(commands) =>
              setTaskStage("preMerge", {
                ...config.verify.task.preMerge,
                commands,
              })
            }
            critics={config.verify.task.preMerge.critics}
            onCritics={(critics) =>
              setTaskStage("preMerge", {
                ...config.verify.task.preMerge,
                critics,
              })
            }
            idPrefix="settings-task-pre-merge"
            errorPrefix="verify.task.preMerge"
            fieldErrors={fieldErrors}
            harnesses={harnesses}
          />
        </div>
      </div>
      <div>
        <StageHeading>Task post-merge</StageHeading>
        <div className="mt-4">
          <TaskStage
            commands={config.verify.task.postMerge.commands}
            onCommands={(commands) =>
              setTaskStage("postMerge", {
                ...config.verify.task.postMerge,
                commands,
              })
            }
            critics={config.verify.task.postMerge.critics}
            onCritics={(critics) =>
              setTaskStage("postMerge", {
                ...config.verify.task.postMerge,
                critics,
              })
            }
            idPrefix="settings-task-post-merge"
            errorPrefix="verify.task.postMerge"
            fieldErrors={fieldErrors}
            harnesses={harnesses}
          />
        </div>
      </div>
      <div>
        <StageHeading>Epic pre-merge</StageHeading>
        <div className="mt-4">
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
        </div>
      </div>
      <div>
        <PromptField
          id="settings-epic-resolve-prompt"
          label="Epic resolve prompt"
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
  return (
    <div className="flex flex-col gap-8">
      <div>
        <StageHeading>Task pre-merge</StageHeading>
        <div className="mt-4">
          <WorkspaceTaskStage
            workspace={workspace}
            config={config}
            setWorkspace={setWorkspace}
            commandsKey="taskPreMergeCommands"
            criticsKey="taskPreMergeCritics"
            stage="preMerge"
            fieldErrors={fieldErrors}
          />
        </div>
      </div>
      <div>
        <StageHeading>Task post-merge</StageHeading>
        <div className="mt-4">
          <WorkspaceTaskStage
            workspace={workspace}
            config={config}
            setWorkspace={setWorkspace}
            commandsKey="taskPostMergeCommands"
            criticsKey="taskPostMergeCritics"
            stage="postMerge"
            fieldErrors={fieldErrors}
          />
        </div>
      </div>
      <div>
        <StageHeading>Epic pre-merge</StageHeading>
        <div className="mt-4">
          <WorkspaceEpicStage
            workspace={workspace}
            config={config}
            setWorkspace={setWorkspace}
            fieldErrors={fieldErrors}
          />
        </div>
      </div>
    </div>
  );
}
