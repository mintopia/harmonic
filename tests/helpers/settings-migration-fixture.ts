import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../../src/db/async.js';
import { workspaces } from '../../src/db/schema.js';
import { baselineConfig, type AppConfig, type DeepPartial } from '../../src/config.js';
import { PromptLibrary } from '../../src/domain/prompt-library-store.js';
import { convertEditedPrompts } from '../../src/domain/prompt-library-sources.js';
import { migrateSettingsToWorkflows, type SettingsMigrationDeps } from '../../src/domain/settings-workflow-migration.js';
import { TaskService } from '../../src/domain/tasks.js';
import { WorkflowLibrary } from '../../src/domain/workflow-library-store.js';
import { WorkspaceService, type WorkspaceOverrides } from '../../src/domain/workspaces.js';
import { SettingsStore } from '../../src/server/settings-store.js';

export interface WorkspaceSeed {
  name: string;
  overrides?: WorkspaceOverrides;
}

export interface Seed {
  global?: DeepPartial<AppConfig>;
  workspaces?: WorkspaceSeed[];
}

const command = (id: string, name: string, args: string[], extra: Record<string, unknown> = {}) => ({ id, command: name, args, env: {}, timeoutSeconds: 600, ...extra });

export const EDITED_GLOBAL: DeepPartial<AppConfig> = {
  maxAttempts: 3,
  drive: { continueAttempts: 4, mergeFate: 'auto-merge', prompt: 'Resolve {ref} carefully: {title}.' },
  promptFragments: { selfHeal: `${baselineConfig().promptFragments.selfHeal}\nBe concise.` },
  verify: {
    task: {
      preMerge: {
        commands: [command('cmd-test', 'npm', ['test']), command('cmd-lint', 'node', ['scripts/lint.mjs', '--mode strict'], { cwd: 'packages/api', env: { CI: '1' } })],
        critics: [
          {
            id: 'critic-correctness',
            name: 'Correctness',
            harness: 'claude',
            model: 'claude-sonnet-5-5',
            timeoutSeconds: 300,
            issuePrompt: 'Review {ref}: {title}. {fragment.criticRole}',
            noIssuePrompt: 'Review task {taskId}: {title}.',
          },
        ],
      },
      postMerge: { commands: [command('cmd-smoke', 'npm', ['run', 'smoke'])], critics: [] },
    },
  },
};

export const FIXTURE_WORKSPACES: WorkspaceSeed[] = [
  { name: 'Alpha App', overrides: { maxAttempts: 5, driveMergeFate: 'artifact', driveUnattendedReminder: 'Alpha runs unattended.' } },
  { name: 'Plain', overrides: { priority: 'high' } },
  {
    name: 'Beta Service',
    overrides: {
      taskPreMergeCommands: [
        { kind: 'global', ref: 'cmd-test', enabled: false },
        { kind: 'local', enabled: true, command: command('cmd-make', 'make', ['check']) },
        { kind: 'global', ref: 'cmd-lint', enabled: true },
      ],
      taskPreMergeCritics: [{ kind: 'global', ref: 'critic-correctness', enabled: false }],
    },
  },
];

export interface Harness {
  dir: string;
  db: AsyncDbHandle;
  settings: SettingsStore;
  prompts: PromptLibrary;
  workflows: WorkflowLibrary;
  workspaceService: WorkspaceService;
  tasks: TaskService;
  deps: SettingsMigrationDeps;
}

export async function seedOldSettings(dir: string, seed: Seed): Promise<number[]> {
  mkdirSync(dir, { recursive: true });
  const db = await openAsyncDb(dir);
  const store = await SettingsStore.create(dir, seed.global);
  const ids: number[] = [];
  for (const [i, workspace] of (seed.workspaces ?? []).entries()) {
    const now = Date.now();
    const row = await db.write((d) => d.insert(workspaces).values({ name: workspace.name, workingDir: join(dir, `repo-${i}`), createdAt: now, updatedAt: now }).returning().get());
    if (workspace.overrides) await store.setOverrides(row.id, workspace.overrides);
    ids.push(row.id);
  }
  await db.close();
  return ids;
}

export async function openHarness(dir: string, extra: Partial<SettingsMigrationDeps> = {}): Promise<Harness> {
  const db = await openAsyncDb(dir);
  const settings = await SettingsStore.create(dir);
  const prompts = new PromptLibrary(dir);
  await prompts.load();
  await convertEditedPrompts(prompts, settings.getGlobal());
  const workflows = new WorkflowLibrary(dir);
  await workflows.load();
  prompts.attachWorkflows(workflows);
  const workspaceService = new WorkspaceService(db, settings);
  const tasks = new TaskService(db, () => settings.getGlobal(), () => workspaceService.list());
  return { dir, db, settings, prompts, workflows, workspaceService, tasks, deps: { db, settings, prompts, workflows, workspaces: workspaceService, tasks, ...extra } };
}

export function migrate(harness: Harness): Promise<void> {
  return migrateSettingsToWorkflows(harness.deps);
}

export function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  for (const sub of ['workflows', 'prompts']) {
    try {
      walk(join(dir, sub));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  out['settings.yaml'] = readFileSync(join(dir, 'settings.yaml'), 'utf8');
  return out;
}
