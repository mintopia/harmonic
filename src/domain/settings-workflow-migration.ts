import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { stringify } from 'yaml';
import type { AppConfig, MergeFate, TaskVerificationCritic, TaskVerificationStage, VerificationCommand } from '../config.js';
import { loadBaselineConfig } from '../config.js';
import type { AsyncDbHandle } from '../db/async.js';
import { settings, type TaskRow, type WorkspaceRow } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import type { SettingsStore } from '../server/settings-store.js';
import { DomainError } from './errors.js';
import { ENGINE_APPENDED_FRAGMENTS, libraryEntryFor } from './prompt-library-sources.js';
import type { PromptLibrary } from './prompt-library-store.js';
import { PROMPT_FRAGMENTS, type PromptFragmentName } from './prompt-fragments.js';
import { resolvePromptFragments, resolveScoped, resolveVerifiers } from './setting-override.js';
import type { TaskService } from './tasks.js';
import { MAX_ATTEMPTS_LIMIT, parseWorkflow, WORKFLOW_NAME_PATTERN } from './workflow.js';
import { resolveTaskWorkflow } from './workflow-assignment.js';
import type { WorkflowLibrary } from './workflow-library-store.js';
import { resolveVars, workspaceVarsFor } from './workflow-vars.js';

export const SETTINGS_MIGRATION_MARKER = 'migration.settings-to-workflows';
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const DEFAULT_CRITIC_TIMEOUT_SECONDS = 300;
const IN_FLIGHT_STATES = ['working', 'paused', 'escalated'] as const;

export class UnconvertibleSettingError extends Error {
  constructor(readonly setting: string, reason: string) {
    super(`Cannot migrate setting ${setting} to a workflow: ${reason}. Change it on the previous release, then upgrade again.`);
    this.name = 'UnconvertibleSettingError';
  }
}

type PromptSlot = 'drivePrompt' | 'unattendedReminder' | 'taskPrompt' | 'commitNudge' | 'selfHeal';

interface ScopeSettings {
  maxAttempts: number;
  continueAttempts: number;
  mergeFate: MergeFate;
  postMergeCheck: boolean;
  preMerge: TaskVerificationStage;
  postMerge: TaskVerificationStage;
  prompts: Record<PromptSlot, string>;
  fragments: AppConfig['promptFragments'];
}

type VerifierOverrides = Pick<WorkspaceRow, 'taskPreMergeCommands' | 'taskPreMergeCritics' | 'taskPostMergeCommands' | 'taskPostMergeCritics' | 'epicPreMergeCommands' | 'epicPreMergeCritics'>;

const NO_VERIFIER_OVERRIDES: VerifierOverrides = { taskPreMergeCommands: null, taskPreMergeCritics: null, taskPostMergeCommands: null, taskPostMergeCritics: null, epicPreMergeCommands: null, epicPreMergeCritics: null };

function scopeSettings(ws: WorkspaceRow | null, config: AppConfig): ScopeSettings {
  const verifiers = resolveVerifiers(ws ?? NO_VERIFIER_OVERRIDES, config);
  const fragments = resolvePromptFragments(ws, config);
  return {
    maxAttempts: resolveScoped('maxAttempts', ws?.maxAttempts, config.maxAttempts),
    continueAttempts: resolveScoped('driveContinueAttempts', ws?.driveContinueAttempts, config.drive.continueAttempts),
    mergeFate: resolveScoped('driveMergeFate', ws?.driveMergeFate as MergeFate | null | undefined, config.drive.mergeFate),
    postMergeCheck: config.merge.postMergeCheck,
    preMerge: verifiers.task.preMerge,
    postMerge: verifiers.task.postMerge,
    prompts: {
      drivePrompt: resolveScoped('drivePrompt', ws?.drivePrompt, config.drive.prompt),
      unattendedReminder: resolveScoped('driveUnattendedReminder', ws?.driveUnattendedReminder, config.drive.unattendedReminder),
      taskPrompt: resolveScoped('taskPrompt', ws?.taskPrompt, config.taskPrompt),
      commitNudge: resolveScoped('driveCommitNudge', ws?.driveCommitNudge, config.drive.commitNudge),
      selfHeal: fragments.selfHeal,
    },
    fragments,
  };
}

