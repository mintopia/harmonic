import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { appConfigSchema, baselineConfig } from '../src/config.js';
import { resolveClassifierSettings, resolveModelOption, resolveModelOptions } from '../src/domain/model-options.js';
import { workspaceOverridesSchema } from '../src/domain/workspaces.js';
import { SettingsStore } from '../src/server/settings-store.js';
import { startServer, type TestServer } from './helpers.js';

const claudeModel = () => baselineConfig().harnesses.claude.models[0]!.id;
const option = (id: string, extra: Record<string, unknown> = {}) => ({ id, harness: 'claude', model: claudeModel(), description: 'cheap, small fixes', ...extra });

describe('Model Options API', () => {
  let server: TestServer;
  beforeEach(async () => { server = await startServer(); });
  afterEach(async () => { await server.close(); });

  it('round-trips through PATCH and GET', async () => {
    const patched = await server.api('PATCH', '/api/config', { modelOptions: [option('cheap-fix')] });
    expect(patched.status).toBe(200);
    expect(patched.body.modelOptions).toEqual([option('cheap-fix')]);
    expect((await server.api('GET', '/api/config')).body.modelOptions).toEqual([option('cheap-fix')]);
  });

  it('refuses an option whose Harness is not configured, with the unconfigured-Harness wording', async () => {
    const res = await server.api('PATCH', '/api/config', { modelOptions: [option('x', { harness: 'nope', model: 'gpt-5' })] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Harness 'nope' is not configured.");
  });

  it('refuses an option whose Model is outside the Harness catalog', async () => {
    const res = await server.api('PATCH', '/api/config', { modelOptions: [option('bad', { model: 'no-such-model' })] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("model 'no-such-model' is not in the claude harness's model list");
    expect((await server.api('GET', '/api/config')).body.modelOptions).toEqual([]);
  });

  it('refuses duplicate ids', async () => {
    const res = await server.api('PATCH', '/api/config', { modelOptions: [option('a'), option('a')] });
    expect(res.status).toBe(400);
  });

  it('applies the same checks to Workspace options and ids already used globally', async () => {
    await server.api('PATCH', '/api/config', { modelOptions: [option('global-one')] });
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    const bad = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [option('w', { model: 'nope' })] });
    expect(bad.status).toBe(400);
    const dup = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [option('x'), option('x')] });
    expect(dup.status).toBe(400);
    const shadow = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [option('global-one', { disabled: true })] });
    expect(shadow.status).toBe(200);
    const ok = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [option('local')], classifierEnabled: true, classifierBackend: 'typesafe', classifierTimeoutSeconds: 12 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ modelOptions: [option('local')], classifierEnabled: true, classifierBackend: 'typesafe', classifierTimeoutSeconds: 12 });
    const bounded = await server.api('PATCH', `/api/workspaces/${wsId}`, { classifierTimeoutSeconds: 0 });
    expect(bounded.status).toBe(400);
  });
});

describe('Ticket Model Option overrides API', () => {
  let server: TestServer;
  beforeEach(async () => { server = await startServer(); });
  afterEach(async () => { await server.close(); });

  const override = (id: string, extra: Record<string, unknown> = {}) => ({ id, harness: 'claude', model: claudeModel(), ...extra });

  it('persists overrides for defined codes, replaces the list and returns [] when none', async () => {
    await server.api('PATCH', '/api/config', { modelOptions: [option('g1')] });
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [option('w1')] });
    const task = (await server.api('POST', '/api/tasks', { prompt: 'x', state: 'draft' })).body;
    expect(task.modelOptionOverrides).toEqual([]);
    const set = await server.api('PATCH', `/api/tasks/${task.id}`, { modelOptionOverrides: [override('g1'), override('w1')] });
    expect(set.status).toBe(200);
    expect(set.body.modelOptionOverrides).toEqual([override('g1'), override('w1')]);
    expect((await server.api('GET', `/api/tasks/${task.id}`)).body.modelOptionOverrides).toEqual([override('g1'), override('w1')]);
    const replaced = await server.api('PATCH', `/api/tasks/${task.id}`, { modelOptionOverrides: [override('g1')] });
    expect(replaced.body.modelOptionOverrides).toEqual([override('g1')]);
    const cleared = await server.api('PATCH', `/api/tasks/${task.id}`, { modelOptionOverrides: [] });
    expect(cleared.body.modelOptionOverrides).toEqual([]);
  });

  it('refuses a code defined nowhere, duplicates, an unconfigured Harness and an unlisted Model', async () => {
    await server.api('PATCH', '/api/config', { modelOptions: [option('g1')] });
    const task = (await server.api('POST', '/api/tasks', { prompt: 'x', state: 'draft' })).body;
    for (const list of [[override('nowhere')], [override('g1'), override('g1')], [override('g1', { harness: 'nope' })], [override('g1', { model: 'no-such-model' })]]) {
      const res = await server.api('PATCH', `/api/tasks/${task.id}`, { modelOptionOverrides: list });
      expect(res.status).toBe(400);
    }
    expect((await server.api('GET', `/api/tasks/${task.id}`)).body.modelOptionOverrides).toEqual([]);
  });
});

