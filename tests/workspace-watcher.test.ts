import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failure = vi.hoisted(() => ({ after: Number.POSITIVE_INFINITY, calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      if (failure.calls++ >= failure.after) throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      return actual.watch(...args);
    }) as typeof actual.watch,
  };
});

import { WorkspaceWatcher } from '../src/domain/workspace-watcher.js';
import { logger } from '../src/logger.js';
import type { WorkspaceRow } from '../src/db/schema.js';

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('WorkspaceWatcher directory-only watches (issue #880)', () => {
  let root: string;
  let watcher: WorkspaceWatcher;
  let current: WorkspaceRow;
  const GRACE = 80;
  const subscribe = async () => { const release = watcher.subscribe(7); await watcher.settled(); return release; };
  let fsChanged: number;
  const workspace = (excludedDirectories: string[] = ['ignored']) => ({ id: 7, workingDir: root, excludedDirectories }) as unknown as WorkspaceRow;

  beforeEach(() => {
    failure.after = Number.POSITIVE_INFINITY;
    failure.calls = 0;
    fsChanged = 0;
    root = mkdtempSync(join(tmpdir(), 'harmonic-dirwatch-'));
    current = workspace();
    watcher = new WorkspaceWatcher(() => 30, { fsChanged: () => { fsChanged++; }, gitStatus: () => {} }, async () => current, GRACE);
  });

  afterEach(async () => {
    await watcher.stopAll();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates no watchers when syncing without subscribers', async () => {
    await watcher.sync([workspace()]);
    await watcher.settled();
    expect(watcher.watchCount(7)).toBe(0);
  });

  it('stops after the grace period once unsubscribed, and a re-subscribe keeps it', async () => {
    const first = await subscribe();
    expect(watcher.watchCount(7)).toBe(1);
    first();
    await new Promise((r) => setTimeout(r, GRACE / 2));
    const second = await subscribe();
    await new Promise((r) => setTimeout(r, GRACE * 2));
    expect(watcher.watchCount(7)).toBe(1);
    second();
    await until(() => watcher.watchCount(7) === 0);
  });

  it('restarts only subscribed watchers when Workspace settings change', async () => {
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'ignored'));
    current = workspace(['a']);
    await watcher.sync([current]);
    expect(watcher.watchCount(7)).toBe(0);
    await subscribe();
    expect(watcher.watchCount(7)).toBe(2);
    await watcher.sync([workspace(['a', 'ignored'])]);
    expect(watcher.watchCount(7)).toBe(1);
    await watcher.sync([]);
    expect(watcher.watchCount(7)).toBe(0);
  });

  it('scales watches with directories, not files', async () => {
    for (let d = 0; d < 5; d++) {
      mkdirSync(join(root, `d${d}`));
      for (let f = 0; f < 40; f++) writeFileSync(join(root, `d${d}`, `f${f}.txt`), 'x');
    }
    mkdirSync(join(root, 'ignored'));
    writeFileSync(join(root, 'top.txt'), 'x');
    await subscribe();
    expect(watcher.watchCount(7)).toBe(6);
  });

  it('watches newly created directories and files inside them', async () => {
    await subscribe();
    expect(watcher.watchCount(7)).toBe(1);
    mkdirSync(join(root, 'sub'));
    await until(() => fsChanged >= 1 && watcher.watchCount(7) === 2);
    const before = fsChanged;
    writeFileSync(join(root, 'sub', 'new.txt'), 'x');
    await until(() => fsChanged > before);
  });

  it('releases the watch of a removed directory and its descendants', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    await subscribe();
    expect(watcher.watchCount(7)).toBe(3);
    rmSync(join(root, 'a'), { recursive: true });
    await until(() => watcher.watchCount(7) === 1);
  });

  it('logs one warning and stops adding watches on ENOSPC', async () => {
    for (let d = 0; d < 6; d++) mkdirSync(join(root, `d${d}`));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    failure.after = 4;
    await subscribe();
    expect(watcher.watchCount(7)).toBe(3);
    expect(watcher.isDegraded(7)).toBe(true);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('degraded'))).toHaveLength(1);
    mkdirSync(join(root, 'late'));
    await until(() => fsChanged >= 1);
    expect(watcher.watchCount(7)).toBe(3);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('degraded'))).toHaveLength(1);
  });
});
