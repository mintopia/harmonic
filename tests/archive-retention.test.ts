import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneArchives, type ArchiveRetention } from '../src/archive/archive-retention.js';
import type { ExportRecord } from '../src/archive/task-archive.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-30T12:00:00Z');

describe('pruneArchives (#740)', () => {
  let dataDir: string;
  let terminal: Map<number, number | null>;
  let retention: ArchiveRetention;
  let pendingKeys: Set<string>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-retention-'));
    terminal = new Map();
    retention = { days: null, maxTotalMB: null };
    pendingKeys = new Set();
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  function seed(taskId: number, opts: { ageDays?: number | null; exports?: ExportRecord[]; deletedDaysAgo?: number; padBytes?: number } = {}): string {
    const dir = join(dataDir, 'archive', 'ws', `${taskId}-abc`);
    mkdirSync(join(dir, 'attempts'), { recursive: true });
    const manifest: Record<string, unknown> = { taskId, exports: opts.exports ?? [] };
    if (opts.deletedDaysAgo !== undefined) manifest.deleted = { at: new Date(NOW - opts.deletedDaysAgo * DAY).toISOString(), actor: 'operator' };
    writeFileSync(join(dir, 'archive.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'attempts', 'acp.jsonl'), Buffer.alloc(opts.padBytes ?? 10));
    if (opts.ageDays !== undefined) terminal.set(taskId, opts.ageDays === null ? null : NOW - opts.ageDays * DAY);
    return dir;
  }

  const run = () => pruneArchives({ dataDir, retention: () => retention, taskTerminalAt: async (id) => terminal.get(id) ?? null,
      pendingExports: async () => pendingKeys, now: () => NOW });
  const record = (status: ExportRecord['status'], destination: ExportRecord['destination'] = 'directory'): ExportRecord => ({
    destination,
    disposition: 'done',
    file: null,
    status,
    at: new Date(NOW - 40 * DAY).toISOString(),
  });

  it('prunes nothing without config', async () => {
    const old = seed(1, { ageDays: 400 });
    expect(await run()).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  it('removes terminal Archives older than days and keeps newer ones', async () => {
    const old = seed(1, { ageDays: 31 });
    const fresh = seed(2, { ageDays: 5 });
    retention = { days: 30, maxTotalMB: null };
    expect(await run()).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('prunes oldest first until under maxTotalMB', async () => {
    const mb = 1024 * 1024;
    const oldest = seed(1, { ageDays: 50, padBytes: mb });
    const middle = seed(2, { ageDays: 40, padBytes: mb });
    const newest = seed(3, { ageDays: 35, padBytes: mb });
    retention = { days: null, maxTotalMB: 1.5 };
    expect(await run()).toBe(2);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it('keeps an Archive whose Export Destination is failed, even past the cap', async () => {
    const failed = seed(1, { ageDays: 90, exports: [record('failed')] });
    const retried = seed(2, { ageDays: 90, exports: [record('failed'), record('succeeded')] });
    retention = { days: 30, maxTotalMB: 0.000001 };
    await run();
    expect(existsSync(failed)).toBe(true);
    expect(existsSync(retried)).toBe(false);
  });

  it('never prunes a non-terminal Task Archive', async () => {
    const active = seed(1, { ageDays: null });
    retention = { days: 1, maxTotalMB: 0.000001 };
    await run();
    expect(existsSync(active)).toBe(true);
  });

  it('keeps an Archive whose Export has a retry pending even when its history shows only success', async () => {
    const waiting = seed(1, { ageDays: 90, exports: [record('succeeded')] });
    const done = seed(2, { ageDays: 90, exports: [record('succeeded')] });
    pendingKeys = new Set(['task:1']);
    retention = { days: 30, maxTotalMB: null };
    await run();
    expect(existsSync(waiting)).toBe(true);
    expect(existsSync(done)).toBe(false);
  });

  it('keeps a Deleted Task Archive while its Export is pending or failed', async () => {
    const pending = seed(1, { deletedDaysAgo: 45 });
    const failed = seed(2, { deletedDaysAgo: 45, exports: [record('failed')] });
    const clear = seed(3, { deletedDaysAgo: 45, exports: [record('succeeded')] });
    pendingKeys = new Set(['task:1']);
    retention = { days: 30, maxTotalMB: null };
    await run();
    expect([pending, failed, clear].map((d) => existsSync(d))).toEqual([true, true, false]);
  });

  describe('Epic Archives', () => {
    const seedEpic = (ref: number, opts: { integratedDaysAgo?: number; exports?: ExportRecord[] }): string => {
      const dir = join(dataDir, 'archive', 'ws', `epic-${ref}`);
      mkdirSync(dir, { recursive: true });
      const dispositions = opts.integratedDaysAgo === undefined ? [] : [{ disposition: 'done', at: new Date(NOW - opts.integratedDaysAgo * DAY).toISOString() }];
      writeFileSync(join(dir, 'archive.json'), JSON.stringify({ epicRef: ref, workspaceId: 7, dispositions, exports: opts.exports ?? [] }));
      return dir;
    };

    it('prunes an integrated Epic Archive past the cap even when no Export ever ran', async () => {
      const old = seedEpic(1, { integratedDaysAgo: 45 });
      const fresh = seedEpic(2, { integratedDaysAgo: 5 });
      retention = { days: 30, maxTotalMB: null };
      await run();
      expect([old, fresh].map((d) => existsSync(d))).toEqual([false, true]);
    });

    it('keeps a non-integrated Epic Archive, a failed one, and one with a pending retry', async () => {
      const open = seedEpic(1, {});
      const failed = seedEpic(2, { integratedDaysAgo: 90, exports: [record('failed')] });
      const waiting = seedEpic(3, { integratedDaysAgo: 90 });
      pendingKeys = new Set(['epic:7:3']);
      retention = { days: 30, maxTotalMB: null };
      await run();
      expect([open, failed, waiting].map((d) => existsSync(d))).toEqual([true, true, true]);
    });
  });

  it('prunes the Archive of a Deleted Task from archive.json alone', async () => {
    const gone = seed(1, { deletedDaysAgo: 45 });
    retention = { days: 30, maxTotalMB: null };
    await run();
    expect(existsSync(gone)).toBe(false);
  });

  it('leaves .staging alone', async () => {
    const staged = join(dataDir, 'archive', '.staging');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'x.tar.gz'), 'x');
    retention = { days: 1, maxTotalMB: 0.000001 };
    await run();
    expect(existsSync(join(staged, 'x.tar.gz'))).toBe(true);
  });

  it('a Workspace override prunes that Workspace on its own caps while others keep the global caps', async () => {
    const seedIn = (slug: string, taskId: number, ageDays: number) => {
      const dir = join(dataDir, 'archive', slug, `${taskId}-abc`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'archive.json'), JSON.stringify({ taskId, exports: [] }));
      terminal.set(taskId, NOW - ageDays * DAY);
      return dir;
    };
    const strictOld = seedIn('strict', 1, 20);
    const strictFresh = seedIn('strict', 2, 5);
    const lenientOld = seedIn('lenient', 3, 20);
    const lenientAncient = seedIn('lenient', 4, 400);
    retention = { days: 365, maxTotalMB: null };
    const removed = await pruneArchives({
      dataDir,
      retention: () => retention,
      workspaceRetention: (slug) => (slug === 'strict' ? { days: 10, maxTotalMB: null } : null),
      taskTerminalAt: async (id) => terminal.get(id) ?? null,
      pendingExports: async () => pendingKeys,
      now: () => NOW,
    });
    expect(removed).toBe(2);
    expect(existsSync(strictOld)).toBe(false);
    expect(existsSync(strictFresh)).toBe(true);
    expect(existsSync(lenientOld)).toBe(true);
    expect(existsSync(lenientAncient)).toBe(false);
  });

  it('a Workspace override prunes even when the global caps are off', async () => {
    const dir = join(dataDir, 'archive', 'strict', '1-abc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'archive.json'), JSON.stringify({ taskId: 1, exports: [] }));
    terminal.set(1, NOW - 20 * DAY);
    const removed = await pruneArchives({
      dataDir,
      retention: () => retention,
      workspaceRetention: () => ({ days: 10, maxTotalMB: null }),
      taskTerminalAt: async (id) => terminal.get(id) ?? null,
      pendingExports: async () => pendingKeys,
      now: () => NOW,
    });
    expect(removed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('yields between Archives', async () => {
    for (let i = 1; i <= 3; i++) seed(i, { ageDays: 60 });
    retention = { days: 30, maxTotalMB: null };
    let yields = 0;
    await pruneArchives({
      dataDir,
      retention: () => retention,
      taskTerminalAt: async (id) => terminal.get(id) ?? null,
      pendingExports: async () => pendingKeys,
      now: () => NOW,
      yieldOptions: { budgetMs: 0, yieldNow: async () => { yields += 1; } },
    });
    expect(yields).toBeGreaterThanOrEqual(3);
  });
});
