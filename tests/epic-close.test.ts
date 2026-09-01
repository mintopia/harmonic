/**
 * Close the Epic's tracker issue on completion (#442). The whole-Epic integrate
 * (both a real merge and a no-op/empty-diff finish) funnels through one
 * `recordIntegration` callback in the tracker manager, which — after settling the
 * stored Epic — calls {@link closeIntegratedEpic}. ADR-0004 keeps closure input-only
 * for Tasks; this is the deliberate Epic carve-out, since a container runs no agent.
 */
import { describe, it, expect, vi } from 'vitest';
import { closeIntegratedEpic, recordAndCloseIntegratedEpic } from '../src/tracker/epic-close.js';
import type { Ticket, TicketRef, TrackerAdapter } from '../src/tracker/adapter.js';

const ticket = (over: Partial<Ticket> & Pick<Ticket, 'number'>): Ticket => ({
  title: `epic ${over.number}`,
  state: 'open',
  body: '',
  createdAt: '2026-09-01T00:00:00Z',
  closedAt: null,
  labels: ['epic'],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: `https://x/${over.number}`,
  ...over,
});

/** A writable stub with recording spies for the two calls the close makes. */
const writable = (state: Ticket['state'] = 'open') => {
  const readTicket = vi.fn(async (r: TicketRef) => ticket({ number: r.number, state }));
  const close = vi.fn(async (_r: TicketRef, _comment: string) => {});
  const adapter = { name: 'stub', readTicket, close } as unknown as TrackerAdapter;
  return { adapter, readTicket, close };
};

describe('closeIntegratedEpic (#442)', () => {
  it('closes an open Epic issue via the writable adapter, with a comment', async () => {
    const { adapter, close } = writable('open');
    await closeIntegratedEpic(adapter, 42);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ number: 42, title: '', state: 'open' }, expect.any(String));
  });

  it('is idempotent: an already-closed issue is not re-closed', async () => {
    const { adapter, readTicket, close } = writable('closed');
    await closeIntegratedEpic(adapter, 42);
    expect(readTicket).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('is a best-effort no-op on an inbound-only tracker (no close capability)', async () => {
    const readTicket = vi.fn(async (r: TicketRef) => ticket({ number: r.number }));
    const adapter = { name: 'freeform', readTicket } as unknown as TrackerAdapter;
    await expect(closeIntegratedEpic(adapter, 42)).resolves.toBeUndefined();
    // No `close` means nothing to write, and no wasted read to decide that.
    expect(readTicket).not.toHaveBeenCalled();
  });
});

describe('recordAndCloseIntegratedEpic (#442) — the recordIntegration effect', () => {
  it('settles the stored record first, then closes the tracker issue', async () => {
    const order: string[] = [];
    const { adapter, close } = writable('open');
    const settle = vi.fn(async () => {
      order.push('settle');
    });
    close.mockImplementation(async () => {
      order.push('close');
    });
    await recordAndCloseIntegratedEpic({ epicRef: 42, settle, resolveAdapter: async () => adapter, onError: () => {} });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['settle', 'close']);
  });

  it('is best-effort: a close/resolve failure is reported but never undoes the settle', async () => {
    const settle = vi.fn(async () => {});
    const onError = vi.fn<(msg: string) => void>();
    await expect(
      recordAndCloseIntegratedEpic({
        epicRef: 42,
        settle,
        resolveAdapter: async () => {
          throw new Error('tracker unreachable');
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(settle).toHaveBeenCalledTimes(1); // the record stands
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('42'));
  });

  it('propagates a settle failure (an unrecorded integrate is a retryable miss, not a close)', async () => {
    const { adapter, close } = writable('open');
    const settle = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      recordAndCloseIntegratedEpic({ epicRef: 42, settle, resolveAdapter: async () => adapter, onError: () => {} }),
    ).rejects.toThrow('db down');
    expect(close).not.toHaveBeenCalled();
  });
});
