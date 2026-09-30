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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-retention-'));
    terminal = new Map();
    retention = { days: null, maxTotalMB: null };
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

  const run = () => pruneArchives({ dataDir, retention: () => retention, taskTerminalAt: async (id) => terminal.get(id) ?? null, now: () => NOW });
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

  it('yields between Archives', async () => {
    for (let i = 1; i <= 3; i++) seed(i, { ageDays: 60 });
    retention = { days: 30, maxTotalMB: null };
    let yields = 0;
    await pruneArchives({
      dataDir,
      retention: () => retention,
      taskTerminalAt: async (id) => terminal.get(id) ?? null,
      now: () => NOW,
      yieldOptions: { budgetMs: 0, yieldNow: async () => { yields += 1; } },
    });
    expect(yields).toBeGreaterThanOrEqual(3);
  });
});