export interface PlannedPrompt {
  readonly code: string;
  readonly description: string;
  readonly text: string;
}

export interface PlannedWorkflow {
  readonly name: string;
  readonly text: string;
}

export interface SettingsMigrationPlan {
  readonly prompts: readonly PlannedPrompt[];
  readonly workflows: readonly PlannedWorkflow[];
  readonly globalWorkflow: string;
  readonly workspaceWorkflows: readonly { workspaceId: number; workflow: string }[];
}

export interface PlanInput {
  config: AppConfig;
  workspaces: readonly WorkspaceRow[];
  promptText: (code: string) => string | undefined;
}

const FRAGMENT_REF = /\{fragment\.([^{}]+)\}/g;
const include = (code: string): string => `\${{ prompts.${code} }}`;
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (word: string): string => (SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function refuseExpressions(text: string, setting: string): void {
  if (text.includes('${{')) throw new UnconvertibleSettingError(setting, 'its text contains "${{", which a workflow would evaluate');
}

class ScopePlanner {
  constructor(
    private readonly label: string,
    private readonly scopeKey: string,
    private readonly s: ScopeSettings,
    private readonly input: PlanInput,
    private readonly entries: Map<string, PlannedPrompt>,
  ) {}

  private name(path: string): string {
    return this.label === '' ? path : `${this.label} ${path}`;
  }

  private addEntry(code: string, description: string, text: string): string {
    this.entries.set(code, { code, description, text });
    return code;
  }

  private fragmentRef(name: PromptFragmentName, depth: number): string {
    const resolved = this.s.fragments[name];
    if ((ENGINE_APPENDED_FRAGMENTS as readonly string[]).includes(name)) return resolved;
    const baseline = loadBaselineConfig().promptFragments[name];
    if (resolved === baseline) return include(name);
    const entry = libraryEntryFor(name);
    if (entry !== undefined && this.input.promptText(entry) === resolved) return include(entry);
    return depth > 0 ? this.rewrite(resolved, depth - 1) : resolved;
  }

  private rewrite(text: string, depth = 3): string {
    return text.replace(FRAGMENT_REF, (whole, name: string) => (name in PROMPT_FRAGMENTS ? this.fragmentRef(name as PromptFragmentName, depth) : whole));
  }

  private promptEntry(slot: PromptSlot, baseline: string, description: string): string {
    const value = this.s.prompts[slot];
    if (value === baseline) return slot;
    refuseExpressions(value, this.name(slot));
    const edited = libraryEntryFor(slot);
    if (edited !== undefined && this.input.promptText(edited) === value && !value.includes('{fragment.')) return edited;
    return this.addEntry(`migrated-${this.scopeKey}-${slot}`, description, this.rewrite(value));
  }

  private composite(name: string, description: string, text: string, bundled: string): string {
    return text === bundledText[bundled] ? bundled : this.addEntry(`migrated-${this.scopeKey}-${name}`, description, text);
  }

  private agentPrompt(): { prompt: string; commitNudge: string } {
    const baseline = loadBaselineConfig();
    const drive = this.promptEntry('drivePrompt', baseline.drive.prompt, 'Your edited drive prompt.');
    const unattended = this.promptEntry('unattendedReminder', baseline.drive.unattendedReminder, 'Your edited unattended reminder.');
    const task = this.promptEntry('taskPrompt', baseline.taskPrompt, 'Your edited task prompt.');
    const selfHeal = this.promptEntry('selfHeal', baseline.promptFragments.selfHeal, 'Your edited self-heal section.');
    const commitNudge = this.promptEntry('commitNudge', baseline.drive.commitNudge, 'Your edited commit nudge.');
    const ticket = this.composite('implement-ticket', 'Opening prompt for a mirrored Ticket, from your migrated settings.', ticketText(drive, unattended), 'implement-ticket');
    const native = this.composite('implement-native', 'Opening prompt for a native Task, from your migrated settings.', nativeText(task), 'implement-native');
    const ticketHeal = this.composite('implement-ticket-heal', 'The mirrored-Ticket opening prompt followed by the self-heal section.', healText(ticket, selfHeal), 'implement-ticket-heal');
    const nativeHeal = this.composite('implement-native-heal', 'The native opening prompt followed by the self-heal section.', healText(native, selfHeal), 'implement-native-heal');
    return { prompt: pickPrompt(ticket, ticketHeal, native, nativeHeal), commitNudge };
  }

  private commandLine(command: VerificationCommand, path: string): string {
    if (command.timeoutSeconds !== DEFAULT_COMMAND_TIMEOUT_SECONDS) {
      throw new UnconvertibleSettingError(this.name(`${path}.timeoutSeconds`), `it is ${command.timeoutSeconds} seconds and a workflow step times out after ${DEFAULT_COMMAND_TIMEOUT_SECONDS}`);
    }
    const env = Object.entries(command.env).map(([key, value]) => {
      if (!ENV_NAME.test(key)) throw new UnconvertibleSettingError(this.name(`${path}.env`), `${key} is not a valid environment variable name`);
      return `${key}=${quote(value)}`;
    });
    const argv = [command.command, ...command.args].map(quote).join(' ');
    refuseExpressions(argv + env.join(' '), this.name(path));
    const body = env.length > 0 ? `env ${env.join(' ')} ${argv}` : argv;
    return command.cwd ? `cd ${quote(command.cwd)} && ${body}` : body;
  }

  private criticStep(critic: TaskVerificationCritic, index: number, path: string, id: string, codePrefix: string): Record<string, unknown> {
    if (critic.timeoutSeconds !== DEFAULT_CRITIC_TIMEOUT_SECONDS) {
      throw new UnconvertibleSettingError(this.name(`${path}.timeoutSeconds`), `it is ${critic.timeoutSeconds} seconds and a workflow critic step times out after ${DEFAULT_CRITIC_TIMEOUT_SECONDS}`);
    }
    refuseExpressions(critic.issuePrompt, this.name(`${path}.issuePrompt`));
    refuseExpressions(critic.noIssuePrompt, this.name(`${path}.noIssuePrompt`));
    const description = `Critic ${critic.name || index + 1} review prompt, migrated from your settings.`;
    const base = `migrated-${this.scopeKey}-${codePrefix}${index + 1}`;
    const prompt =
      critic.issuePrompt === critic.noIssuePrompt
        ? this.addEntry(base, description, this.rewrite(critic.issuePrompt))
        : `\${{ ticket.origin == 'mirrored' && '${this.addEntry(`${base}-issue`, description, this.rewrite(critic.issuePrompt))}' || '${this.addEntry(`${base}-noissue`, description, this.rewrite(critic.noIssuePrompt))}' }}`;
    return { id, uses: 'critic', with: { harness: critic.harness, model: critic.model, prompt } };
  }

  workflow(name: string, description: string): string {
    const s = this.s;
    if (!Number.isInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > MAX_ATTEMPTS_LIMIT) {
      throw new UnconvertibleSettingError(this.name('maxAttempts'), `it is ${s.maxAttempts} and a workflow allows 1 to ${MAX_ATTEMPTS_LIMIT}`);
    }
    const { prompt, commitNudge } = this.agentPrompt();
    const verify = s.preMerge.commands.map((command, i) => ({ id: `verify-${i + 1}`, run: this.commandLine(command, `verify.task.preMerge.commands[${i}]`) }));
    const critics = s.preMerge.critics.map((critic, i) => this.criticStep(critic, i, `verify.task.preMerge.critics[${i}]`, `critic-${i + 1}`, 'critic'));
    const attempts = { attempts: { max: '${{ vars.maxAttempts }}', steps: [{ id: 'build', uses: 'agent', with: { prompt, continueAttempts: s.continueAttempts, continuePrompt: commitNudge } }, ...verify, ...critics] } };
    const postCommands = s.postMergeCheck ? s.postMerge.commands.map((command, i) => this.commandLine(command, `verify.task.postMerge.commands[${i}]`)) : [];
    const postCritics = s.postMerge.critics.map((critic, i) => this.criticStep(critic, i, `verify.task.postMerge.critics[${i}]`, `post-critic-${i + 1}`, 'post-critic'));
    const tail =
      s.mergeFate === 'auto-merge'
        ? [
            { id: 'merge', uses: 'merge' },
            ...(postCommands.length > 0 ? [{ id: 'post-merge-check', uses: 'post-merge-check', with: { run: postCommands.length === 1 ? postCommands[0] : `set -e\n${postCommands.map((line) => `(${line})`).join('\n')}` } }] : []),
            ...postCritics,
            { id: 'close-ticket', uses: 'close-ticket' },
          ]
        : [{ id: s.mergeFate === 'open-PR' ? 'open-pr' : 'artifact', uses: s.mergeFate === 'open-PR' ? 'open-pr' : 'artifact' }];
    const doc = {
      name,
      description,
      vars: { maxAttempts: s.maxAttempts },
      steps: [{ id: 'rebase', uses: 'rebase' }, attempts, ...tail],
      ...(s.mergeFate === 'auto-merge' ? { cleanup: [{ id: 'cleanup', uses: 'cleanup' }] } : {}),
    };
    const text = stringify(doc, { lineWidth: 0 });
    try {
      parseWorkflow(text);
    } catch (error) {
      throw new UnconvertibleSettingError(this.name('workflow'), error instanceof DomainError ? error.message : String(error));
    }
    return text;
  }
}

const ticketText = (drive: string, unattended: string): string => `${include(drive)}{feedback}\n\n${include(unattended)}`;
const nativeText = (task: string): string => `${include(task)}{feedback}`;
const healText = (opening: string, selfHeal: string): string => `${include(opening)}\n\n${include(selfHeal)}`;

const bundledText: Record<string, string> = {
  'implement-ticket': ticketText('drivePrompt', 'unattendedReminder'),
  'implement-native': nativeText('taskPrompt'),
  'implement-ticket-heal': healText('implement-ticket', 'selfHeal'),
  'implement-native-heal': healText('implement-native', 'selfHeal'),
};

function pickPrompt(ticket: string, ticketHeal: string, native: string, nativeHeal: string): string {
  return `\${{ ticket.origin == 'mirrored' && (attempt.number > 1 && '${ticketHeal}' || '${ticket}') || (attempt.number > 1 && '${nativeHeal}' || '${native}') }}`;
}

/** A scope's settings with only the Prompt Fragments its prompts reference, so an unrelated Fragment override changes nothing. */
function comparable(s: ScopeSettings): unknown {
  const { fragments, ...rest } = s;
  const texts = [...Object.values(s.prompts), ...[...s.preMerge.critics, ...s.postMerge.critics].flatMap((critic) => [critic.issuePrompt, critic.noIssuePrompt])];
  const names = new Set(texts.flatMap((text) => [...text.matchAll(FRAGMENT_REF)].map((match) => match[1] as PromptFragmentName)));
  return { ...rest, fragments: [...names].sort().map((name) => fragments[name]) };
}

function workflowNameFor(workspace: WorkspaceRow, taken: Set<string>): string {
  const slug = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  const preferred = `migrated-${slug === '' ? `workspace-${workspace.id}` : slug}`;
  const name = taken.has(preferred) ? `${preferred}-${workspace.id}` : preferred;
  if (!WORKFLOW_NAME_PATTERN.test(name) || taken.has(name)) throw new UnconvertibleSettingError(`Workspace "${workspace.name}"`, `no unique workflow name can be derived from it`);
  taken.add(name);
  return name;
}

/** Converts the settings in memory only; any unconvertible setting throws before the caller has written anything. */
export async function planSettingsMigration(input: PlanInput): Promise<SettingsMigrationPlan> {
  const entries = new Map<string, PlannedPrompt>();
  const workflows: PlannedWorkflow[] = [];
  const taken = new Set(['migrated-global']);
  const global = scopeSettings(null, input.config);
  workflows.push({ name: 'migrated-global', text: new ScopePlanner('', 'global', global, input, entries).workflow('migrated-global', 'Migrated (global)') });
  const workspaceWorkflows: { workspaceId: number; workflow: string }[] = [];
  await forEachYielding([...input.workspaces].sort((a, b) => a.id - b.id), (workspace) => {
    const own = scopeSettings(workspace, input.config);
    if (isDeepStrictEqual(comparable(own), comparable(global))) return;
    const name = workflowNameFor(workspace, taken);
    const planner = new ScopePlanner(`Workspace "${workspace.name}"`, `w${workspace.id}`, own, input, entries);
    workflows.push({ name, text: planner.workflow(name, `Migrated (${workspace.name})`) });
    workspaceWorkflows.push({ workspaceId: workspace.id, workflow: name });
  });
  return { prompts: [...entries.values()], workflows, globalWorkflow: 'migrated-global', workspaceWorkflows };
}

export interface SettingsMigrationDeps {
  db: AsyncDbHandle;
  settings: SettingsStore;
  prompts: PromptLibrary;
  workflows: WorkflowLibrary;
  workspaces: { list(): Promise<WorkspaceRow[]> };
  tasks: Pick<TaskService, 'list' | 'pinWorkflow'>;
  onWorkspaceDefaultWritten?: (workspaceId: number) => Promise<void>;
}

async function writePrompt(prompts: PromptLibrary, entry: PlannedPrompt): Promise<void> {
  if (prompts.operatorText(entry.code) === entry.text) return;
  if (prompts.hasOperatorEntry(entry.code)) await prompts.update(entry.code, entry.description, entry.text);
  else await prompts.create(entry.code, entry.description, entry.text);
}

async function writeWorkflow(library: WorkflowLibrary, workflow: PlannedWorkflow): Promise<void> {
  const existing = library.list().find((entry) => entry.name === workflow.name && !entry.bundled);
  if (existing?.text !== workflow.text) await library.save(workflow.name, workflow.text);
}

async function pinInFlight(deps: SettingsMigrationDeps): Promise<void> {
  const workspaces = new Map((await deps.workspaces.list()).map((workspace) => [workspace.id, workspace]));
  const config = deps.settings.getGlobal();
  const names = new Set(deps.workflows.list().map((entry) => entry.name));
  const inFlight = (await deps.tasks.list({ state: [...IN_FLIGHT_STATES] })).filter((task) => task.workflowRef === null);
  await forEachYielding(inFlight, async (task: TaskRow) => {
    const workspace = workspaces.get(task.workspaceId ?? -1) ?? null;
    const assignment = resolveTaskWorkflow(task, workspace, config, (name) => names.has(name));
    if (!assignment) return;
    const entry = deps.workflows.get(assignment.name);
    const vars = resolveVars(parseWorkflow(entry.text).vars, workspaceVarsFor(workspace, assignment.name), task.workflowVarOverrides);
    await deps.tasks.pinWorkflow(task.id, `${entry.name}@${entry.version}`, assignment.chosen, assignment.label ?? null, vars);
  });
}

// The done-marker is written last so a crash at any point converges on re-run.
export async function migrateSettingsToWorkflows(deps: SettingsMigrationDeps): Promise<void> {
  const done = await deps.db.read((d) => d.select({ value: settings.value }).from(settings).where(eq(settings.key, SETTINGS_MIGRATION_MARKER)).get());
  if (done) return;
  const plan = await planSettingsMigration({
    config: deps.settings.getGlobal(),
    workspaces: await deps.workspaces.list(),
    promptText: (code) => deps.prompts.operatorText(code),
  });
  await forEachYielding(plan.prompts, (entry) => writePrompt(deps.prompts, entry));
  await forEachYielding(plan.workflows, (workflow) => writeWorkflow(deps.workflows, workflow));
  await forEachYielding(plan.workspaceWorkflows, async ({ workspaceId, workflow }) => {
    if (deps.settings.getOverrides(workspaceId).workflow === null) await deps.settings.setOverrides(workspaceId, { workflow });
    await deps.onWorkspaceDefaultWritten?.(workspaceId);
  });
  if (deps.settings.getGlobal().defaults.workflow === null) await deps.settings.setDefaultWorkflow(plan.globalWorkflow);
  await pinInFlight(deps);
  await deps.db.write((d) => d.insert(settings).values({ key: SETTINGS_MIGRATION_MARKER, value: 'done' }).onConflictDoNothing().run());
}
