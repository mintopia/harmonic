import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationDriver,
  type HarnessSpawn,
  type HarnessSpawnRequest,
  type WorkingDirProbe,
  type ConversationTimers,
} from '../src/execution/conversation-driver.js';
import { DomainError } from '../src/domain/errors.js';
import type { ConversationStore } from '../src/domain/conversations.js';
import type { ConversationRow } from '../src/db/schema.js';
import type { AppConfig, HarnessConfig } from '../src/config.js';

class FakeHarnessChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return true;
  });
}

let nextConversationId = 1;

function conversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  const now = Date.now();
  return {
    id: nextConversationId++,
    title: null,
    harness: 'claude',
    model: 'model-a',
    workingDir: '/work/dir',
    workspaceId: 1,
    state: 'active',
    permissionMode: 'ask',
    sessionId: null,
    usage: null,
    contextTokens: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    ...overrides,
  };
}

function fakeStore(row: ConversationRow): ConversationStore {
  return {
    get: vi.fn(async () => row),
    update: vi.fn(async (_id: number, patch: Partial<ConversationRow>) => ({ ...row, ...patch })),
  } as unknown as ConversationStore;
}

function harnessConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    command: 'fake-harness',
    args: ['--acp'],
    env: {},
    models: [{ id: 'model-a' }],
    defaultModel: 'model-a',
    cacheWarmSeconds: 300,
    ...overrides,
  };
}

function fakeConfig(harnesses: Record<string, HarnessConfig> = {}): () => AppConfig {
  return () => ({ harnesses, conversationIdleTimeoutMinutes: 0 }) as unknown as AppConfig;
}

function fakeSeams(overrides: { fs?: Partial<WorkingDirProbe>; processSpawn?: Partial<HarnessSpawn> } = {}) {
  const fs: WorkingDirProbe = { exists: vi.fn(() => true), ...overrides.fs };
  const processSpawn: HarnessSpawn = { spawn: vi.fn(), ...overrides.processSpawn };
  const timers: ConversationTimers = { setTimeout: vi.fn(), clearTimeout: vi.fn() };
  return { fs, processSpawn, timers };
}

describe('ConversationDriver — spawning a harness through the injected seams', () => {
  it('rejects with a validation error when the working directory does not exist, and never spawns a harness', async () => {
    const row = conversationRow({ workingDir: '/nope/does-not-exist' });
    const { fs, processSpawn, timers } = fakeSeams({ fs: { exists: vi.fn(() => false) } });
    const driver = new ConversationDriver(fakeStore(row), fakeConfig({ claude: harnessConfig() }), {
      fs,
      processSpawn,
      timers,
    });

    let caught: unknown;
    try {
      await driver.open(row.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('validation');
    expect(fs.exists).toHaveBeenCalledWith(row.workingDir);
    expect(processSpawn.spawn).not.toHaveBeenCalled();
  });

  it('rejects with a validation error when the conversation harness is not configured, and never spawns a harness', async () => {
    const row = conversationRow({ harness: 'claude' });
    const { fs, processSpawn, timers } = fakeSeams();
    const driver = new ConversationDriver(fakeStore(row), fakeConfig({}), { fs, processSpawn, timers });

    let caught: unknown;
    try {
      await driver.open(row.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('validation');
    expect(processSpawn.spawn).not.toHaveBeenCalled();
  });

  it('spawns the configured harness through the injected seam and cleans it up when the ACP handshake never completes', async () => {
    const row = conversationRow({ harness: 'claude', workingDir: '/work/dir' });
    const child = new FakeHarnessChild();
    const spawn = vi.fn((_req: HarnessSpawnRequest) => {
      child.stdout.end();
      return child as unknown as ChildProcess;
    });
    const { fs, processSpawn, timers } = fakeSeams({ processSpawn: { spawn } });
    const configuredHarness = harnessConfig({ command: 'fake-harness', args: ['--acp', '--stdio'] });
    const driver = new ConversationDriver(fakeStore(row), fakeConfig({ claude: configuredHarness }), {
      fs,
      processSpawn,
      timers,
    });

    await expect(driver.open(row.id)).rejects.toThrow();

    expect(processSpawn.spawn).toHaveBeenCalledTimes(1);
    const request = spawn.mock.calls[0]![0];
    expect(request.command).toBe('fake-harness');
    expect(request.args).toEqual(['--acp', '--stdio']);
    expect(request.cwd).toBe(row.workingDir);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
