import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { stringify } from 'yaml';
import type { AppConfig } from '../config.js';
import type { AsyncDbHandle } from '../db/async.js';
import { settings, type WorkspaceRow } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import type { SettingsStore } from '../server/settings-store.js';
import { DomainError } from './errors.js';
import { convertEditedEpicFixPrompts, epicFixTexts } from './epic-fix-prompt.js';
import type { PromptLibrary } from './prompt-library-store.js';
import { translateRetiredText } from './retired-settings.js';
import { resolveEpicResolverPrompts, resolveScoped, resolveVerifiers } from './setting-override.js';
import {
  commandRunLine,
  DEFAULT_CRITIC_TIMEOUT_SECONDS,
  refuseExpressions,
  UnconvertibleSettingError,
  workflowNameFor,
  writePrompt,
  writeWorkflow,
  type PlannedPrompt,
  type PlannedWorkflow,
} from './settings-workflow-migration.js';
import { MAX_ATTEMPTS_LIMIT, parseWorkflow } from './workflow.js';
import type { WorkflowLibrary } from './workflow-library-store.js';

export const EPIC_SETTINGS_MIGRATION_MARKER = 'migration.epic-settings-to-workflows';
export const MIGRATED_EPIC_GLOBAL = 'migrated-epic-global';

interface EpicScope {
  maxAttempts: number;
  preMerge: ReturnType<typeof resolveVerifiers>['epic']['preMerge'];
  resolvePrompt: string;
}

export interface EpicMigrationPlan {
  readonly prompts: readonly PlannedPrompt[];
  readonly workflows: readonly PlannedWorkflow[];
  readonly globalWorkflow: string;
  readonly workspaceWorkflows: readonly { workspaceId: number; workflow: string }[];
}

export interface EpicPlanInput {
  config: AppConfig;
  workspaces: readonly WorkspaceRow[];
  library: { resolvePrompt: string; resolveSuffix: string };
}

function scopeOf(ws: WorkspaceRow | null, input: EpicPlanInput): EpicScope {
  const { config, library } = input;
  const suffix = ws ? resolveEpicResolverPrompts(ws, config).resolveSuffix : config.verify.epic.resolveSuffix;
  const resolveSuffix = suffix === config.verify.epic.resolveSuffix ? library.resolveSuffix : suffix;
  return {
    maxAttempts: resolveScoped('maxAttempts', ws?.maxAttempts, config.maxAttempts),
    preMerge: ws ? resolveVerifiers(ws, config).epic.preMerge : config.verify.epic.preMerge,
    resolvePrompt: `${library.resolvePrompt}\n\n${resolveSuffix}`,
  };
}

function workflowFor(name: string, label: string, description: string, scopeKey: string, scope: EpicScope, entries: Map<string, PlannedPrompt>): string {
  const where = (path: string): string => (label === '' ? path : `${label} ${path}`);
  if (!Number.isInteger(scope.maxAttempts) || scope.maxAttempts < 1 || scope.maxAttempts > MAX_ATTEMPTS_LIMIT) {
    throw new UnconvertibleSettingError(where('maxAttempts'), `it is ${scope.maxAttempts} and a workflow allows 1 to ${MAX_ATTEMPTS_LIMIT}`);
  }
  const addEntry = (code: string, description: string, text: string): string => {
    entries.set(code, { code, description, text });
    return code;
  };
  refuseExpressions(scope.resolvePrompt, where('verify.epic.resolvePrompt'));
  const resolveCode = addEntry(`migrated-${scopeKey}-epic-resolve`, 'Epic resolve prompt, migrated from your settings.', scope.resolvePrompt);
  const verify = scope.preMerge.commands.map((command, i) => ({ id: `verify-${i + 1}`, run: commandRunLine(command, where(`verify.epic.preMerge.commands[${i}]`)) }));
  const critics = scope.preMerge.critics.map((critic, i) => {
    const path = `verify.epic.preMerge.critics[${i}]`;
    if (critic.timeoutSeconds !== DEFAULT_CRITIC_TIMEOUT_SECONDS) {
      throw new UnconvertibleSettingError(where(`${path}.timeoutSeconds`), `it is ${critic.timeoutSeconds} seconds and a workflow critic step times out after ${DEFAULT_CRITIC_TIMEOUT_SECONDS}`);
    }
    refuseExpressions(critic.prompt, where(`${path}.prompt`));
    const prompt = addEntry(`migrated-${scopeKey}-epic-critic${i + 1}`, `Epic critic ${critic.name || i + 1} review prompt, migrated from your settings.`, translateRetiredText(critic.prompt));
    return { id: `critic-${i + 1}`, uses: 'critic', with: { harness: critic.harness, model: critic.model, prompt } };
  });
  const doc = {
    name,
    description,
    subject: 'epic',
    vars: { maxAttempts: scope.maxAttempts },
    steps: [
      {
        attempts: {
          max: '${{ vars.maxAttempts }}',
          steps: [{ id: 'resolve', if: '${{ attempt.number > 1 }}', uses: 'agent', with: { prompt: resolveCode, continueAttempts: 1, continuePrompt: 'commitNudge' } }, ...verify, ...critics],
        },
      },
      { id: 'merge', uses: 'merge' },
      { id: 'post-merge-check', uses: 'post-merge-check' },
      { id: 'close-ticket', uses: 'close-ticket' },
    ],
    cleanup: [{ id: 'cleanup', uses: 'cleanup' }],
  };
  const text = stringify(doc, { lineWidth: 0 });
  try {
    parseWorkflow(text);
  } catch (error) {
    throw new UnconvertibleSettingError(where('workflow'), error instanceof DomainError ? error.message : String(error));
  }
  return text;
}

