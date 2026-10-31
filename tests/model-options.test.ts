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

  it('applies the same checks to Workspace overlay options and ids already used globally', async () => {
    await server.api('PATCH', '/api/config', { modelOptions: [option('global-one')] });
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    const local = (o: ReturnType<typeof option>) => ({ kind: 'local', enabled: true, modelOption: o });
    const bad = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [local(option('w', { model: 'nope' }))] });
    expect(bad.status).toBe(400);
    const dup = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [local(option('global-one'))] });
    expect(dup.status).toBe(400);
    const overlay = [local(option('local')), { kind: 'global', ref: 'global-one', enabled: false }];
    const ok = await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: overlay, classifierEnabled: true, classifierBackend: 'typesafe', classifierTimeoutSeconds: 12, classifierHarness: 'claude', classifierModel: claudeModel() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ modelOptions: overlay, classifierEnabled: true, classifierBackend: 'typesafe', classifierTimeoutSeconds: 12, classifierHarness: 'claude', classifierModel: claudeModel() });
    const bounded = await server.api('PATCH', `/api/workspaces/${wsId}`, { classifierTimeoutSeconds: 0 });
    expect(bounded.status).toBe(400);
  });

  it('runs a Test classifier against the unsaved settings on the chosen Harness and Model, saving and charging nothing', async () => {
    await server.close();
    const seen: Array<{ harnessId: string; model: string; prompt: string; denyPermissions?: boolean | undefined }> = [];
    server = await startServer(undefined, {
      criticDrive: {
        run: async (req) => {
          seen.push({ harnessId: req.harnessId, model: req.model, prompt: req.prompt, denyPermissions: req.denyPermissions });
          return { output: '{"optionId":"deep","reason":"Spans many files"}', permissionRequests: [], usage: { inputTokens: 10, outputTokens: 5 } };
        },
      },
    });
    await server.api('PATCH', '/api/config', { modelOptions: [option('quick', { description: 'tiny fixes' }), option('deep', { description: 'hard refactors' })] });
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    const before = (await server.api('GET', `/api/workspaces/${wsId}`)).body;

    const chosen = await server.api('POST', `/api/workspaces/${wsId}/classifier-test`, {
      settings: { classifierBackend: 'harness', classifierHarness: 'claude', classifierModel: claudeModel(), modelOptions: [{ kind: 'global', ref: 'quick', enabled: false }, { kind: 'global', ref: 'deep', enabled: true }] },
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ outcome: 'chosen', optionId: 'deep', reason: 'Spans many files' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ harnessId: 'claude', model: claudeModel(), denyPermissions: true });
    expect(seen[0]!.prompt).toContain('- deep: hard refactors');
    expect(seen[0]!.prompt).not.toContain('- quick:');
    expect(chosen.body.prompt).toBe(seen[0]!.prompt);

    expect((await server.api('GET', `/api/workspaces/${wsId}`)).body).toEqual(before);
    expect((await server.api('GET', '/api/tasks')).body.total).toBe(0);

    const none = await server.api('POST', `/api/workspaces/${wsId}/classifier-test`, {
      settings: { modelOptions: [{ kind: 'global', ref: 'quick', enabled: false }, { kind: 'global', ref: 'deep', enabled: false }] },
    });
    expect(none.body).toMatchObject({ outcome: 'abstained', optionId: null, reason: 'no Model Options are configured', prompt: null });
    expect(seen).toHaveLength(1);

    const invalid = await server.api('POST', `/api/workspaces/${wsId}/classifier-test`, {
      settings: { modelOptions: [{ kind: 'local', enabled: true, modelOption: option('deep') }] },
    });
    expect(invalid.status).toBe(400);
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
    await server.api('PATCH', `/api/workspaces/${wsId}`, { modelOptions: [{ kind: 'local', enabled: true, modelOption: option('w1') }] });
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

  it('migrates a stored Workspace list of plain options to an overlay, globals first', async () => {
    const config = { ...baselineConfig(), modelOptions: [option('g1')] };
    writeFileSync(join(dir, 'settings.yaml'), stringify({ global: config, workspaces: { 1: { modelOptions: [option('mine')] } } }));
    const store = await SettingsStore.create(dir);
    expect(store.getOverrides(1).modelOptions).toEqual([
      { kind: 'global', ref: 'g1', enabled: true },
      { kind: 'local', enabled: true, modelOption: option('mine') },
    ]);
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

  const overlayWs = (overlay: unknown[]) => ({ modelOptions: JSON.stringify(overlay) });
  const mine = { kind: 'local', enabled: true, modelOption: option('mine') };

  it('resolves an overlay in its own order, drops disabled globals and appends globals it does not name', () => {
    expect(resolveModelOptions(null, config).map((o) => o.id)).toEqual(['g1', 'g2']);
    expect(resolveModelOptions(overlayWs([mine, { kind: 'global', ref: 'g2', enabled: true }]), config).map((o) => o.id)).toEqual(['mine', 'g2', 'g1']);
    expect(resolveModelOptions(overlayWs([{ kind: 'global', ref: 'g1', enabled: false }, mine]), config).map((o) => o.id)).toEqual(['mine', 'g2']);
    expect(resolveModelOptions(overlayWs([]), config).map((o) => o.id)).toEqual(['g1', 'g2']);
  });

  it('resolves Ticket over Workspace over global', () => {
    const workspace = overlayWs([{ kind: 'local', enabled: true, modelOption: option('mine', { model: 'ws-model', description: 'ws' }) }]);
    const ticketOverrides = [{ id: 'mine', harness: 'codex', model: 'ticket-model' }];
    expect(resolveModelOption('g2', { config })).toMatchObject({ kind: 'found', scope: 'global' });
    expect(resolveModelOption('mine', { config, workspace })).toMatchObject({ kind: 'found', scope: 'workspace', option: { model: 'ws-model' } });
    expect(resolveModelOption('mine', { config, workspace, ticketOverrides })).toMatchObject({
      kind: 'found', scope: 'ticket', option: { id: 'mine', harness: 'codex', model: 'ticket-model', description: 'ws' },
    });
    expect(resolveModelOptions(workspace, config, ticketOverrides)[0]).toMatchObject({ harness: 'codex', model: 'ticket-model' });
  });

  it('returns a typed miss for missing and disabled codes', () => {
    expect(resolveModelOption('zzz', { config })).toEqual({ kind: 'miss', reason: 'missing', code: 'zzz' });
    expect(resolveModelOption('g1', { config, workspace: overlayWs([{ kind: 'global', ref: 'g1', enabled: false }]) })).toEqual({ kind: 'miss', reason: 'disabled', code: 'g1' });
  });

  it('defaults to off, harness backend and a 30 s timeout, and rejects non-positive timeouts', () => {
    expect(resolveClassifierSettings({ classifierEnabled: null, classifierBackend: null, classifierTimeoutSeconds: null, classifierTypesafeModel: null, classifierTypesafeSecret: null, classifierHarness: null, classifierModel: null })).toEqual({ enabled: false, backend: 'harness', timeoutSeconds: 30, typesafeModel: 'typesafe/jev-1.13', typesafeSecret: null, harness: null, model: null });
    expect(workspaceOverridesSchema.safeParse({ classifierTimeoutSeconds: 0 }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ classifierTimeoutSeconds: -5 }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ classifierTimeoutSeconds: 5 }).success).toBe(true);
  });
});
