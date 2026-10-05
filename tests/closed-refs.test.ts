import { describe, expect, it, vi } from 'vitest';
import { trackerRef, type Ticket, type TrackerAdapter } from '../src/tracker/adapter.js';
import { ClosedRefResolver } from '../src/tracker/closed-refs.js';
import { logger } from '../src/logger.js';

const ticket = (n: number, over: Partial<Ticket> = {}): Ticket => ({
  ref: trackerRef(n), title: `t${n}`, state: 'open', body: '', createdAt: '2026-08-07T00:00:00Z', closedAt: null, labels: [],
  assignees: [], parent: null, blockedBy: [], blocking: [], isMap: false, url: `https://x/${n}`, ...over,
});

function adapterWith(read: (ref: string) => Promise<Ticket>) {
  const reads: string[] = [];
  const adapter = {
    name: 'stub', scansOpenOnly: true, scan: async () => [],
    readTicket: async (r: { ref: string }) => { reads.push(r.ref); return read(r.ref); },
  } as unknown as TrackerAdapter;
  return { adapter, reads };
}

describe('ClosedRefResolver failed lookups', () => {
  it('does not re-read a failing ref until the retry window passes, and warns once', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let clock = 1_000;
    let healthy = false;
    const { adapter, reads } = adapterWith(async (ref) => {
      if (!healthy) throw new Error('gh failed: HTTP 502');
      return ticket(Number(ref), { state: 'closed' });
    });
    const resolver = new ClosedRefResolver({ failureRetryMs: 60_000, now: () => clock });
    const active = [trackerRef(5)];

    expect(await resolver.complete(adapter, [], active)).toEqual([]);
    expect(await resolver.complete(adapter, [], active)).toEqual([]);
    expect(reads).toEqual(['5']);

    clock += 61_000;
    await resolver.complete(adapter, [], active);
    expect(reads).toEqual(['5', '5']);
    expect(warn).toHaveBeenCalledTimes(1);

    healthy = true;
    clock += 61_000;
    const out = await resolver.complete(adapter, [], active);
    expect(out.map((t) => t.ref)).toEqual(['5']);
    expect(warn).toHaveBeenCalledTimes(1);

    healthy = false;
    const again = adapterWith(async () => { throw new Error('boom'); });
    const fresh = new ClosedRefResolver({ failureRetryMs: 60_000, now: () => clock });
    await fresh.complete(again.adapter, [], active);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('warns again after a recovery followed by a new failure, and forgets refs no longer wanted', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let clock = 0;
    let mode: 'fail' | 'ok' = 'fail';
    const { adapter, reads } = adapterWith(async (ref) => {
      if (mode === 'fail') throw new Error('nope');
      return ticket(Number(ref), { state: 'open' });
    });
    const resolver = new ClosedRefResolver({ failureRetryMs: 10, now: () => clock });
    await resolver.complete(adapter, [], [trackerRef(9)]);
    mode = 'ok';
    clock += 20;
    await resolver.complete(adapter, [], [trackerRef(9)]);
    mode = 'fail';
    clock += 20;
    await resolver.complete(adapter, [], [trackerRef(9)]);
    expect(warn).toHaveBeenCalledTimes(2);

    await resolver.complete(adapter, [], []);
    clock += 1;
    await resolver.complete(adapter, [], [trackerRef(9)]);
    expect(reads.length).toBe(4);
    warn.mockRestore();
  });

  it('yields between items while completing a large scan', async () => {
    const yieldNow = vi.fn(async () => {});
    let t = 0;
    const scanned = Array.from({ length: 50 }, (_, i) => ticket(i + 1));
    const { adapter } = adapterWith(async () => { throw new Error('unused'); });
    const resolver = new ClosedRefResolver({ yieldOptions: { budgetMs: 1, now: () => t++, yieldNow } });
    await resolver.complete(adapter, scanned, []);
    expect(yieldNow).toHaveBeenCalled();
  });
});
