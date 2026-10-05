import { describe, expect, it, vi } from 'vitest';
import { ticketCloseEffect } from '../src/domain/merge.js';
import { logger } from '../src/logger.js';

describe('ticketCloseEffect (ADR-0048)', () => {
  it('resolves ok and flags pending when the close fails', async () => {
    const markPending = vi.fn(async () => {});
    const out = await ticketCloseEffect('12', async () => false, markPending).apply();
    expect(out.ok).toBe(true);
    expect(markPending).toHaveBeenCalledOnce();
  });

  it('does not flag pending when the close succeeds', async () => {
    const markPending = vi.fn(async () => {});
    expect((await ticketCloseEffect('12', async () => true, markPending).apply()).ok).toBe(true);
    expect(markPending).not.toHaveBeenCalled();
  });

  it('still resolves ok, and logs, when flagging pending throws, so merged work is not re-stranded', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const out = await ticketCloseEffect('12', async () => false, async () => { throw new Error('database is locked'); }).apply();
    expect(out).toEqual({ ok: true, observed: { trackerRef: '12' } });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('close-pending'), expect.objectContaining({ trackerRef: '12', error: 'database is locked' }));
    error.mockRestore();
  });
});
