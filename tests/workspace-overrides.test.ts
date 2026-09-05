import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { verificationCommandSchema, budgetGuardrailSchema } from '../src/config.js';
import { resolveVerifiers, resolveDrive } from '../src/domain/setting-override.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { makeSettingsStore } from './helpers.js';

describe('WorkspaceService override persistence (issue #64)', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let workspaces: WorkspaceService;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-ws-over-'));
    asyncDb = await openAsyncDb(dataDir);
    settingsStore = await makeSettingsStore(dataDir);
    workspaces = new WorkspaceService(asyncDb, settingsStore);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a fresh Workspace inherits every overridable setting (all null)', async () => {
    const ws = (await workspaces.list())[0]!;
    expect(ws.harness).toBeNull();
    expect(ws.model).toBeNull();
    expect(ws.chatHarness).toBeNull();
    expect(ws.chatModel).toBeNull();
    expect(ws.isolationMode).toBeNull();
    expect(ws.priority).toBeNull();
    expect(ws.maxConcurrentAttempts).toBeNull();
    expect(ws.autoRunnerEnabled).toBeNull();
    expect(ws.verificationCommand).toBeNull();
    expect(ws.reviewEnabled).toBeNull();
    expect(ws.reviewPrompt).toBeNull();
    expect(ws.reviewModel).toBeNull();
    expect(ws.reviewHarness).toBeNull();
    expect(ws.guardrailBudget).toBeNull();
    expect(ws.guardrailProgress).toBeNull();
    expect(ws.drivePrompt).toBeNull();
    expect(ws.driveUnattendedReminder).toBeNull();
    expect(ws.driveContinuePrompt).toBeNull();
    expect(ws.driveMergeFate).toBeNull();
    expect(ws.driveContinueAttempts).toBeNull();
    expect(ws.taskPrompt).toBeNull();
    expect(ws.toolTimeoutMinutes).toBeNull();
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

  it('sets explicit verifier overrides, command stored as JSON, review as plain scalars (issue #132, #337)', async () => {
    const ws = (await workspaces.list())[0]!;
    const updated = await workspaces.update(ws.id, {
      verificationCommand: [verificationCommandSchema.parse({ command: 'npm', args: ['test'] })],
      reviewEnabled: true,
      reviewPrompt: 'review',
      reviewModel: 'claude-opus-5',
    });
    expect(JSON.parse(updated.verificationCommand!)).toMatchObject([{ command: 'npm', args: ['test'] }]);
    expect(updated.reviewEnabled).toBe(true);
    expect(updated.reviewPrompt).toBe('review');
    expect(updated.reviewModel).toBe('claude-opus-5');
  });

  it('clears verifier overrides back to inherit with null (issue #132, #337)', async () => {
    const ws = (await workspaces.list())[0]!;
    await workspaces.update(ws.id, {
      verificationCommand: [verificationCommandSchema.parse({ command: 'npm', args: ['test'] })],
      reviewEnabled: true,
      reviewPrompt: 'review',
      reviewModel: 'claude-opus-5',
    });
    const cleared = await workspaces.update(ws.id, {
      verificationCommand: null,
      reviewEnabled: null,
      reviewPrompt: null,
      reviewModel: null,
    });
    expect(cleared.verificationCommand).toBeNull();
    expect(cleared.reviewEnabled).toBeNull();
    expect(cleared.reviewPrompt).toBeNull();
    expect(cleared.reviewModel).toBeNull();
  });

  it('patches reviewEnabled to false, round-trips it, and resolves the review/critic to off (issue #337)', async () => {
    const ws = (await workspaces.list())[0]!;
    const updated = await workspaces.update(ws.id, { reviewEnabled: false });
    expect(updated.reviewEnabled).toBe(false);
    const resolved = resolveVerifiers(updated, {
      verify: {
        commands: [],
        review: { enabled: true, prompt: 'global review', model: 'claude-opus-5' },
      },
    } as any);
    expect(resolved.review).toMatchObject({ enabled: false });
    expect(resolved.critic).toBeNull();
  });

  it('leaves an omitted verifier override untouched (issue #132)', async () => {
    const ws = (await workspaces.list())[0]!;
    await workspaces.update(ws.id, { verificationCommand: [verificationCommandSchema.parse({ command: 'npm', args: ['test'] })] });
    const renamed = await workspaces.update(ws.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(JSON.parse(renamed.verificationCommand!)).toMatchObject([{ command: 'npm', args: ['test'] }]);
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
      driveMergeFate: 'open-PR',
      driveContinueAttempts: 3,
      taskPrompt: 'WS task prompt',
      toolTimeoutMinutes: 45,
    });
    expect(set.drivePrompt).toBe('WS drive prompt');
    expect(set.driveUnattendedReminder).toBe('WS reminder');
    expect(set.driveContinuePrompt).toBe('WS continue');
    expect(set.driveMergeFate).toBe('open-PR');
    expect(set.driveContinueAttempts).toBe(3);
    expect(set.taskPrompt).toBe('WS task prompt');
    expect(set.toolTimeoutMinutes).toBe(45);

    const renamed = await workspaces.update(ws.id, { name: 'Renamed' });
    expect(renamed.driveMergeFate).toBe('open-PR');
    expect(renamed.toolTimeoutMinutes).toBe(45);

    const cleared = await workspaces.update(ws.id, { driveMergeFate: null, toolTimeoutMinutes: null });
    expect(cleared.driveMergeFate).toBeNull();
    expect(cleared.toolTimeoutMinutes).toBeNull();
    expect(cleared.drivePrompt).toBe('WS drive prompt');
    expect(cleared.driveContinueAttempts).toBe(3);
  });

  it('keeps a driveContinueAttempts 0 override distinct from inherit, and resolveDrive reads it (#339)', async () => {
    const ws = (await workspaces.list())[0]!;
    const zero = await workspaces.update(ws.id, { driveContinueAttempts: 0 });
    expect(zero.driveContinueAttempts).toBe(0);
    const resolved = resolveDrive(zero, {
      drive: {
        prompt: 'g',
        unattendedReminder: 'g',
        continuePrompt: 'g',
        mergeFate: 'auto-merge',
        continueAttempts: 1,
      },
    } as any);
    expect(resolved.continueAttempts).toBe(0);
    expect(resolved.mergeFate).toBe('auto-merge');
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
      harness: null,
      model: null,
      chatHarness: null,
      chatModel: null,
      isolationMode: null,
      priority: null,
      conflictResolveTurns: null,
      maxConcurrentAttempts: null,
      autoRunnerEnabled: null,
      maxAttempts: null,
      contextReuseTokenLimit: null,
      verificationCommand: null,
      reviewEnabled: null,
      reviewPrompt: null,
      reviewModel: null,
      reviewHarness: null,
      guardrailBudget: null,
      guardrailProgress: null,
      toolTimeoutMinutes: null,
      drivePrompt: null,
      driveUnattendedReminder: null,
      driveContinuePrompt: null,
      driveMergeFate: null,
      driveContinueAttempts: null,
      taskPrompt: null,
      pauseMessage: null,
    });
  });
});
