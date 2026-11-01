import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryLedger } from '../src/archive/delivery-ledger.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function ledger(): Promise<{ ledger: DeliveryLedger; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  dirs.push(dir);
  return { ledger: DeliveryLedger.under(dir), dir };
}

const ok = (at: string) => ({ status: 'succeeded' as const, at, error: null, retry: 0, nextRetryAt: null });

describe('DeliveryLedger', () => {
  it('reads empty before any delivery', async () => {
    expect(await (await ledger()).ledger.read()).toEqual({});
  });

  it('keeps the latest outcome per Destination on disk', async () => {
    const { ledger: l, dir } = await ledger();
    await l.note('directory', ok('2026-09-30T12:00:00.000Z'));
    await l.note('s3', { status: 'failed', at: '2026-09-30T12:01:00.000Z', error: 'AccessDenied: 403', retry: 2, nextRetryAt: '2026-09-30T12:30:00.000Z' });
    await l.note('directory', ok('2026-09-30T12:05:00.000Z'));
    const onDisk = JSON.parse(await readFile(join(dir, 'archive', 'delivery-state.json'), 'utf8'));
    expect(onDisk.directory.at).toBe('2026-09-30T12:05:00.000Z');
    expect(onDisk.s3).toMatchObject({ status: 'failed', retry: 2, error: 'AccessDenied: 403' });
  });

  it('ignores an older outcome that lands after a newer one', async () => {
    const { ledger: l } = await ledger();
    await l.note('directory', ok('2026-09-30T12:05:00.000Z'));
    await l.note('directory', { status: 'failed', at: '2026-09-30T12:00:00.000Z', error: 'x', retry: 0, nextRetryAt: null });
    expect((await l.read()).directory?.status).toBe('succeeded');
  });

  it('treats a corrupt file as empty', async () => {
    const { ledger: l, dir } = await ledger();
    await l.note('s3', ok('2026-09-30T12:00:00.000Z'));
    await (await import('node:fs/promises')).writeFile(join(dir, 'archive', 'delivery-state.json'), '{nope');
    expect(await l.read()).toEqual({});
  });
});