/** Converts the Epic settings in memory only; any unconvertible setting throws before the caller has written anything. */
export async function planEpicSettingsMigration(input: EpicPlanInput): Promise<EpicMigrationPlan> {
  const entries = new Map<string, PlannedPrompt>();
  const workflows: PlannedWorkflow[] = [];
  const taken = new Set([MIGRATED_EPIC_GLOBAL]);
  const global = scopeOf(null, input);
  workflows.push({ name: MIGRATED_EPIC_GLOBAL, text: workflowFor(MIGRATED_EPIC_GLOBAL, '', 'Migrated Epic (global)', 'epic-global', global, entries) });
  const workspaceWorkflows: { workspaceId: number; workflow: string }[] = [];
  await forEachYielding([...input.workspaces].sort((a, b) => a.id - b.id), (workspace) => {
    const own = scopeOf(workspace, input);
    if (isDeepStrictEqual(own, global)) return;
    const name = workflowNameFor(workspace, taken, 'migrated-epic');
    workflows.push({ name, text: workflowFor(name, `Workspace "${workspace.name}"`, `Migrated Epic (${workspace.name})`, `epic-w${workspace.id}`, own, entries) });
    workspaceWorkflows.push({ workspaceId: workspace.id, workflow: name });
  });
  return { prompts: [...entries.values()], workflows, globalWorkflow: MIGRATED_EPIC_GLOBAL, workspaceWorkflows };
}

export interface EpicSettingsMigrationDeps {
  db: AsyncDbHandle;
  settings: SettingsStore;
  prompts: PromptLibrary;
  workflows: WorkflowLibrary;
  workspaces: { list(): Promise<WorkspaceRow[]> };
}

// The done-marker is written last so a crash at any point converges on re-run.
export async function migrateEpicSettingsToWorkflows(deps: EpicSettingsMigrationDeps): Promise<void> {
  const done = await deps.db.read((d) => d.select({ value: settings.value }).from(settings).where(eq(settings.key, EPIC_SETTINGS_MIGRATION_MARKER)).get());
  if (done) return;
  await convertEditedEpicFixPrompts(deps.prompts, deps.settings.getGlobal(), deps.settings.getRetired());
  const plan = await planEpicSettingsMigration({
    config: deps.settings.getGlobal(),
    workspaces: await deps.workspaces.list(),
    library: await epicFixTexts(deps.prompts),
  });
  await forEachYielding(plan.prompts, (entry) => writePrompt(deps.prompts, entry));
  await forEachYielding(plan.workflows, (workflow) => writeWorkflow(deps.workflows, workflow));
  await forEachYielding(plan.workspaceWorkflows, async ({ workspaceId, workflow }) => {
    if (deps.settings.getOverrides(workspaceId).epicWorkflow === null) await deps.settings.setOverrides(workspaceId, { epicWorkflow: workflow });
  });
  if (deps.settings.getGlobal().defaults.epicWorkflow === null) await deps.settings.setDefaultEpicWorkflow(plan.globalWorkflow);
  await deps.db.write((d) => d.insert(settings).values({ key: EPIC_SETTINGS_MIGRATION_MARKER, value: 'done' }).onConflictDoNothing().run());
}