describe('Model Options persistence and validation in the config file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harmonic-model-options-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists across a restart', async () => {
    const store = await SettingsStore.create(dir);
    await store.updateGlobal({ modelOptions: [option('cheap-fix')] } as never);
    const reopened = await SettingsStore.create(dir);
    expect(reopened.getGlobal().modelOptions).toEqual([option('cheap-fix')]);
  });

  it('fails config validation on a hand-edited invalid option, naming the path', async () => {
    const bad = { ...baselineConfig(), modelOptions: [option('x', { model: 'no-such-model' })] };
    writeFileSync(join(dir, 'settings.yaml'), stringify({ global: bad, workspaces: {} }));
    await expect(SettingsStore.create(dir)).rejects.toThrow(/modelOptions/);
    expect(appConfigSchema.safeParse(bad).error?.issues[0]?.path).toEqual(['modelOptions', 0, 'model']);
  });
});

describe('Workspace resolution', () => {
  const config = { ...baselineConfig(), modelOptions: [option('g1'), option('g2')] } as ReturnType<typeof baselineConfig>;
  const ws = (...options: ReturnType<typeof option>[]) => ({ modelOptions: JSON.stringify(options) });

  it('shadows by code in place and appends Workspace-only codes', () => {
    expect(resolveModelOptions(null, config).map((o) => o.id)).toEqual(['g1', 'g2']);
    expect(resolveModelOptions(ws(option('mine')), config).map((o) => o.id)).toEqual(['g1', 'g2', 'mine']);
    const shadowed = resolveModelOptions(ws(option('g1', { description: 'ws' }), option('mine')), config);
    expect(shadowed.map((o) => [o.id, o.description])).toEqual([['g1', 'ws'], ['g2', 'cheap, small fixes'], ['mine', 'cheap, small fixes']]);
  });

  it('removes disabled codes from the list', () => {
    expect(resolveModelOptions(ws(option('g1', { disabled: true })), config).map((o) => o.id)).toEqual(['g2']);
  });

  it('resolves Ticket over Workspace over global', () => {
    const workspace = ws(option('g1', { model: 'ws-model', description: 'ws' }));
    const ticketOverrides = [{ id: 'g1', harness: 'codex', model: 'ticket-model' }];
    expect(resolveModelOption('g2', { config })).toMatchObject({ kind: 'found', scope: 'global' });
    expect(resolveModelOption('g1', { config, workspace })).toMatchObject({ kind: 'found', scope: 'workspace', option: { model: 'ws-model' } });
    expect(resolveModelOption('g1', { config, workspace, ticketOverrides })).toMatchObject({
      kind: 'found', scope: 'ticket', option: { id: 'g1', harness: 'codex', model: 'ticket-model', description: 'ws' },
    });
    expect(resolveModelOptions(workspace, config, ticketOverrides)[0]).toMatchObject({ harness: 'codex', model: 'ticket-model' });
  });

  it('returns a typed miss for missing and disabled codes', () => {
    expect(resolveModelOption('zzz', { config })).toEqual({ kind: 'miss', reason: 'missing', code: 'zzz' });
    expect(resolveModelOption('g1', { config, workspace: ws(option('g1', { disabled: true })) })).toEqual({ kind: 'miss', reason: 'disabled', code: 'g1' });
  });

  it('defaults to off, harness backend and a 30 s timeout, and rejects non-positive timeouts', () => {
    expect(resolveClassifierSettings({ classifierEnabled: null, classifierBackend: null, classifierTimeoutSeconds: null, classifierTypesafeModel: null, classifierTypesafeSecret: null })).toEqual({ enabled: false, backend: 'harness', timeoutSeconds: 30, typesafeModel: 'typesafe/jev-1.13', typesafeSecret: null });
    expect(workspaceOverridesSchema.safeParse({ classifierTimeoutSeconds: 0 }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ classifierTimeoutSeconds: -5 }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ classifierTimeoutSeconds: 5 }).success).toBe(true);
  });
});
