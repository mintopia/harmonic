import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { settings, tasks } from '../src/db/schema.js';
import { baselineConfig, mergeConfig, type AppConfig, type DeepPartial } from '../src/config.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { planSettingsMigration, SETTINGS_MIGRATION_MARKER, UnconvertibleSettingError } from '../src/domain/settings-workflow-migration.js';
import { SettingsStore } from '../src/server/settings-store.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';
import { EDITED_GLOBAL, FIXTURE_WORKSPACES, migrate, openHarness, seedOldSettings, treeOf, type Harness, type Seed } from './helpers/settings-migration-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.db.close();
  cleanupAll();
});

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/settings-workflow-migration/${name}`, import.meta.url), 'utf8');

async function boot(seed: Seed, extra: Parameters<typeof openHarness>[1] = {}): Promise<Harness> {
  const dir = tempDir('harmonic-settings-migration-');
  await seedOldSettings(dir, seed);
  const harness = await openHarness(dir, extra);
  open.push(harness);
  return harness;
}

const markerRow = (harness: Harness) => harness.db.read((d) => d.select().from(settings).where(eq(settings.key, SETTINGS_MIGRATION_MARKER)).get());

describe('settings to workflows migration', () => {
  it('turns default settings into a Migrated (global) workflow that is the global default', async () => {
    const harness = await boot({});

    await migrate(harness);

    expect(readFileSync(join(harness.dir, 'workflows', 'migrated-global.yaml'), 'utf8')).toBe(fixture('default-migrated-global.yaml'));
    expect(harness.settings.getGlobal().defaults.workflow).toBe('migrated-global');
  });

  it('writes workflow and prompt files matching the fixtures for edited global settings and Workspace overrides', async () => {
    const harness = await boot({ global: EDITED_GLOBAL, workspaces: FIXTURE_WORKSPACES });

    await migrate(harness);

    const workflows = readdirSync(join(harness.dir, 'workflows')).filter((f) => f.endsWith('.yaml'));
    expect(workflows).toEqual(['migrated-alpha-app.yaml', 'migrated-beta-service.yaml', 'migrated-global.yaml']);
    for (const file of workflows) expect(readFileSync(join(harness.dir, 'workflows', file), 'utf8')).toBe(fixture(`edited-${file}`));
    const prompts = Object.fromEntries(readdirSync(join(harness.dir, 'prompts')).sort().map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(harness.dir, 'prompts', f), 'utf8')) as unknown]));
    expect(prompts).toEqual(JSON.parse(fixture('edited-prompts.json')));
  });

  it('defaults a Workspace to its own workflow only when its overrides change something', async () => {
    const harness = await boot({ global: EDITED_GLOBAL, workspaces: FIXTURE_WORKSPACES });

    await migrate(harness);

    const [alpha, plain, beta] = (await harness.workspaceService.list()).map((w) => harness.settings.getOverrides(w.id).workflow);
    expect([alpha, plain, beta]).toEqual(['migrated-alpha-app', null, 'migrated-beta-service']);
    expect(await markerRow(harness)).toMatchObject({ value: 'done' });
  });

  it('is a no-op the second time, even with the done-marker gone', async () => {
    const harness = await boot({ global: EDITED_GLOBAL, workspaces: FIXTURE_WORKSPACES });
    await migrate(harness);
    const first = treeOf(harness.dir);

    await migrate(harness);
    expect(treeOf(harness.dir)).toEqual(first);

    await harness.db.write((d) => d.delete(settings).where(eq(settings.key, SETTINGS_MIGRATION_MARKER)).run());
    await migrate(harness);
    expect(treeOf(harness.dir)).toEqual(first);
  });

  it('converges when a crash follows the second Workspace and the migration runs again', async () => {
    const seed = { global: EDITED_GLOBAL, workspaces: [...FIXTURE_WORKSPACES, { name: 'Gamma', overrides: { maxAttempts: 4 } }] };
    const clean = await boot(seed);
    await migrate(clean);

    let seen = 0;
    const crashing = await boot(seed, {
      onWorkspaceDefaultWritten: async () => {
        if (++seen === 2) throw new Error('crash after the second Workspace');
      },
    });
    await expect(migrate(crashing)).rejects.toThrow('crash after the second Workspace');
    expect(await markerRow(crashing)).toBeUndefined();
    expect(crashing.settings.getOverrides(1).workflow).toBe('migrated-alpha-app');
    expect(crashing.settings.getOverrides(4).workflow).toBeNull();

    const rebooted = await openHarness(crashing.dir);
    open.push(rebooted);
    await migrate(rebooted);

    expect(rebooted.settings.getOverrides(4).workflow).toBe('migrated-gamma');
    expect(await markerRow(rebooted)).toMatchObject({ value: 'done' });
    const normalise = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).filter(([path]) => path !== 'settings.yaml'));
    expect(normalise(treeOf(crashing.dir))).toEqual(normalise(treeOf(clean.dir)));
    expect(parse(treeOf(crashing.dir)['settings.yaml']!)).toEqual(parse(treeOf(clean.dir)['settings.yaml']!));
  });

  it('yields to the event loop across 500 Workspaces: a timer scheduled first fires before the migration finishes', async () => {
    const harness = await boot({ workspaces: Array.from({ length: 500 }, (_, i) => ({ name: `Workspace ${i}`, overrides: { maxAttempts: 3 + (i % 5) } })) });
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);

    await migrate(harness);
    order.push('finished');

    expect(order.indexOf('timer')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('timer')).toBeLessThan(order.indexOf('finished'));
    expect(readdirSync(join(harness.dir, 'workflows')).filter((f) => f.endsWith('.yaml'))).toHaveLength(501);
  }, 60_000);

  it('leaves every old settings.yaml key byte-identical', async () => {
    const harness = await boot({ global: { ...EDITED_GLOBAL, defaults: { priority: 'high' } }, workspaces: FIXTURE_WORKSPACES });
    const before = readFileSync(join(harness.dir, 'settings.yaml'), 'utf8');

    await migrate(harness);

    const after = readFileSync(join(harness.dir, 'settings.yaml'), 'utf8');
    expect(after).not.toBe(before);
    expect(after.split('\n').filter((line) => !/^\s+workflow: migrated-/.test(line)).join('\n')).toBe(before);
  });

  it('does not rewrite a hand-formatted settings.yaml when a boot changes nothing', async () => {
    const dir = tempDir('harmonic-settings-bytes-');
    const text = '# kept by the operator\nglobal:\n    maxAttempts: 3   # three tries\nworkspaces: {}\n';
    writeFileSync(join(dir, 'settings.yaml'), text);

    await SettingsStore.create(dir);

    expect(readFileSync(join(dir, 'settings.yaml'), 'utf8')).toBe(text);
  });

  it('pins in-flight Tickets to the migrated workflow of their Workspace and leaves ready ones unpinned', async () => {
    const harness = await boot({ workspaces: [{ name: 'Alpha App', overrides: { maxAttempts: 5 } }, { name: 'Plain' }] });
    const [alphaId, plainId] = (await harness.workspaceService.list()).map((w) => w.id);
    const make = async (workspaceId: number | undefined, state: 'ready' | 'working' | 'paused') => {
      const task = await harness.tasks.create({ prompt: `${state} in ${workspaceId}`, workspaceId, state: 'ready' });
      await harness.db.write((d) => d.update(tasks).set({ state }).where(eq(tasks.id, task.id)).run());
      return task.id;
    };
    const alphaWorking = await make(alphaId, 'working');
    const plainPaused = await make(plainId, 'paused');
    const alphaReady = await make(alphaId, 'ready');

    await migrate(harness);

    expect(await harness.tasks.get(alphaWorking)).toMatchObject({ workflowRef: 'migrated-alpha-app@1', workflowChosen: 'workspace', workflowVars: { maxAttempts: 5 } });
    expect(await harness.tasks.get(plainPaused)).toMatchObject({ workflowRef: 'migrated-global@1', workflowChosen: 'global', workflowVars: { maxAttempts: 2 } });
    expect((await harness.tasks.get(alphaReady)).workflowRef).toBeNull();
  });

  describe('Merge Fate and post-merge steps', () => {
    const planned = async (patch: DeepPartial<AppConfig>) => {
      const plan = await planSettingsMigration({ config: mergeConfig(baselineConfig(), patch), workspaces: [], promptText: () => undefined });
      return parseWorkflow(plan.workflows[0]!.text);
    };

    it('open-PR ends with open-pr and keeps the branch: no cleanup, no ticket close', async () => {
      const workflow = await planned({ drive: { mergeFate: 'open-PR' } });

      expect(workflow.steps.map((step) => step.id)).toEqual(['rebase', 'build', 'open-pr']);
      expect(workflow.cleanup).toBeUndefined();
    });

    it('runs post-merge Critics after the post-merge check', async () => {
      const critic = { id: 'critic-post', name: 'Post', harness: 'claude' as const, model: 'claude-sonnet-5-5', timeoutSeconds: 300, issuePrompt: 'Review it.', noIssuePrompt: 'Review it.' };
      const command = { id: 'cmd-post', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };

      const workflow = await planned({ verify: { task: { postMerge: { commands: [command], critics: [critic] } } } });

      expect(workflow.steps.map((step) => step.id)).toEqual(['rebase', 'build', 'merge', 'post-merge-check', 'post-critic-1', 'close-ticket']);
    });
  });

  describe('a setting that cannot convert', () => {
    const expectNothingWritten = async (harness: Harness, before: Record<string, string>) => {
      expect(treeOf(harness.dir)).toEqual(before);
      expect(await markerRow(harness)).toBeUndefined();
    };

    it('refuses with an error naming maxAttempts and writes nothing', async () => {
      const harness = await boot({ global: { maxAttempts: 25 }, workspaces: FIXTURE_WORKSPACES });
      const before = treeOf(harness.dir);

      const failure = await migrate(harness).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(UnconvertibleSettingError);
      expect((failure as Error).message).toContain('maxAttempts');
      await expectNothingWritten(harness, before);
    });

    it('names the Workspace and the setting when only a Workspace override is unconvertible, and still writes nothing', async () => {
      const slow = { id: 'cmd-slow', command: 'make', args: ['slow'], env: {}, timeoutSeconds: 30 };
      const harness = await boot({ workspaces: [{ name: 'Fine', overrides: { maxAttempts: 4 } }, { name: 'Slow', overrides: { taskPreMergeCommands: [{ kind: 'local', enabled: true, command: slow }] } }] });
      const before = treeOf(harness.dir);

      const failure = await migrate(harness).catch((error: unknown) => error);

      expect((failure as Error).message).toContain('Workspace "Slow"');
      expect((failure as Error).message).toContain('verify.task.preMerge.commands[0].timeoutSeconds');
      await expectNothingWritten(harness, before);
    });

    it('refuses prompt text that a workflow would evaluate', async () => {
      const harness = await boot({ global: { drive: { prompt: 'Resolve ${{ secrets.TOKEN }}' } } });

      const before = treeOf(harness.dir);

      await expect(migrate(harness)).rejects.toThrow(/drivePrompt/);
      await expectNothingWritten(harness, before);
    });
  });
});
