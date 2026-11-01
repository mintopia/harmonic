import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../src/db/schema.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { EPIC_SETTINGS_MIGRATION_MARKER, migrateEpicSettingsToWorkflows } from '../src/domain/epic-settings-workflow-migration.js';
import { UnconvertibleSettingError } from '../src/domain/settings-workflow-migration.js';
import * as yielding from '../src/reliability/yield.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';
import { openHarness, seedOldSettings, treeOf, type Harness, type Seed } from './helpers/settings-migration-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
const open: Harness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of open.splice(0)) await harness.db.close();
  cleanupAll();
});

const command = (id: string, name: string, args: string[], extra: Record<string, unknown> = {}) => ({ id, command: name, args, env: {}, timeoutSeconds: 600, ...extra });
const critic = (extra: Record<string, unknown> = {}) => ({ id: 'ec-1', name: 'Epic review', harness: 'claude', model: 'claude-sonnet-5-5', timeoutSeconds: 300, prompt: 'Review epic {ref}: {title}.', ...extra });

const GLOBAL_EPIC = {
  maxAttempts: 4,
  verify: { epic: { preMerge: { commands: [command('ec-test', 'npm', ['test'])], critics: [critic()] }, resolveSuffix: 'Stay on `{branch}` and be brief.' } },
} as unknown as NonNullable<Seed['global']>;

async function boot(seed: Seed): Promise<Harness> {
  const dir = tempDir('harmonic-epic-migration-');
  await seedOldSettings(dir, seed);
  const harness = await openHarness(dir);
  open.push(harness);
  return harness;
}

const migrate = (harness: Harness) => migrateEpicSettingsToWorkflows(harness.deps);
const workflowDef = (harness: Harness, name: string) => parseWorkflow(readFileSync(join(harness.dir, 'workflows', `${name}.yaml`), 'utf8'));

describe('Epic settings to workflows migration', () => {
  it('turns the global Epic settings into a Migrated Epic (global) workflow selected as the global Epic workflow', async () => {
    const harness = await boot({ global: GLOBAL_EPIC });

    await migrate(harness);

    const def = workflowDef(harness, 'migrated-epic-global');
    expect(def.subject).toBe('epic');
    expect(def.description).toBe('Migrated Epic (global)');
    expect(harness.settings.getGlobal().defaults.epicWorkflow).toBe('migrated-epic-global');
    expect(readFileSync(join(harness.dir, 'workflows', 'migrated-epic-global.yaml'), 'utf8')).toContain('run: npm test');
    expect(readFileSync(join(harness.dir, 'prompts', 'migrated-epic-global-epic-resolve.json'), 'utf8')).toContain('Stay on `{branch}` and be brief.');
  });

  it('feeds the configured Epic commands to the post-merge check and reports the failing verification to the resolver', async () => {
    const harness = await boot({ global: GLOBAL_EPIC });

    await migrate(harness);

    const post = workflowDef(harness, 'migrated-epic-global').steps.find((step) => step.id === 'post-merge-check');
    expect(post?.with).toEqual({ run: 'npm test' });
    expect(readFileSync(join(harness.dir, 'prompts', 'migrated-epic-global-epic-resolve.json'), 'utf8')).toContain('## Failing Epic verification\\n{reason}');
  });

  it('carries the old maxAttempts value into the workflow attempts limit', async () => {
    const harness = await boot({ global: GLOBAL_EPIC, workspaces: [{ name: 'Gamma', overrides: { maxAttempts: 6 } }] });

    await migrate(harness);

    expect(workflowDef(harness, 'migrated-epic-global').vars).toMatchObject({ maxAttempts: 4 });
    expect(workflowDef(harness, 'migrated-epic-gamma').vars).toMatchObject({ maxAttempts: 6 });
  });

  it('selects a Workspace its own Migrated Epic workflow only when its overlays change something', async () => {
    const harness = await boot({
      global: GLOBAL_EPIC,
      workspaces: [
        { name: 'Alpha App', overrides: { epicPreMergeCommands: [{ kind: 'global', ref: 'ec-test', enabled: false }, { kind: 'local', enabled: true, command: command('ec-make', 'make', ['check']) }] } },
        { name: 'Plain', overrides: { priority: 'high' } },
      ],
    });

    await migrate(harness);

    const [alpha, plain] = (await harness.workspaceService.list()).map((w) => harness.settings.getOverrides(w.id).epicWorkflow);
    expect([alpha, plain]).toEqual(['migrated-epic-alpha-app', null]);
    const text = readFileSync(join(harness.dir, 'workflows', 'migrated-epic-alpha-app.yaml'), 'utf8');
    expect(workflowDef(harness, 'migrated-epic-alpha-app').description).toBe('Migrated Epic (Alpha App)');
    expect(text).toContain('run: make check');
    expect(text).not.toContain('npm test');
  });

  it('is idempotent: a re-run writes nothing and the marker survives', async () => {
    const harness = await boot({ global: GLOBAL_EPIC, workspaces: [{ name: 'Gamma', overrides: { maxAttempts: 6 } }] });
    await migrate(harness);
    const after = treeOf(harness.dir);

    await migrate(harness);

    expect(treeOf(harness.dir)).toEqual(after);
    const row = await harness.db.read((d) => d.select().from(settings).where(eq(settings.key, EPIC_SETTINGS_MIGRATION_MARKER)).get());
    expect(row).toMatchObject({ value: 'done' });
  });

  it('refuses to start on an unconvertible setting, naming it, and writes nothing', async () => {
    const harness = await boot({ global: { verify: { epic: { preMerge: { commands: [command('ec-slow', 'npm', ['test'], { timeoutSeconds: 900 })], critics: [] } } } } as never });
    const before = treeOf(harness.dir);

    const failure = await migrate(harness).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnconvertibleSettingError);
    expect((failure as Error).message).toContain('verify.epic.preMerge.commands[0].timeoutSeconds');
    expect(treeOf(harness.dir)).toEqual(before);
    expect(await harness.db.read((d) => d.select().from(settings).where(eq(settings.key, EPIC_SETTINGS_MIGRATION_MARKER)).get())).toBeUndefined();
  });

  it('yields to the event loop between Workspaces', async () => {
    const harness = await boot({ global: GLOBAL_EPIC, workspaces: [{ name: 'A', overrides: { maxAttempts: 5 } }, { name: 'B', overrides: { maxAttempts: 6 } }] });
    const spy = vi.spyOn(yielding, 'forEachYielding');

    await migrate(harness);

    const workspaceCall = spy.mock.calls.find(([items]) => (items as readonly { name?: string }[]).some((item) => item.name === 'A'));
    expect(workspaceCall).toBeDefined();
  });
});
