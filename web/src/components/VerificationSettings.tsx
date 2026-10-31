import type { ReactNode } from "react";
import type { AppConfig, EpicVerificationCritic, VerificationCommand, Workspace } from "../types";
import { resolvePromptFragments } from "../../../src/domain/setting-override.js";
import { CommandListEditor, CommandOverlayEditor } from "./CommandListEditor";
import {
  PromptFragmentsContext,
  EpicCriticListEditor,
  EpicCriticOverlayEditor,
} from "./CriticListEditor";
import { harnessChoices, type HarnessChoices } from "./verification-override-model";

type EditorProps = {
  commands: VerificationCommand[];
  onCommands: (commands: VerificationCommand[]) => void;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
};

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


function EpicStage({
  commands,
  onCommands,
  critics,
  onCritics,
  idPrefix,
  errorPrefix,
  fieldErrors,
  harnessModels,
}: EditorProps & {
  critics: EpicVerificationCritic[];
  onCritics: (critics: EpicVerificationCritic[]) => void;
  harnessModels: HarnessChoices;
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
        harnessModels={harnessModels}
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
  const harnessModels = harnessChoices(config);
  const setEpicStage = (preMerge: AppConfig["verify"]["epic"]["preMerge"]) =>
    setConfig({
      ...config,
      verify: { ...config.verify, epic: { ...config.verify.epic, preMerge } },
    });

  return (
    <PromptFragmentsContext.Provider value={config.promptFragments}>
      <div className="flex flex-col gap-5">
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
            onCommands={(commands) => setEpicStage({ ...config.verify.epic.preMerge, commands })}
            critics={config.verify.epic.preMerge.critics}
            onCritics={(critics) => setEpicStage({ ...config.verify.epic.preMerge, critics })}
            idPrefix="settings-epic-pre-merge"
            errorPrefix="verify.epic.preMerge"
            fieldErrors={fieldErrors}
            harnessModels={harnessModels}
          />
        </StageBlock>
        <p className="text-small text-faint">
          The prompt for fixing a failing Epic verification is on the Prompts tab (Epic verification fix).
        </p>
      </div>
    </PromptFragmentsContext.Provider>
  );
}

function WorkspaceEpicStage({
  workspace,
  config,
  harnessModels,
  setWorkspace,
  fieldErrors,
}: {
  workspace: Workspace;
  config: AppConfig;
  harnessModels: HarnessChoices;
  setWorkspace: (workspace: Workspace) => void;
  fieldErrors: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-5">
      <CommandOverlayEditor
        overlay={workspace.epicPreMergeCommands}
        globals={config.verify.epic.preMerge.commands}
        onChange={(epicPreMergeCommands) => setWorkspace({ ...workspace, epicPreMergeCommands })}
        idPrefix="workspace-epic-pre-merge"
        errorPrefix="epicPreMergeCommands"
        fieldErrors={fieldErrors}
        emptyText="No commands run at this stage."
      />
      <EpicCriticOverlayEditor
        overlay={workspace.epicPreMergeCritics}
        globals={config.verify.epic.preMerge.critics}
        onChange={(epicPreMergeCritics) => setWorkspace({ ...workspace, epicPreMergeCritics })}
        idPrefix="workspace-epic-pre-merge"
        errorPrefix="epicPreMergeCritics"
        fieldErrors={fieldErrors}
        harnessModels={harnessModels}
        emptyText="No critics run after commands pass."
      />
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
  const harnessModels = harnessChoices(config);
  return (
    <PromptFragmentsContext.Provider value={resolvePromptFragments(workspace, config)}>
      <StageBlock title="Pre-merge" hint="runs on the integration branch before the epic merges">
        <WorkspaceEpicStage
          workspace={workspace}
          config={config}
          harnessModels={harnessModels}
          setWorkspace={setWorkspace}
          fieldErrors={fieldErrors}
        />
      </StageBlock>
    </PromptFragmentsContext.Provider>
  );
}
