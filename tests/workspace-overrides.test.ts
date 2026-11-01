import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { DEFAULT_EXCLUDED_DIRECTORIES, workspaceOverridesSchema, WorkspaceService } from '../src/domain/workspaces.js';
import { budgetGuardrailSchema, baselineConfig, mergeConfig } from '../src/config.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { makeSettingsStore, seedWorkspace } from './helpers.js';

describe('WorkspaceService override persistence (issue #64)', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let workspaces: WorkspaceService;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-ws-over-'));
    asyncDb = await openAsyncDb(dataDir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dataDir);
    workspaces = new WorkspaceService(asyncDb, settingsStore);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a fresh Workspace inherits every overridable setting (all null)', async () => {
    const ws = (await workspaces.list())[0]!;
    expect(ws.excludedDirectories).toEqual(DEFAULT_EXCLUDED_DIRECTORIES);
    expect(ws.harness).toBeNull();
    expect(ws.model).toBeNull();
    expect(ws.chatHarness).toBeNull();
    expect(ws.chatModel).toBeNull();
    expect(ws.isolationMode).toBeNull();
    expect(ws.priority).toBeNull();
    expect(ws.maxConcurrentAttempts).toBeNull();
    expect(ws.autoRunnerEnabled).toBeNull();
    expect(ws.agentMessagesEnabled).toBeNull();
    expect(ws.agentMessagesSendCap).toBeNull();
    expect(ws.guardrailBudget).toBeNull();
    expect(ws.guardrailProgress).toBeNull();
    expect(ws.drivePrompt).toBeNull();
    expect(ws.driveUnattendedReminder).toBeNull();
    expect(ws.driveContinuePrompt).toBeNull();
    expect(ws.taskPrompt).toBeNull();
    expect(ws.toolTimeoutMinutes).toBeNull();
  });

  it('persists its excluded directories independently from the default list', async () => {
    const ws = (await workspaces.list())[0]!;
    const updated = await workspaces.update(ws.id, { excludedDirectories: ['generated'] });

    expect(updated.excludedDirectories).toEqual(['generated']);
    expect(settingsStore.getOverrides(ws.id).excludedDirectories).toEqual(['generated']);
  });

  it('seeds new Workspaces with a persisted excluded-directory override', async () => {
    const workingDir = join(dataDir, 'second-workspace');
    mkdirSync(workingDir);
    const created = await workspaces.create({ name: 'Second', workingDir });

    expect(created.excludedDirectories).toEqual(DEFAULT_EXCLUDED_DIRECTORIES);
    expect(settingsStore.getOverrides(created.id).excludedDirectories).toEqual(DEFAULT_EXCLUDED_DIRECTORIES);
  });

  it('seeds new Workspaces from the global excluded-directory list', async () => {
    const seeded = new WorkspaceService(asyncDb, settingsStore, () => ['vendor']);
    const workingDir = join(dataDir, 'third-workspace');
    mkdirSync(workingDir);
    const created = await seeded.create({ name: 'Third', workingDir });

    expect(created.excludedDirectories).toEqual(['vendor']);
    expect(settingsStore.getOverrides(created.id).excludedDirectories).toEqual(['vendor']);
  });

  it('rejects non-canonical excluded directory paths', () => {
    for (const excludedDirectories of [['src/'], ['./src'], ['src//generated'], ['src\\generated'], ['src/../build']]) {
      expect(workspaceOverridesSchema.safeParse({ excludedDirectories }).success).toBe(false);
    }
  });

  it('rejects non-canonical global excluded directory paths before they can seed a Workspace', () => {
    for (const excludedDirectories of [['../x'], ['a//b'], ['./src'], ['src/'], ['src\\generated']]) {
      expect(() => mergeConfig(baselineConfig(), { excludedDirectories })).toThrow(/canonical relative path/);
    }
    expect(mergeConfig(baselineConfig(), { excludedDirectories: ['vendor', 'src/generated'] }).excludedDirectories).toEqual(['vendor', 'src/generated']);
  });

  it('sets explicit overrides', async () => {
    const ws = (await workspaces.list())[0]!;
    const updated = await workspaces.update(ws.id, {
      harness: 'codex',
      model: 'gpt-5',
      chatHarness: 'claude',
      chatModel: 'claude-opus-5',
      isolationMode: 'worktree',
      priority: 'high',
      maxConcurrentAttempts: 2,
      autoRunnerEnabled: true,
    });
    expect(updated.harness).toBe('codex');
    expect(updated.model).toBe('gpt-5');
    expect(updated.chatHarness).toBe('claude');
    expect(updated.chatModel).toBe('claude-opus-5');
    expect(updated.isolationMode).toBe('worktree');
    expect(updated.priority).toBe('high');
    expect(updated.maxConcurrentAttempts).toBe(2);
    expect(updated.autoRunnerEnabled).toBe(true);
  });

  it('overrides the chat default independently of the Task default', async () => {
    const ws = (await workspaces.list())[0]!;
    const updated = await workspaces.update(ws.id, { harness: 'codex', chatHarness: 'claude', chatModel: 'claude-opus-5' });
    expect(updated.harness).toBe('codex');
    expect(updated.chatHarness).toBe('claude');
    expect(updated.chatModel).toBe('claude-opus-5');
    expect(updated.model).toBeNull();
  });

  it('clears an override back to inherit with null', async () => {
    const ws = (await workspaces.list())[0]!;
    await workspaces.update(ws.id, { harness: 'codex', chatHarness: 'claude', maxConcurrentAttempts: 2, autoRunnerEnabled: false });
    const cleared = await workspaces.update(ws.id, {
      harness: null,
      chatHarness: null,
      maxConcurrentAttempts: null,
      autoRunnerEnabled: null,
    });
    expect(cleared.harness).toBeNull();
    expect(cleared.chatHarness).toBeNull();
    expect(cleared.maxConcurrentAttempts).toBeNull();
    expect(cleared.autoRunnerEnabled).toBeNull();
  });

  it('leaves an omitted override untouched (only patches what is sent)', async () => {
    const ws = (await workspaces.list())[0]!;
    await workspaces.update(ws.id, { harness: 'codex', priority: 'low' });
    const renamed = await workspaces.update(ws.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.harness).toBe('codex');
    expect(renamed.priority).toBe('low');
  });

  it('keeps a false autoRunnerEnabled override distinct from inherit (null)', async () => {
    const ws = (await workspaces.list())[0]!;
    const off = await workspaces.update(ws.id, { autoRunnerEnabled: false });
    expect(off.autoRunnerEnabled).toBe(false);
    const untouched = await workspaces.update(ws.id, { name: ws.name });
    expect(untouched.autoRunnerEnabled).toBe(false);
  });

  it('stores, clears, and keeps distinct the Agent Messages overrides', async () => {
    const ws = (await workspaces.list())[0]!;
    const on = await workspaces.update(ws.id, { agentMessagesEnabled: true, agentMessagesSendCap: 3 });
    expect(on.agentMessagesEnabled).toBe(true);
    expect(on.agentMessagesSendCap).toBe(3);
    const off = await workspaces.update(ws.id, { agentMessagesEnabled: false });
    expect(off.agentMessagesEnabled).toBe(false);
    expect(off.agentMessagesSendCap).toBe(3);
    const cleared = await workspaces.update(ws.id, { agentMessagesEnabled: null, agentMessagesSendCap: null });
    expect(cleared.agentMessagesEnabled).toBeNull();
    expect(cleared.agentMessagesSendCap).toBeNull();
  });

  it('keeps a false guardrailProgress override distinct from inherit (null) (issue #165)', async () => {
    const ws = (await workspaces.list())[0]!;
    const on = await workspaces.update(ws.id, { guardrailProgress: true });
    expect(on.guardrailProgress).toBe(true);
    const off = await workspaces.update(ws.id, { guardrailProgress: false });
    expect(off.guardrailProgress).toBe(false);
    const untouched = await workspaces.update(ws.id, { name: ws.name });
    expect(untouched.guardrailProgress).toBe(false);
    const cleared = await workspaces.update(ws.id, { guardrailProgress: null });
    expect(cleared.guardrailProgress).toBeNull();
  });

  it('sets explicit guardrail overrides (issue #126)', async () => {
    const ws = (await workspaces.list())[0]!;
    const updated = await workspaces.update(ws.id, {
      guardrailBudget: budgetGuardrailSchema.parse({ wallClockMinutes: 120 }),
      guardrailProgress: true,
    });
    expect(JSON.parse(updated.guardrailBudget!)).toMatchObject({ wallClockMinutes: 120 });
    expect(updated.guardrailProgress).toBe(true);
  });

  it('clears guardrail overrides back to inherit with null (issue #126)', async () => {
    const ws = (await workspaces.list())[0]!;
    await workspaces.update(ws.id, {
      guardrailBudget: budgetGuardrailSchema.parse({ wallClockMinutes: 120 }),
      guardrailProgress: true,
    });
    const cleared = await workspaces.update(ws.id, { guardrailBudget: null, guardrailProgress: null });
    expect(cleared.guardrailBudget).toBeNull();
    expect(cleared.guardrailProgress).toBeNull();
  });

  it('persists exportRedactPatterns as JSON, reads them back via get(), and clears with null', async () => {
    const ws = (await workspaces.list())[0]!;
    const patterns = [{ id: 'internal-host', regex: 'corp\\.example\\.internal' }];
    const updated = await workspaces.update(ws.id, { exportRedactPatterns: patterns });
    expect(JSON.parse(updated.exportRedactPatterns!)).toEqual(patterns);
    expect(JSON.parse((await workspaces.get(ws.id)).exportRedactPatterns!)).toEqual(patterns);
    const cleared = await workspaces.update(ws.id, { exportRedactPatterns: null });
    expect(cleared.exportRedactPatterns).toBeNull();
  });

  it('keeps a false guardrailProgress override distinct from inherit (null) (issue #126)', async () => {
    const ws = (await workspaces.list())[0]!;
    const off = await workspaces.update(ws.id, { guardrailProgress: false });
    expect(off.guardrailProgress).toBe(false);
    const untouched = await workspaces.update(ws.id, { name: ws.name });
    expect(untouched.guardrailProgress).toBe(false);
  });

  it('sets, clears, and independently patches the drive/taskPrompt/toolTimeout overrides (#339)', async () => {
    const ws = (await workspaces.list())[0]!;
    const set = await workspaces.update(ws.id, {
      drivePrompt: 'WS drive prompt',
      driveUnattendedReminder: 'WS reminder',
      driveContinuePrompt: 'WS continue',
      taskPrompt: 'WS task prompt',
      toolTimeoutMinutes: 45,
    });
    expect(set.drivePrompt).toBe('WS drive prompt');
    expect(set.driveUnattendedReminder).toBe('WS reminder');
    expect(set.driveContinuePrompt).toBe('WS continue');
    expect(set.taskPrompt).toBe('WS task prompt');
    expect(set.toolTimeoutMinutes).toBe(45);

    const renamed = await workspaces.update(ws.id, { name: 'Renamed' });
    expect(renamed.drivePrompt).toBe('WS drive prompt');
    expect(renamed.toolTimeoutMinutes).toBe(45);

    const cleared = await workspaces.update(ws.id, { toolTimeoutMinutes: null });
    expect(cleared.toolTimeoutMinutes).toBeNull();
    expect(cleared.drivePrompt).toBe('WS drive prompt');
  });

  it('persists overrides to the YAML settings store; list()/get() compose them back; delete() removes the entry (issue #391)', async () => {
    const ws = (await workspaces.list())[0]!;
    await workspaces.update(ws.id, { harness: 'codex', maxConcurrentAttempts: 3 });

    expect(settingsStore.getOverrides(ws.id)).toMatchObject({ harness: 'codex', maxConcurrentAttempts: 3 });

    const reopened = new WorkspaceService(asyncDb, settingsStore);
    expect((await reopened.list())[0]).toMatchObject({ harness: 'codex', maxConcurrentAttempts: 3 });
    expect(await reopened.get(ws.id)).toMatchObject({ harness: 'codex', maxConcurrentAttempts: 3 });

    await workspaces.delete(ws.id);
    expect(settingsStore.getOverrides(ws.id)).toEqual({
      excludedDirectories: null,
      harness: null,
      model: null,
      chatHarness: null,
      chatModel: null,
      isolationMode: null,
      priority: null,
      conflictResolveTurns: null,
      maxConcurrentAttempts: null,
      autoRunnerEnabled: null,
      agentMessagesEnabled: null,
      agentMessagesSendCap: null,
      maxAttempts: null,
      contextReuseTokenLimit: null,
      epicWorkflow: null,
      routingLabels: null,
      workflow: null,
      workflowLabels: null,
      workflowVars: null,
      workflowClassifierEnabled: null,
      modelOptions: null,
      executionTargets: null,
      classifierEnabled: null,
      classifierBackend: null,
      classifierTimeoutSeconds: null,
      classifierTypesafeModel: null,
      classifierTypesafeSecret: null,
      classifierHarness: null,
      classifierModel: null,
      classifierEndpoint: null,
      guardrailBudget: null,
      guardrailProgress: null,
      toolTimeoutMinutes: null,
      drivePrompt: null,
      driveUnattendedReminder: null,
      driveContinuePrompt: null,
      taskPrompt: null,
      driveCommitNudge: null,
      mergeConflictPrompt: null,
      mergeEpicConflictPrompt: null,
      mergeEpicRefreshPrompt: null,
      verifyEpicResolveSuffix: null,
      pauseMessage: null,
      exportEnabled: null,
      exportDirectoryPath: null,
      exportS3Endpoint: null,
      exportS3Region: null,
      exportS3Bucket: null,
      exportS3Prefix: null,
      exportS3ForcePathStyle: null,
      exportS3AccessKeyId: null,
      exportS3SecretAccessKey: null,
      exportRedactPatterns: null,
      exportIncludeStates: null,
      configuredTracker: null,
      codeRepository: null,
      triageLabels: null,
      archiveRetentionDays: null,
      archiveRetentionMaxTotalMB: null,
    });
  });
});
