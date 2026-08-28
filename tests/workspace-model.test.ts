import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WORKSPACE_KEY,
  hasNoWorkspaces,
  loadActiveWorkspaceId,
  resolveActiveWorkspace,
  storeActiveWorkspaceId,
} from '../web/src/workspace-model.js';
import type { Workspace } from '../web/src/types.js';

/** Minimal Storage stand-in — node tests have no localStorage. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

const ws = (id: number, name = `ws-${id}`): Workspace => ({
  id,
  name,
  workingDir: `/repo/${name}`,
  trackerEnabled: false,
  trackerPollIntervalSeconds: 60,
  maxAttempts: null,
  contextReuseTokenLimit: null,
  resolvedTracker: null,
  harness: null,
  model: null,
  chatHarness: null,
  chatModel: null,
  isolationMode: null,
  priority: null,
  integrationRetries: null,
  conflictResolveTurns: null,
  maxConcurrentRuns: null,
  autoRunnerEnabled: null,
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
  createdAt: id,
  updatedAt: id,
});

describe('active Workspace persistence', () => {
  it('defaults to null when nothing is stored', () => {
    expect(loadActiveWorkspaceId(memoryStorage())).toBeNull();
  });

  it('round-trips the active id', () => {
    const storage = memoryStorage();
    storeActiveWorkspaceId(storage, 42);
    expect(loadActiveWorkspaceId(storage)).toBe(42);
  });

  it('treats a garbage stored value as unset', () => {
    expect(loadActiveWorkspaceId(memoryStorage({ [ACTIVE_WORKSPACE_KEY]: 'garbage' }))).toBeNull();
  });

  it('survives a storage that throws (private browsing)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadActiveWorkspaceId(throwing)).toBeNull();
    expect(() => storeActiveWorkspaceId(throwing, 1)).not.toThrow();
  });
});

describe('resolveActiveWorkspace', () => {
  it('returns null while the Workspace list has not loaded yet', () => {
    expect(resolveActiveWorkspace([], 5)).toBeNull();
  });

  it('picks the persisted id when it still names a real Workspace', () => {
    const workspaces = [ws(1), ws(2), ws(3)];
    expect(resolveActiveWorkspace(workspaces, 2)?.id).toBe(2);
  });

  it('falls back to the first (default) Workspace when nothing is persisted', () => {
    const workspaces = [ws(1), ws(2)];
    expect(resolveActiveWorkspace(workspaces, null)?.id).toBe(1);
  });

  it('falls back to the first Workspace when the persisted id no longer exists (e.g. deleted)', () => {
    const workspaces = [ws(1), ws(2)];
    expect(resolveActiveWorkspace(workspaces, 999)?.id).toBe(1);
  });
});

describe('hasNoWorkspaces', () => {
  it('stays false before the list has loaded, so the empty state never flashes on boot', () => {
    expect(hasNoWorkspaces([], false)).toBe(false);
  });

  it('is true once the load has come back empty (genuine first launch or last-Workspace delete)', () => {
    expect(hasNoWorkspaces([], true)).toBe(true);
  });

  it('is false when a Workspace exists, loaded or not', () => {
    expect(hasNoWorkspaces([ws(1)], true)).toBe(false);
    expect(hasNoWorkspaces([ws(1)], false)).toBe(false);
  });
});
